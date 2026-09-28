import { RealOrderStreamService } from './real-order-stream.service';
import { RealExecutionService } from './real-execution.service';
import type { RealSource } from './real-trading-rules';
import { Injectable, Logger } from '@nestjs/common';
import { UpstoxService } from './upstox.service';

@Injectable()
export class RealTradingService {
  private readonly logger = new Logger(RealTradingService.name);
  constructor(private readonly upstox: UpstoxService, private readonly execution: RealExecutionService, private readonly stream: RealOrderStreamService) {}

  async setEnabled(userId: string, source: RealSource, enabled: boolean) {
    const result = await this.execution.setEnabled(userId, source, enabled);
    void this.stream.sync();
    return result;
  }

  async status(userId: string) { return { ...await this.execution.state(userId), stream: this.stream.status(userId) }; }

  async dashboard(userId: string) {
    const requests = await Promise.allSettled([
      this.upstox.profile(userId),
      this.upstox.funds(userId),
      this.upstox.positions(userId),
      this.upstox.orderBook(userId),
      this.upstox.tradeBook(userId),
    ]);
    const value = (index: number): any => requests[index].status === 'fulfilled' ? requests[index].value : {};
    const errors = requests.flatMap((result, index) => result.status === 'rejected'
      ? [`${['profile', 'funds', 'positions', 'orders', 'trades'][index]}: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : []);
    const profile = value(0)?.data ?? {};
    const fundData = value(1)?.data ?? {};
    const equity = fundData.equity ?? fundData;
    const positions = this.array(value(2)?.data).map((position: any) => ({
      instrumentKey: position.instrument_token ?? position.instrument_key,
      symbol: position.trading_symbol ?? position.tradingsymbol,
      side: Number(position.quantity ?? 0) < 0 ? 'SELL' : 'BUY',
      quantity: Math.abs(Number(position.quantity ?? 0)),
      averagePrice: Number(position.average_price ?? position.buy_price ?? position.sell_price ?? 0),
      currentPrice: Number(position.last_price ?? position.close_price ?? 0),
      pnl: Number(position.pnl ?? position.unrealised ?? 0),
      product: position.product,
    })).filter((position: any) => position.quantity > 0);
    const orders = this.array(value(3)?.data).map((order: any) => ({
      orderId: order.order_id,
      symbol: order.trading_symbol,
      transactionType: order.transaction_type,
      status: order.status,
      quantity: Number(order.quantity ?? 0),
      averagePrice: Number(order.average_price ?? order.price ?? 0),
    }));
    const trades = this.array(value(4)?.data);
    this.logger.log(`Real trading dashboard | User: ${userId} | Positions: ${positions.length} | Orders: ${orders.length} | Partial errors: ${errors.length}`);
    return {
      automation: await this.status(userId),
      connected: requests[0].status === 'fulfilled',
      broker: 'Upstox',
      profile: { userName: profile.user_name, userId: profile.user_id },
      funds: {
        available: Number(equity.available_margin ?? equity.available_cash ?? equity.net ?? 0),
        margin: Number(equity.used_margin ?? equity.utilised_margin ?? 0),
      },
      positions,
      orders,
      trades,
      errors,
    };
  }

  async manualExit(userId: string, instrumentKey: string, product: string) {
    if (!instrumentKey || !product) throw new Error('Instrument key and product are required for a broker exit');
    if (product === 'I' && await this.execution.requestExit(userId, instrumentKey)) return { status: 'success', message: 'Managed exit requested' };
    this.logger.warn(`Real position manual exit requested | User: ${userId} | Instrument: ${instrumentKey} | Product: ${product}`);
    return this.upstox.exitPosition(userId, instrumentKey, product);
  }

  private array(value: unknown): any[] { return Array.isArray(value) ? value : []; }
}
