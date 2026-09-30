import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { strategyDemoClock } from './market-clock';
import { MarketGateway } from './market.gateway';
import { ScannerService } from './scanner.service';
import { PaperTradingService } from './paper-trading.service';
import { SignalHistoryService } from './signal-history.service';
import { UpstoxService } from './upstox.service';
import { strategyHistoryRange } from './strategy-weekly';

const ACTIVE_SIGNAL_STATUSES = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'PARTIAL_PROFIT_BOOKED', 'TRAILING_STOP_ACTIVE', 'TARGET2_HIT', 'TARGET3_HIT', 'STOPLOSS_CONFIRMATION'];

/** Keeps demo signal discovery and live-price processing alive without a browser tab. */
@Injectable()
export class DemoTradingWorkerService implements OnModuleInit {
  private readonly logger = new Logger(DemoTradingWorkerService.name);
  private running = false;
  private recovering = false;
  private readonly candleRanges = new Map<string, { timestamp: number; high: number; low: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanner: ScannerService,
    private readonly market: MarketGateway,
    private readonly paper: PaperTradingService,
    private readonly signals?: SignalHistoryService,
    private readonly upstox?: UpstoxService,
  ) {}

  onModuleInit() {
    // Restore live subscriptions after restart; old hits never create orders.
    setImmediate(() => void this.run(true));
  }

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async monitor() {
    await this.run(false);
  }

  @Cron('*/2 * * * * *', { timeZone: 'Asia/Kolkata' })
  async recoverExecutionEvents() {
    if (this.recovering) return;
    this.recovering = true;
    try {
      const accounts = await this.prisma.paperTradingAccount.findMany({ where: { portfolio: 'STRATEGY' }, select: { userId: true } });
      for (const { userId } of accounts) {
        if (await this.paper.reconcileTriggeredDemoSignals(userId, new Date(), 'STRATEGY')) this.market.notifyPaperTradingUpdated(userId, 'STRATEGY');
      }
    } catch (error) { this.logger.warn(`Demo event recovery failed: ${error instanceof Error ? error.message : String(error)}`); }
    finally { this.recovering = false; }
  }

