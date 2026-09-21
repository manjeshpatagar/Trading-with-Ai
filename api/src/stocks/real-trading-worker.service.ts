import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { MarketGateway } from './market.gateway';
import { RealExecutionService } from './real-execution.service';
import { marketClock } from './market-clock';

@Injectable()
export class RealTradingWorkerService implements OnModuleInit {
  private monitoring = false;
  private refreshing = false;
  private readonly logger = new Logger(RealTradingWorkerService.name);
  constructor(private readonly prisma: PrismaService, private readonly execution: RealExecutionService, private readonly market: MarketGateway) {}
  onModuleInit() { setImmediate(() => { void this.monitor(); void this.refresh(); }); }
  @Cron('* * * * * *', { timeZone: 'Asia/Kolkata' })
  async monitor() {
    if (this.monitoring) return;
    this.monitoring = true;
    try { await this.execution.monitor(); }
    catch (error) { this.logger.error(String(error)); }
    finally { this.monitoring = false; }
  }
  @Cron('*/5 * * * * *', { timeZone: 'Asia/Kolkata' })
  async refresh() {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const controls = await this.prisma.realTradingControl.findMany({ where: { OR: [
        { activeTradeId: { not: null } }, { strategyEnabledAt: { not: null } }, { historyEnabledAt: { not: null } },
      ] } });
      for (const control of controls) {
        const active = control.activeTradeId ? await this.prisma.realTrade.findUnique({ where: { id: control.activeTradeId } }) : null;
        const signals = marketClock().canEnter ? await this.prisma.aiSignal.findMany({ where: {
          userId: control.userId, target1At: null, niftyContext: { is: null },
          status: { in: ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING'] },
          OR: [...(control.strategyEnabledAt ? [{ aiStrategyListed: true }] : []), ...(control.historyEnabledAt ? [{ top100Selected: true }] : [])],
        }, select: { instrumentKey: true } }) : [];
        const keys = [...new Set([...signals.map(row => row.instrumentKey), ...(active ? [active.instrumentKey] : [])])];
        if (keys.length) { await this.market.subscribeMany(control.userId, keys); await this.market.refreshPrices(control.userId, keys); }
      }
    } catch (error) { this.logger.error(String(error)); }
    finally { this.refreshing = false; }
  }
}
