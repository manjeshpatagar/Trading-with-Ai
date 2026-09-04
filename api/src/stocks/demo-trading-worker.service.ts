import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { marketClock } from './market-clock';
import { MarketGateway } from './market.gateway';
import { ScannerService } from './scanner.service';
import { PaperTradingService } from './paper-trading.service';

const ACTIVE_SIGNAL_STATUSES = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'PARTIAL_PROFIT_BOOKED', 'TRAILING_STOP_ACTIVE', 'TARGET2_HIT', 'TARGET3_HIT', 'STOPLOSS_CONFIRMATION'];

/** Keeps demo signal discovery and live-price processing alive without a browser tab. */
@Injectable()
export class DemoTradingWorkerService implements OnModuleInit {
  private readonly logger = new Logger(DemoTradingWorkerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly scanner: ScannerService,
    private readonly market: MarketGateway,
    private readonly paper: PaperTradingService,
  ) {}

  onModuleInit() {
    // Restore persisted work after every API restart; do not delay boot.
    setImmediate(() => void this.run(true));
  }

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async monitor() {
    await this.run(false);
  }

  /** Safety net when one subscribed instrument goes quiet on an otherwise healthy socket. */
  @Cron('*/5 * * * * *', { timeZone: 'Asia/Kolkata' })
  async refreshOpenPositionPrices() {
    const accounts = await this.prisma.paperTradingAccount.findMany({
      where: { enabled: true, autoDemoTrading: true, user: { token: { isNot: null } } },
      select: { userId: true },
    });
    for (const { userId } of accounts) {
      const orders = await this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' }, select: { instrumentKey: true } });
      const keys = [...new Set(orders.map((order) => order.instrumentKey))];
      if (!keys.length) continue;
      this.logger.log(JSON.stringify({ event: 'demo.live.refresh.requested', userId, instrumentKeys: keys }));
      await this.market.refreshPrices(userId, keys);
    }
  }

  private async run(restoreOnly: boolean) {
    if (this.running) return;
    const clock = marketClock();
    if (!restoreOnly && !clock.canEnter) return;
    this.running = true;
    try {
      const accounts = await this.prisma.paperTradingAccount.findMany({
        where: { enabled: true, autoDemoTrading: true, user: { token: { isNot: null } } },
        select: { userId: true },
      });
      for (const { userId } of accounts) {
        try {
          const [signals, orders] = await Promise.all([
            this.prisma.aiSignal.findMany({ where: { userId, status: { in: ACTIVE_SIGNAL_STATUSES } }, select: { instrumentKey: true } }),
            this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' }, select: { instrumentKey: true } }),
          ]);
          const keys = [...new Set([...signals, ...orders].map((item) => item.instrumentKey))];
          if (keys.length) await this.market.subscribeMany(userId, keys);
          // A busy user feed can remain healthy while one instrument silently
          // stops producing websocket ticks. Poll open positions explicitly so
          // exits and P&L never depend on unrelated symbols keeping it alive.
          const openOrderKeys = [...new Set(orders.map((item) => item.instrumentKey))];
          if (openOrderKeys.length) await this.market.refreshPrices(userId, openOrderKeys);
          // Recover a Target 1 transition even when its original websocket
          // callback was missed during a disconnect or server restart.
          await this.paper.reconcileTriggeredDemoSignals(userId);
          if (!restoreOnly && clock.canEnter) await this.scanner.scan(userId, false, true);
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
