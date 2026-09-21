import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { randomUUID } from 'node:crypto';
import type { Prisma, RealTrade, RealOrderAttempt } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { UpstoxService } from './upstox.service';
import { MarketPricesService } from './market-prices.service';
import { marketClock } from './market-clock';
import { brokerTerminal, liveSource, LIVE_HIT_MAX_AGE_MS, realExitReason, RealSource } from './real-trading-rules';

@Injectable()
export class RealExecutionService {
  private readonly logger = new Logger(RealExecutionService.name);
  private readonly startedAt = new Date();
  private readonly running = new Set<string>();
  private readonly watched = new Map<string, RealTrade>();
  constructor(private readonly prisma: PrismaService, private readonly broker: UpstoxService, private readonly prices: MarketPricesService) {}

  async control(userId: string) {
    return this.prisma.realTradingControl.upsert({ where: { userId }, create: { userId }, update: {} });
  }

  async setEnabled(userId: string, source: RealSource, enabled: boolean) {
    if (!['STRATEGY', 'SIGNAL_HISTORY'].includes(source) || typeof enabled !== 'boolean') throw new BadRequestException('A valid source and boolean enabled are required');
    if (enabled) await this.broker.profile(userId);
    await this.control(userId);
    const field = source === 'STRATEGY' ? 'strategyEnabledAt' : 'historyEnabledAt';
    // Repeated ON requests do not move the activation boundary; OFF/ON does.
    await this.prisma.realTradingControl.updateMany({ where: { userId, ...(enabled ? { [field]: null } : {}) }, data: { [field]: enabled ? new Date() : null } });
    return this.control(userId);
  }

  async state(userId: string) {
    const control = await this.control(userId);
    const trades = await this.prisma.realTrade.findMany({ where: { userId }, include: { attempts: true }, orderBy: { createdAt: 'desc' }, take: 100 });
    if (control.activeTradeId && !trades.some(trade => trade.id === control.activeTradeId)) {
      const active = await this.prisma.realTrade.findUnique({ where: { id: control.activeTradeId }, include: { attempts: true } });
      if (active) trades.unshift(active);
    }
    return { strategyEnabled: !!control.strategyEnabledAt, historyEnabled: !!control.historyEnabledAt,
      strategyEnabledAt: control.strategyEnabledAt, historyEnabledAt: control.historyEnabledAt,
      activeTradeId: control.activeTradeId, trades };
  }

  // Called in feed arrival order. Only reserve here; broker IO runs independently
  // so paper execution and incoming exit ticks never wait for a broker response.
  async capture(userId: string, ids: string[], at: Date) {
    if (!ids.length || at < this.startedAt || !marketClock().canEnter) return;
    const existing = await this.prisma.realTradingControl.findUnique({ where: { userId } });
    if (!existing || (!existing.strategyEnabledAt && !existing.historyEnabledAt)) return;
    for (const id of [...ids].sort()) {
      const claimed = await this.prisma.$transaction(async tx => {
        // SQLite write serialization also protects against a second API process.
        const control = await tx.realTradingControl.update({ where: { userId }, data: { revision: { increment: 1 } } });
        if (await tx.realTrade.findUnique({ where: { userId_signalId: { userId, signalId: id } } })) return null;
        const signal = await tx.aiSignal.findFirst({ where: { id, userId, niftyContext: { is: null } } });
        if (!signal) return null;
        const source = liveSource(signal, control, at);
        if (!source) return null;
        const busy = !!control.activeTradeId || !!(control.lastReleasedAt && at <= control.lastReleasedAt);
        const trade = await tx.realTrade.create({ data: { userId, signalId: id, source, instrumentKey: signal.instrumentKey,
          symbol: signal.symbol, side: signal.side, target: signal.target3, stopLoss: signal.stopLoss, hitAt: at,
          status: busy ? 'SKIPPED' : 'RESERVED', error: busy ? 'Shared real account was busy at this T1 hit' : null } });
        if (busy) return null;
        await tx.realTradingControl.update({ where: { userId }, data: { activeTradeId: trade.id } });
        return trade;
      }, { maxWait: 5_000, timeout: 5_000 });
      if (claimed) { this.watched.set(userId, claimed); void this.drive(userId); }
    }
  }

