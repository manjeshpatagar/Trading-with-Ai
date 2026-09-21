export class UpstoxRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) { super('Upstox request deferred until the rate limit resets'); }
}

export function retryAfterMs(value: unknown, now = Date.now()): number | null {
  if (value === undefined || value === null || value === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.ceil(seconds * 1_000) : null;
  const date = Date.parse(String(value));
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

// Leave capacity for requests made outside this process. Limits are per API
// and user; dynamic instrument/date path components share the same budget.
const WINDOWS = [{ ms: 1_000, count: 40 }, { ms: 60_000, count: 450 }, { ms: 1_800_000, count: 1_800 }];
type Budget = { starts: number[]; nextAt: number; cooldownUntil: number };
export class UpstoxRequestGate {
  private readonly budgets = new Map<string, Budget>();
  constructor(private readonly now = Date.now, private readonly sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}

  private budget(userId: string, path: string) {
    const api = path.startsWith('/v3/historical-candle/intraday/') ? '/v3/historical-candle/intraday'
      : path.startsWith('/v3/historical-candle/') ? '/v3/historical-candle' : path;
    const key = `${userId}:${api}`;
    let budget = this.budgets.get(key);
    if (!budget) { budget = { starts: [], nextAt: 0, cooldownUntil: 0 }; this.budgets.set(key, budget); }
    return budget;
  }

  defer(userId: string, path: string, ms: number) {
    const budget = this.budget(userId, path);
    budget.cooldownUntil = Math.max(budget.cooldownUntil, this.now() + ms);
  }

  async acquire(userId: string, path: string) {
    const budget = this.budget(userId, path);
    const deadline = this.now() + 15_000;
    for (;;) {
      const now = this.now();
      budget.starts = budget.starts.filter(at => at > now - WINDOWS.at(-1)!.ms);
      let allowedAt = Math.max(budget.nextAt, budget.cooldownUntil);
      for (const window of WINDOWS) {
        const starts = budget.starts.filter(at => at > now - window.ms);
        if (starts.length >= window.count) allowedAt = Math.max(allowedAt, starts[starts.length - window.count] + window.ms);
      }
      const wait = allowedAt - now;
      if (wait <= 0) {
        // Reserve synchronously before yielding, so concurrent callers cannot
        // all pass the same quota check.
        budget.starts.push(now);
        budget.nextAt = now + 25;
        return;
      }
      if (allowedAt > deadline) throw new UpstoxRateLimitError(wait);
      await this.sleep(wait);
    }
  }
}
