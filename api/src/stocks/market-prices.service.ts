import { Injectable } from '@nestjs/common';
import { LivePrice, markPosition, markPrice, newerPrice } from './live-price';

@Injectable()
export class MarketPricesService {
  private readonly quotes = new Map<string, LivePrice>();
  private sequence = Date.now() * 1000;
  get(userId: string, key: string) { return this.quotes.get(`${userId}:${key}`); }
  accept(userId: string, key: string, ltp: number, timestamp: number, receivedAt = Date.now(), pollRevision?: number) {
    const previous = this.get(userId, key);
    // A quote request started before a newer feed update cannot roll it back.
    if (pollRevision !== undefined && (previous?.sequence ?? 0) !== pollRevision) return null;
    const quote = { instrumentKey: key, ltp, timestamp, receivedAt, sequence: ++this.sequence };
    if (!newerPrice(quote, previous)) return null;
    // The feed has no exchange sequence: conflicting prices with identical
    // exchange timestamps are ambiguous, so retain the first accepted price.
    if (previous?.timestamp === timestamp && previous.ltp !== ltp) return null;
    this.quotes.set(`${userId}:${key}`, quote);
    return quote;
  }
  fresh(userId: string, key: string, at = Date.now()) {
    const quote = this.get(userId, key);
    return quote && at - quote.receivedAt <= 15_000 && quote.receivedAt <= at + 5_000 ? quote : undefined;
  }
  mark<T extends Parameters<typeof markPrice>[0]>(userId: string, row: T) { return markPrice(row, this.get(userId, row.instrumentKey)); }
  position<T extends Parameters<typeof markPosition>[0]>(userId: string, row: T) { return markPosition(row, this.get(userId, row.instrumentKey)); }
}
