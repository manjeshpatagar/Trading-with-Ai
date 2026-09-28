import { MarketGateway } from './market.gateway';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { PaperTradingService } from './paper-trading.service';
import { UpstoxService } from './upstox.service';
import { marketClock, strategyDemoClock } from './market-clock';

@Injectable()
export class EodRiskManagerService {
  private readonly logger = new Logger(EodRiskManagerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paper: PaperTradingService,
    private readonly upstox: UpstoxService,
    private readonly config: ConfigService,
    private readonly market: MarketGateway,
  ) {}

  @Cron('*/10 * * * * *', { timeZone: 'Asia/Kolkata' })
  async enforce() {
    const clock = marketClock();
    const demoClock = strategyDemoClock();
    if ((!clock.shouldAutoExit && !demoClock.shouldAutoExit) || this.running) return;
    this.running = true;
    try {
      if (demoClock.shouldAutoExit) await this.runStrategyPaper();
      if (clock.shouldAutoExit) {
        await this.runPaper(clock.tradingDate);
        if (this.config.get<string>('AUTO_TRADING_ENABLED') === 'true') await this.runLive(clock.tradingDate);
      }
    } finally {
      this.running = false;
    }
  }

  state() {
    return marketClock(new Date(), this.running);
  }

  private async runStrategyPaper() {
    // Retry each scheduled pass, including after restart or a missing quote.
    // A previously completed/failed global PAPER run must not suppress exits.
    try {
      const orders = await this.prisma.paperOrder.findMany({ where: { portfolio: 'STRATEGY', status: 'OPEN' }, select: { userId: true, instrumentKey: true } });
      const users = [...new Set(orders.map(order => order.userId))];
      for (const userId of users) await this.market.refreshPrices(userId, orders.filter(order => order.userId === userId).map(order => order.instrumentKey));
      const closed = await this.paper.closeAllEod(new Date(), 'STRATEGY');
      for (const userId of users) this.market.emitToUser(userId, 'paper-trading-updated', { portfolio: 'STRATEGY' });
      if (closed) this.logger.log(JSON.stringify({ event: 'eod.strategy.completed', closed }));
    } catch (error) {
      this.logger.error(`Strategy demo EOD exit failed; retrying next cycle: ${String(error)}`);
    }
  }

  private async claim(tradingDate: string, userId: string, scope: string) {
    try {
      return await this.prisma.eodRiskRun.create({ data: { tradingDate, userId, scope, status: 'RUNNING' } });
    } catch (error: any) {
      if (error?.code === 'P2002') return null;
      throw error;
    }
  }

  private async runPaper(tradingDate: string) {
    const run = await this.claim(tradingDate, 'ALL', 'PAPER');
    if (!run) return;
    try {
      const orders = await this.prisma.paperOrder.findMany({ where: { status: 'OPEN' }, select: { userId: true, instrumentKey: true } });
      for (const userId of new Set(orders.map(order => order.userId)))
        await this.market.refreshPrices(userId, orders.filter(order => order.userId === userId).map(order => order.instrumentKey));
      const closed = await this.paper.closeAllEod(new Date());
      if (await this.prisma.paperOrder.count({ where: { status: 'OPEN' } })) {
        await this.prisma.eodRiskRun.delete({ where: { id: run.id } });
        this.logger.warn('Waiting for fresh prices to finish paper EOD exits; retrying next cycle');
        return;
      }
      await this.prisma.eodRiskRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', completedAt: new Date(), alert: `${closed} paper positions closed` } });
      this.logger.log(JSON.stringify({ event: 'eod.paper.completed', tradingDate, closed }));
    } catch (error) {
      await this.fail(run.id, error);
    }
  }

  private async runLive(tradingDate: string) {
    const users = await this.prisma.user.findMany({ where: { token: { isNot: null } }, select: { id: true } });
    for (const user of users) {
      // The managed real engine reconciles its own exits and pending entries.
      // Never race it with a second, account-wide exit submission.
      if (await this.prisma.realTradingControl.findFirst({ where: { userId: user.id, activeTradeId: { not: null } } })) continue;
      const run = await this.claim(tradingDate, user.id, 'LIVE');
      if (!run) continue;
      try {
        let response: any;
        let orderIds: string[] = [];
        let failure: unknown;
        for (let attempt = 1; attempt <= 2; attempt += 1) {
          try {
            response = await this.upstox.exitIntradayPositions(user.id);
            if (response?.status === 'error' || Number(response?.summary?.error ?? 0) > 0) throw new Error(JSON.stringify(response?.errors ?? response));
            orderIds = response?.data?.order_ids ?? [];
            await this.upstox.waitForOrders(user.id, orderIds);
            failure = undefined;
            break;
          } catch (error) {
            failure = error;
            this.logger.error(JSON.stringify({ event: 'eod.live.exit.failed', tradingDate, userId: user.id, attempt, message: error instanceof Error ? error.message : String(error) }), error instanceof Error ? error.stack : undefined);
          }
        }
        if (failure) throw failure;
        await this.prisma.eodRiskRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', brokerOrderIds: JSON.stringify(orderIds), completedAt: new Date() } });
        this.logger.log(JSON.stringify({ event: 'eod.live.completed', tradingDate, userId: user.id, orderIds }));
      } catch (error) {
        await this.fail(run.id, error);
      }
    }
  }

  private async fail(id: string, error: unknown) {
    const exception = error instanceof Error ? error : new Error(String(error));
    await this.prisma.eodRiskRun.update({ where: { id }, data: { status: 'FAILED', alert: exception.message, completedAt: new Date() } });
    this.logger.error(JSON.stringify({ event: 'eod.exit.failed', id, message: exception.message, stack: exception.stack }), exception.stack);
  }
}
