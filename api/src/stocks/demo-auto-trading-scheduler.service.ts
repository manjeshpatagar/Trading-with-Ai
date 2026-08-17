import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { marketClock } from './market-clock';
import { PaperTradingService } from './paper-trading.service';
import { ScannerService } from './scanner.service';

@Injectable()
export class DemoAutoTradingSchedulerService {
  private readonly logger = new Logger(DemoAutoTradingSchedulerService.name);
  private running = false;
  constructor(private readonly prisma: PrismaService, private readonly scanner: ScannerService, private readonly paper: PaperTradingService) {}

  @Interval(30_000)
  async cycle() {
    if (this.running || !marketClock().canEnter) return;
    this.running = true;
    try {
      const accounts = await this.prisma.paperTradingAccount.findMany({ where: { enabled: true, autoDemoTrading: true, mode: 'AUTO', reconciliationRequired: false } });
      for (const account of accounts) {
        const open = await this.prisma.paperOrder.count({ where: { userId: account.userId, status: 'OPEN' } });
        if (open) continue;
        this.logger.log(JSON.stringify({ event: 'demo.cycle.scan.started', userId: account.userId }));
        await this.scanner.scan(account.userId, false, true);
        const { start, end } = this.tradingDayRange();
        const signals = await this.prisma.aiSignal.findMany({ where: { userId: account.userId, status: 'ENTRY_TRIGGERED', executionEligible: true, demoExecuted: false, entryTriggeredAt: { not: null }, signalTime: { gte: start, lt: end }, completedAt: null, stopLossAt: null } });
        const changed = await this.paper.captureTriggeredDemoSignals(account.userId, signals);
        this.logger.log(JSON.stringify({ event: 'demo.cycle.scan.completed', userId: account.userId, candidates: signals.length, executed: changed }));
      }
    } catch (error) { this.logger.error(`Demo auto cycle failed: ${error instanceof Error ? error.stack : String(error)}`); }
    finally { this.running = false; }
  }

  private tradingDayRange(at = new Date()) { const shifted = new Date(at.getTime() + 330 * 60_000); const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 330 * 60_000); return { start, end: new Date(start.getTime() + 86_400_000) }; }
}