  async onPrice(userId: string, key: string, price: number, timestamp: number) {
    const trade = this.watched.get(userId);
    if (!trade || trade.instrumentKey !== key || timestamp < (trade.entryTime ?? trade.hitAt).getTime()
      || Date.now() - timestamp > LIVE_HIT_MAX_AGE_MS || timestamp > Date.now()) return;
    const reason = realExitReason(trade, price);
    if (!reason) return;
    await this.prisma.realTrade.updateMany({ where: { id: trade.id, exitReason: null, status: { notIn: ['CLOSED', 'REJECTED', 'SKIPPED'] } }, data: { exitReason: reason } });
    void this.drive(userId);
  }

  async requestExit(userId: string, instrumentKey: string) {
    const control = await this.control(userId);
    if (!control.activeTradeId) return false;
    const trade = await this.prisma.realTrade.findFirst({ where: { id: control.activeTradeId, userId, instrumentKey } });
    if (!trade) return false;
    await this.prisma.realTrade.update({ where: { id: trade.id }, data: { exitReason: 'MANUAL EXIT' } });
    await this.drive(userId);
    return true;
  }

  async monitor() {
    const controls = await this.prisma.realTradingControl.findMany({ where: { activeTradeId: { not: null } } });
    await Promise.allSettled(controls.map(async control => {
      const trade = await this.prisma.realTrade.findUnique({ where: { id: control.activeTradeId! } });
      if (!trade) return;
      this.watched.set(control.userId, trade);
      if (marketClock().shouldAutoExit || marketClock(trade.hitAt).tradingDate < marketClock().tradingDate) {
        await this.prisma.realTrade.updateMany({ where: { id: trade.id, exitReason: null }, data: { exitReason: 'End of Day Auto Exit' } });
      }
      await this.drive(control.userId);
    }));
  }