  /** Safety net when one subscribed instrument goes quiet on an otherwise healthy socket. */
  @Cron('*/5 * * * * *', { timeZone: 'Asia/Kolkata' })
  async refreshOpenPositionPrices() {
    const accounts = await this.prisma.paperTradingAccount.findMany({
      where: { enabled: true, autoDemoTrading: true, user: { token: { isNot: null } } },
      select: { userId: true },
    });
    for (const userId of new Set(accounts.map((account) => account.userId))) {
      const orders = await this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' }, select: { instrumentKey: true, entryTime: true } });
      // Process exits before polling hundreds of potential next entries.
      const openKeys = [...new Set(orders.map(order => order.instrumentKey))];
      if (openKeys.length) await this.market.refreshPrices(userId, openKeys);
      for (const instrumentKey of openKeys) {
        if (!this.upstox || !this.signals) continue;
        const enteredAt = orders.filter(order => order.instrumentKey === instrumentKey && order.entryTime).reduce((earliest, order) => Math.min(earliest, order.entryTime!.getTime()), Date.now());
        try {
          const response: any = await this.upstox.intraday(userId, instrumentKey, 'minutes', 1);
          const candles: unknown[][] = Array.isArray(response?.data?.candles) ? response.data.candles : [];
          const normalized = candles.map(row => ({ at: new Date(String(row[0])), high: Number(row[2]), low: Number(row[3]) }))
            .filter(candle => Number.isFinite(candle.at.getTime()) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && candle.at.getTime() + 60_000 >= enteredAt)
            .sort((left, right) => left.at.getTime() - right.at.getTime());
          for (const candle of normalized) {
            const cursorKey = `${userId}:${instrumentKey}`, previous = this.candleRanges.get(cursorKey), timestamp = candle.at.getTime();
            if (previous && (timestamp < previous.timestamp || timestamp === previous.timestamp && candle.high <= previous.high && candle.low >= previous.low)) continue;
            const observedAt = new Date(Math.min(Date.now(), Math.max(enteredAt, timestamp + 59_999)));
            // SQLite serializes writers. Close the demo first, then persist the
            // signal lifecycle so both operations can complete without lock races.
            const paperChanged = await this.paper.processCandleRange(userId, instrumentKey, candle.high, candle.low, observedAt);
            const signalChanges = await this.signals.processCandleRange(userId, instrumentKey, candle.high, candle.low, observedAt);
            // Advance the cursor only after both writes succeed; failed candles
            // remain eligible for the next five-second recovery pass.
            this.candleRanges.set(cursorKey, { timestamp, high: candle.high, low: candle.low });
            if (paperChanged) this.market.notifyPaperTradingUpdated(userId, 'STRATEGY');
            if (signalChanges.length) this.market.emitToUser(userId, 'signal-history-updated', { instrumentKey, high: candle.high, low: candle.low, trades: signalChanges, source: 'intraday-candle-recovery' });
          }
        } catch (error) { this.logger.warn(JSON.stringify({ event: 'demo.candle.recovery.failed', userId, instrumentKey, message: error instanceof Error ? error.message : String(error) })); }
      }
      const { start, end } = strategyHistoryRange(new Date(), 1);
      const armed = await this.prisma.aiSignal.findMany({ where: { userId, signalTime: { gte: start, lt: end }, niftyContext: { is: null }, OR: [{ aiStrategyListed: true }, { aiStrategyListedAt: { not: null } }, { top100Selected: true }], AND: [{ OR: [{ target1At: null }, { top100Selected: true }] }], status: { in: ACTIVE_SIGNAL_STATUSES } }, select: { instrumentKey: true } });
      const keys = [...new Set(armed.map(order => order.instrumentKey))].filter(key => !openKeys.includes(key));
      if (!keys.length) continue;
      this.logger.log(JSON.stringify({ event: 'demo.live.refresh.requested', userId, instrumentKeys: keys }));
      await this.market.refreshPrices(userId, keys);
    }
  }

  private async run(restoreOnly: boolean) {
    if (this.running) return;
    const clock = strategyDemoClock();
    if (!restoreOnly && !clock.canEnter) return;
    this.running = true;
    try {
      const accounts = await this.prisma.paperTradingAccount.findMany({
        where: { enabled: true, autoDemoTrading: true, user: { token: { isNot: null } } },
        select: { userId: true },
      });
      for (const userId of new Set(accounts.map((account) => account.userId))) {
        try {
          const [signals, orders] = await Promise.all([
            this.prisma.aiSignal.findMany({ where: { userId, status: { in: ACTIVE_SIGNAL_STATUSES } }, select: { instrumentKey: true, events: { where: { type: 'TARGET1_HIT' }, select: { eventTime: true } } } }),
            this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' }, select: { instrumentKey: true } }),
          ]);
          const keys = [...new Set([...signals, ...orders].map((item) => item.instrumentKey))];
          if (keys.length) await this.market.subscribeMany(userId, keys);
          // A busy user feed can remain healthy while one instrument silently
          // stops producing websocket ticks. Poll open positions explicitly so
          // exits and P&L never depend on unrelated symbols keeping it alive.
          const refreshKeys = [...new Set([...orders, ...signals.filter((signal) => !signal.events.length)].map((item) => item.instrumentKey))];
          if (refreshKeys.length) await this.market.refreshPrices(userId, refreshKeys);
          if (!restoreOnly && clock.canEnter) {
            await this.scanner.scan(userId, false, true);
          }
          this.logger.debug(JSON.stringify({ event: 'demo.worker.active', userId, restoredSubscriptions: keys.length, scanned: !restoreOnly && clock.canEnter }));
        } catch (error) {
          this.logger.warn(JSON.stringify({ event: 'demo.worker.user.failed', userId, message: error instanceof Error ? error.message : String(error) }));
        }
      }
    } catch (error) {
      this.logger.error(JSON.stringify({ event: 'demo.worker.failed', message: error instanceof Error ? error.message : String(error) }));
    } finally {
      this.running = false;
    }
  }
}
