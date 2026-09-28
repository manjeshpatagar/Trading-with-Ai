/** Lifecycle/exit reads must not be postponed by frequent live-price cache writes. */
export function startHistoryPolling(refresh: () => Promise<unknown>, intervalMs = 5_000) {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void Promise.resolve().then(refresh).catch(() => undefined).finally(() => { running = false; });
  }, intervalMs);
  return () => clearInterval(timer);
}
