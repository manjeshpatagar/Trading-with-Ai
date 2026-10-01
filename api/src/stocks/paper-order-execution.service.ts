import { Injectable } from '@nestjs/common';
import { CloseRequest, FillRequest, OrderExecution } from './order-execution';

/** Adverse market execution when bid/ask depth is unavailable; assumptions are explicit. */
export function simulatedMarketPrice(price: number, side: string, slippageBps = 0, spreadBps = 0) {
  if (!Number.isFinite(price) || price <= 0 || !['BUY', 'SELL'].includes(side)
    || ![slippageBps, spreadBps].every(value => Number.isFinite(value) && value >= 0 && value <= 100)) throw new Error('INVALID_EXECUTION_ASSUMPTION');
  return price * (1 + (side === 'BUY' ? 1 : -1) * (slippageBps + spreadBps / 2) / 10000);
}

@Injectable()
export class PaperOrderExecutionService implements OrderExecution {
  private validate(price: number, quantity: number, at: Date) {
    if (!Number.isFinite(price) || price <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0 || !Number.isFinite(at.getTime())) {
      throw new Error('INVALID_SIMULATED_FILL');
    }
  }
  async fill(request: FillRequest) {
    this.validate(request.price, request.quantity, request.at);
    return { entryPrice: request.price, investment: request.price * request.quantity, entryTime: request.at };
  }
  async close(request: CloseRequest) {
    this.validate(request.price, request.quantity, request.at);
    this.validate(request.entryPrice, request.quantity, request.at);
    if (!['BUY', 'SELL'].includes(request.side)) throw new Error('INVALID_FILL_SIDE');
    const pnl = (request.side === 'BUY' ? request.price - request.entryPrice : request.entryPrice - request.price) * request.quantity;
    return { exitPrice: request.price, exitTime: request.at, pnl, pnlPercent: pnl / (request.entryPrice * request.quantity) * 100, exitReason: request.reason };
  }
}
