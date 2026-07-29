import { Injectable, Logger } from '@nestjs/common';
import { UpstoxService } from './upstox.service';
import { AuthService } from '../auth/auth.service';

export type LiveQuote = { price: number; change: number; changePercent: number; volume: number };
export type QuoteBatchResult = {
  prices: Map<string, LiveQuote>;
  requested: number;
  received: number;
  failed: number;
  validKeys: number;
  invalidKeys: string[];
  failedKeys: string[];
  totalBatches: number;
  failedBatches: number;
};

const BATCH_SIZE = 200;
const CONCURRENCY = 5;
const RETRY_DELAYS = [500, 1_000, 2_000];
const INSTRUMENT_KEY = /^[A-Z][A-Z0-9_]*\|[^|\s]+$/;

@Injectable()
export class QuoteBatchService {
  private readonly logger = new Logger(QuoteBatchService.name);

  constructor(private readonly upstox: UpstoxService, private readonly auth: AuthService) {}

  async fetchAll(userId: string, inputKeys: unknown[]): Promise<QuoteBatchResult> {
    // Fail fast with an authentication response (never a scanner 503) before
    // scheduling provider work. AuthService verifies both presence and expiry.
    await this.auth.accessToken(userId);
    this.logger.log('Access Token: present and not expired');
    const { valid, invalid } = this.validate(inputKeys);
    const batches = this.chunks(valid, BATCH_SIZE);
    const prices = new Map<string, LiveQuote>();
    const failedKeys = new Set<string>();
    let failedBatches = 0;

    this.logger.log(`Valid Keys: ${valid.length}`);
    this.logger.log(`Invalid Keys: ${invalid.length}`);
    if (invalid.length) this.logger.warn(`Invalid instrument keys: ${JSON.stringify(invalid)}`);

    await this.pool(batches, CONCURRENCY, async (batch, index) => {
      const batchNumber = index + 1;
      this.logger.log(`Batch Number: ${batchNumber}/${batches.length} | Batch Size: ${batch.length}`);
      let completed = false;
      const maxAttempts = RETRY_DELAYS.length + 1;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        try {
          const response: any = await this.upstox.ltp(userId, batch.join(','), 10_000);
          const parsed = this.parse(response, batch);
          for (const [key, quote] of parsed) prices.set(key, quote);
          for (const key of batch) if (!parsed.has(key)) failedKeys.add(key);
          this.logger.log(`Batch Success: ${batchNumber}/${batches.length} | Attempt: ${attempt + 1} | Quotes Received: ${parsed.size} | Quotes Missing: ${batch.length - parsed.size}`);
          completed = true;
          break;
        } catch (error) {
          const delay = RETRY_DELAYS[attempt];
          this.logger.warn(`Batch Failed: ${batchNumber}/${batches.length} | Attempt: ${attempt + 1}/${maxAttempts} | Batch Size: ${batch.length} | Error: ${this.error(error)}${attempt < RETRY_DELAYS.length ? ` | Retry Delay: ${delay}ms` : ''}`);
          if (attempt < RETRY_DELAYS.length) await this.sleep(delay);
        }
      }
      if (!completed) {
        failedBatches += 1;
        batch.forEach((key) => failedKeys.add(key));
        this.logger.error(`Batch Failed permanently: ${batchNumber}/${batches.length} | Skipping ${batch.length} keys and continuing`);
      }
    });

    // A key recovered by a later provider entry is not missing.
    for (const key of prices.keys()) failedKeys.delete(key);
    this.logger.log(`Quotes Received: ${prices.size}`);
    this.logger.log(`Quotes Missing: ${failedKeys.size}`);
    return {
      prices,
      requested: inputKeys.length,
      received: prices.size,
      failed: invalid.length + failedKeys.size,
      validKeys: valid.length,
      invalidKeys: invalid,
      failedKeys: [...failedKeys],
      totalBatches: batches.length,
      failedBatches,
    };
  }

  validate(inputKeys: unknown[]) {
    const valid: string[] = [];
    const invalid: string[] = [];
    const seen = new Set<string>();
    for (const raw of inputKeys) {
      const key = typeof raw === 'string' ? raw.trim() : '';
      if (!key || !INSTRUMENT_KEY.test(key) || seen.has(key)) {
        invalid.push(raw === null ? 'null' : raw === undefined ? 'undefined' : String(raw));
        continue;
      }
      seen.add(key);
      valid.push(key);
    }
    return { valid, invalid };
  }

  private parse(response: any, requested: string[]) {
    const result = new Map<string, LiveQuote>();
    const requestedSet = new Set(requested);
    const data = response?.data ?? response ?? {};
    if (!data || typeof data !== 'object') return result;
    for (const [responseKey, value] of Object.entries<any>(data)) {
      const candidates = [
        value?.instrument_token,
        responseKey,
        responseKey.replace(':', '|'),
      ].filter((item): item is string => typeof item === 'string');
      const key = candidates.find((item) => requestedSet.has(item));
      const price = Number(value?.last_price ?? value?.ltp ?? value?.lastPrice);
      if (!key || !Number.isFinite(price)) continue;
      const close = Number(value?.cp ?? value?.ohlc?.close ?? price);
      result.set(key, {
        price,
        change: Number.isFinite(close) ? price - close : 0,
        changePercent: Number.isFinite(close) && close !== 0 ? (price - close) / close * 100 : 0,
        volume: Number(value?.volume ?? value?.oi ?? 0) || 0,
      });
    }
    return result;
  }

  private chunks<T>(items: T[], size: number) {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
  }

  private async pool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        await worker(items[index], index);
      }
    }));
  }

  private sleep(delay: number) { return new Promise<void>((resolve) => setTimeout(resolve, delay)); }
  private error(error: unknown) {
    if (error && typeof error === 'object' && 'getResponse' in error && typeof (error as any).getResponse === 'function') return JSON.stringify((error as any).getResponse());
    return error instanceof Error ? error.message : String(error);
  }
}