  async drive(userId: string) {
    if (this.running.has(userId)) return;
    this.running.add(userId);
    const owner = randomUUID();
    try {
      const lease = await this.prisma.realTradingControl.updateMany({ where: { userId, OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] }, data: { leaseOwner: owner, leaseUntil: new Date(Date.now() + 60_000) } });
      if (!lease.count) return;
      const control = await this.control(userId);
      if (!control.activeTradeId) return;
      let trade = await this.prisma.realTrade.findUniqueOrThrow({ where: { id: control.activeTradeId } });
      this.watched.set(userId, trade);
      if (trade.status === 'RESERVED') {
        if (trade.createdAt < this.startedAt) { await this.finish(trade, 'SKIPPED', 'Unsubmitted entry discarded after restart'); return; }
        await this.enter(trade);
        return;
      }
      const attempts = await this.prisma.realOrderAttempt.findMany({ where: { tradeId: trade.id }, orderBy: { createdAt: 'asc' } });
      for (const attempt of attempts.filter(row => !brokerTerminal(row.status))) await this.reconcile(trade, attempt);
      const updated = await this.prisma.realOrderAttempt.findMany({ where: { tradeId: trade.id }, orderBy: { createdAt: 'asc' } });
      const entries = updated.filter(row => row.kind === 'ENTRY');
      const exits = updated.filter(row => row.kind === 'EXIT');
      trade = await this.prisma.realTrade.findUniqueOrThrow({ where: { id: trade.id } });
      const pending = updated.filter(row => !brokerTerminal(row.status));
      if (pending.length) {
        for (const order of pending) {
          // A protected market order can rest unfilled. Cancel its remainder;
          // only terminal confirmed quantities can ever be closed or released.
          if (order.brokerOrderId && (trade.exitReason || Date.now() - order.createdAt.getTime() > 5_000)) {
            await this.broker.cancelRealOrder(userId, order.brokerOrderId);
          }
        }
        return;
      }
      const filled = entries.reduce((sum, row) => sum + row.filledQuantity, 0);
      const exited = exits.reduce((sum, row) => sum + row.filledQuantity, 0);
      if (!filled) { await this.finish(trade, 'REJECTED', entries.map(row => row.error).filter(Boolean).join('; ') || 'Entry was not filled'); return; }
      const positions = this.rows(await this.broker.positions(userId));
      const position = positions.find(row => (row.instrument_token ?? row.instrument_key) === trade.instrumentKey && row.product === 'I');
      const net = Number(position?.quantity ?? 0);
      const remaining = filled - exited;
      if (net === 0 && remaining >= 0 && (exited === filled || trade.status === 'OPEN' || trade.status === 'EXIT_PENDING')) {
        const exitPrice = exited ? exits.reduce((sum, row) => sum + row.averagePrice * row.filledQuantity, 0) / exited : null;
        await this.prisma.realTrade.update({ where: { id: trade.id }, data: { exitPrice, exitReason: trade.exitReason ?? 'Broker position closed' } });
        await this.finish(trade, 'CLOSED'); return;
      }
      if (net === 0 && trade.status === 'ENTRY_PENDING') return; // broker position snapshot may lag the fill
      if (remaining <= 0 || net !== (trade.side === 'BUY' ? remaining : -remaining)) {
        await this.prisma.realTrade.update({ where: { id: trade.id }, data: { status: 'ATTENTION', error: 'Broker position differs from confirmed fills. Shared slot remains locked; review in Upstox.' } });
        return;
      }
      const entryPrice = entries.reduce((sum, row) => sum + row.averagePrice * row.filledQuantity, 0) / filled;
      trade = await this.prisma.realTrade.update({ where: { id: trade.id }, data: { status: 'OPEN', quantity: filled, entryPrice, entryTime: trade.entryTime ?? new Date(), error: null } });
      this.watched.set(userId, trade);
      const quote = this.prices.get(userId, trade.instrumentKey);
      const priceReason = quote && Date.now() - quote.timestamp <= LIVE_HIT_MAX_AGE_MS ? realExitReason(trade, quote.ltp) : null;
      const reason = trade.exitReason ?? (marketClock().shouldAutoExit ? 'End of Day Auto Exit' : priceReason);
      if (reason) {
        if (exits.filter(row => row.filledQuantity === 0).length >= 3) {
          await this.prisma.realTrade.update({ where: { id: trade.id }, data: { status: 'ATTENTION', error: 'Exit rejected or unfilled three times. Review and exit in Upstox; slot remains locked.' } });
          return;
        }
        await this.prisma.realTrade.update({ where: { id: trade.id }, data: { exitReason: reason } });
        await this.submit(trade, 'EXIT', remaining);
      }
    } catch (error) {
      const message = this.message(error);
      this.logger.error(`Real execution ${userId}: ${message}`);
      const control = await this.prisma.realTradingControl.findUnique({ where: { userId } }).catch(() => null);
      if (control?.activeTradeId) await this.prisma.realTrade.update({ where: { id: control.activeTradeId }, data: { error: message } }).catch(() => undefined);
    } finally {
      await this.prisma.realTradingControl.updateMany({ where: { userId, leaseOwner: owner }, data: { leaseOwner: null, leaseUntil: null } }).catch(() => undefined);
      this.running.delete(userId);
    }
  }

  private async enter(trade: RealTrade) {
    try {
      const [fundResponse, positionResponse, orderResponse, perShare] = await Promise.all([
        this.broker.funds(trade.userId), this.broker.positions(trade.userId), this.broker.orderBook(trade.userId),
        this.broker.intradayMargin(trade.userId, trade.instrumentKey, trade.side, 1),
      ]);
      if (this.rows(positionResponse).some(row => Number(row.quantity) !== 0) || this.rows(orderResponse).some(row => !brokerTerminal(String(row.status)))) throw new Error('Broker account already has a position or pending order');
      const equity = fundResponse?.data?.equity;
      const cash = Number(equity?.available_margin);
      if (!Number.isFinite(cash) || cash <= 0) throw new Error('No available equity margin reported by broker');
      // Leave 2% for charges and price movement; never assume fixed leverage.
      const budget = cash * 0.98;
      let quantity = Math.floor(budget / perShare);
      if (!Number.isSafeInteger(quantity) || quantity < 1) throw new Error('Insufficient broker margin for one share');
      let required = await this.broker.intradayMargin(trade.userId, trade.instrumentKey, trade.side, quantity);
      if (required > budget) {
        quantity = Math.floor(quantity * budget / required);
        if (quantity < 1) throw new Error('Insufficient broker margin');
        required = await this.broker.intradayMargin(trade.userId, trade.instrumentKey, trade.side, quantity);
      }
      if (required > budget) throw new Error('Broker margin exceeds available allocation');
      const signal = await this.prisma.aiSignal.findUniqueOrThrow({ where: { id: trade.signalId } });
      const quote = this.prices.get(trade.userId, trade.instrumentKey);
      if (!quote || Date.now() - quote.timestamp > LIVE_HIT_MAX_AGE_MS) throw new Error('Live price is stale; no late entry');
      // OFF, publication changes, target/stop movement, cutoff and freshness are
      // rechecked atomically at the actual submission boundary.
      const attempt = await this.prisma.$transaction(async tx => {
        const control = await tx.realTradingControl.update({ where: { userId: trade.userId }, data: { revision: { increment: 1 } } });
        const onlySource = { strategyEnabledAt: trade.source === 'STRATEGY' ? control.strategyEnabledAt : null,
          historyEnabledAt: trade.source === 'SIGNAL_HISTORY' ? control.historyEnabledAt : null };
        const current = await tx.realTrade.findUniqueOrThrow({ where: { id: trade.id } });
        if (control.activeTradeId !== trade.id || current.exitReason || !liveSource({ ...signal, currentPrice: quote.ltp }, onlySource, trade.hitAt)) throw new Error('Entry disabled, no longer valid, or T1 is no longer fresh');
        return this.createAttempt(tx, trade, 'ENTRY', quantity);
      });
      await this.sendAttempt(trade, attempt);
    } catch (error) {
      // If submission was persisted, its outcome may be unknown: retain slot.
      const count = await this.prisma.realOrderAttempt.count({ where: { tradeId: trade.id } });
      if (!count) await this.finish(trade, 'SKIPPED', this.message(error));
      else throw error;
    }
  }

  private async createAttempt(tx: Prisma.TransactionClient, trade: RealTrade, kind: string, quantity: number): Promise<RealOrderAttempt> {
    const current = await tx.realTrade.findUniqueOrThrow({ where: { id: trade.id } });
    const attempts = await tx.realOrderAttempt.findMany({ where: { tradeId: trade.id } });
    if (kind === 'ENTRY' && (current.status !== 'RESERVED' || attempts.length)) throw new Error('Entry already submitted');
    if (kind === 'EXIT' && attempts.some(row => !brokerTerminal(row.status))) throw new Error('An order is still pending');
    const attempt = await tx.realOrderAttempt.create({ data: { tradeId: trade.id, kind, quantity, tag: `qp${randomUUID().replaceAll('-', '')}` } });
    await tx.realTrade.update({ where: { id: trade.id }, data: { status: kind === 'ENTRY' ? 'ENTRY_PENDING' : 'EXIT_PENDING' } });
    return attempt;
  }
  private async submit(trade: RealTrade, kind: string, quantity: number) {
    const attempt = await this.prisma.$transaction(tx => this.createAttempt(tx, trade, kind, quantity));
    await this.sendAttempt(trade, attempt);
  }
  private async sendAttempt(trade: RealTrade, attempt: RealOrderAttempt) {
    try {
      const side = attempt.kind === 'ENTRY' ? trade.side : trade.side === 'BUY' ? 'SELL' : 'BUY';
      const result = await this.broker.placeIntradayMarket(trade.userId, trade.instrumentKey, side, attempt.quantity, attempt.tag);
      if (result?.status === 'error') {
        await this.prisma.realOrderAttempt.update({ where: { id: attempt.id }, data: { status: 'rejected', error: String(result?.errors?.[0]?.message ?? 'Broker rejected order') } });
        return;
      }
      const ids = result?.data?.order_ids;
      if (result?.status !== 'success' || !Array.isArray(ids) || ids.length !== 1) throw new Error('Broker acknowledgement is ambiguous; reconciling by order tag');
      await this.prisma.realOrderAttempt.update({ where: { id: attempt.id }, data: { brokerOrderId: String(ids[0]), status: 'PENDING' } });
    } catch (error) {
      if (axios.isAxiosError(error) && [400, 401, 403, 404, 422, 429].includes(error.response?.status ?? 0) && error.response?.data?.status === 'error') {
        await this.prisma.realOrderAttempt.update({ where: { id: attempt.id }, data: { status: 'rejected', error: String(error.response.data.errors?.[0]?.message ?? error.message) } });
        return;
      }
      // A timeout or server error does not prove that the broker rejected the order.
      await this.prisma.realOrderAttempt.update({ where: { id: attempt.id }, data: { status: 'UNKNOWN', error: this.message(error) } });
      await this.prisma.realTrade.update({ where: { id: trade.id }, data: { error: 'Order acknowledgement unavailable. Reconciling with broker; duplicate submission blocked.' } });
    }
  }
  private async reconcile(trade: RealTrade, attempt: RealOrderAttempt) {
    let order: any;
    if (attempt.brokerOrderId) order = (await this.broker.realOrderDetails(trade.userId, attempt.brokerOrderId))?.data;
    else {
      const matches = this.rows(await this.broker.orderBook(trade.userId)).filter(row => row.tag === attempt.tag);
      if (matches.length !== 1) {
        await this.prisma.realTrade.update({ where: { id: trade.id }, data: { status: 'ATTENTION', error: 'Order outcome is unknown. Check Upstox before further trading; shared slot remains locked.' } });
        return;
      }
      order = matches[0];
    }
    const filled = Number(order?.filled_quantity);
    const average = Number(order?.average_price);
    if (!order?.order_id || !Number.isInteger(filled) || filled < 0 || filled > attempt.quantity
      || (filled > 0 && (!Number.isFinite(average) || average <= 0))) throw new Error('Invalid broker fill confirmation');
    await this.prisma.realOrderAttempt.update({ where: { id: attempt.id }, data: {
      brokerOrderId: String(order.order_id), status: String(order.status).toLowerCase(), filledQuantity: filled,
      averagePrice: Number.isFinite(average) ? average : 0, error: order.status_message || null,
    } });
  }
  private async finish(trade: RealTrade, status: string, error: string | null = null) {
    const at = new Date();
    await this.prisma.$transaction([
      this.prisma.realTrade.update({ where: { id: trade.id }, data: { status, error, exitTime: at } }),
      this.prisma.realTradingControl.updateMany({ where: { userId: trade.userId, activeTradeId: trade.id }, data: { activeTradeId: null, lastReleasedAt: at } }),
    ]);
    this.watched.delete(trade.userId);
  }
  private rows(response: any): any[] {
    if (response?.status !== 'success' || !Array.isArray(response.data)) throw new Error('Broker state unavailable; execution paused');
    return response.data;
  }
  private message(error: unknown) { return error instanceof Error ? error.message : String(error); }
}
