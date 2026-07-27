import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { PaperTradingService } from './paper-trading.service';
import { UpstoxService } from './upstox.service';
import { marketClock } from './market-clock';

@Injectable()
export class EodRiskManagerService {
  private readonly logger = new Logger(EodRiskManagerService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly paper: PaperTradingService,
    private readonly upstox: UpstoxService,
    private readonly config: ConfigService,
  ) {}

  @Cron('*/10 * * * * *', { timeZone: 'Asia/Kolkata' })
  async enforce() {
    const clock = marketClock();
    if (!clock.shouldAutoExit || this.running) return;
    this.running = true;
    try {
      await this.runPaper(clock.tradingDate);
      if (this.config.get<string>('AUTO_TRADING_ENABLED') === 'true') await this.runLive(clock.tradingDate);
    } finally {
      this.running = false;
    }
  }

  state() {
    return marketClock(new Date(), this.running);
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
      const closed = await this.paper.closeAllEod(new Date());
      await this.prisma.eodRiskRun.update({ where: { id: run.id }, data: { status: 'COMPLETED', completedAt: new Date(), alert: `${closed} paper positions closed` } });
      this.logger.log(JSON.stringify({ event: 'eod.paper.completed', tradingDate, closed }));
    } catch (error) {
      await this.fail(run.id, error);
    }
  }

  private async runLive(tradingDate: string) {
    const users = await this.prisma.user.findMany({ where: { token: { isNot: null } }, select: { id: true } });
    for (const user of users) {
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
