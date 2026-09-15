import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { marketClock } from './market-clock';
import { ScannerService } from './scanner.service';

/** Scan connected accounts independently of browser visibility and trading mode. */
@Injectable()
export class MarketScannerWorkerService implements OnModuleInit {
  private readonly logger = new Logger(MarketScannerWorkerService.name);
  private readonly running = new Set<string>();
  private readonly cycles = new Map<string, { heartbeatAt: number; startedAt: number | null; completedAt: number | null; error: boolean }>();

  constructor(private readonly prisma: PrismaService, private readonly scanner: ScannerService) {}

  onModuleInit() {
    setImmediate(() => void this.monitor());
  }

  status(userId: string, at = new Date()) {
    const cycle = this.cycles.get(userId);
    const marketOpen = marketClock(at).canScan;
    const healthy = Boolean(cycle && at.getTime() - cycle.heartbeatAt < 90_000);
    const inProgress = this.running.has(userId);
    const delayed = Boolean(inProgress && cycle?.startedAt && at.getTime() - cycle.startedAt > 180_000);
    return {
      marketOpen,
      state: !marketOpen ? 'CLOSED' : !healthy ? 'RECOVERING' : delayed ? 'DELAYED' : cycle?.error ? 'RETRYING' : 'RUNNING',
      phase: inProgress ? 'SCANNING' : 'MONITORING',
      heartbeatAt: cycle ? new Date(cycle.heartbeatAt).toISOString() : null,
      completedAt: cycle?.completedAt ? new Date(cycle.completedAt).toISOString() : null,
      serverTime: at.toISOString(),
    };
  }

  @Cron('*/30 * * * * *', { timeZone: 'Asia/Kolkata' })
  async monitor(at = new Date()) {
    if (!marketClock(at).canScan) return;
    this.logger.log(JSON.stringify({ event: 'scanner.scheduler.tick', at: at.toISOString(), running: this.running.size }));
    try {
      const accounts = await this.prisma.token.findMany({ select: { userId: true } });
      await Promise.all(accounts.map(async ({ userId }) => {
        const cycle = this.cycles.get(userId) ?? { heartbeatAt: at.getTime(), startedAt: null, completedAt: null, error: false };
        cycle.heartbeatAt = at.getTime();
        this.cycles.set(userId, cycle);
        if (this.running.has(userId)) {
          this.logger.warn(JSON.stringify({ event: 'scanner.cycle.still_running', userId, elapsedMs: at.getTime() - (cycle.startedAt ?? at.getTime()) }));
          return;
        }
        this.running.add(userId);
        cycle.startedAt = at.getTime();
        cycle.error = false;
        this.logger.log(JSON.stringify({ event: 'scanner.cycle.started', userId, at: at.toISOString() }));
        try {
          // Each scheduled pass must fetch fresh data, not the previous pass's
          // 60-second cache. Concurrent requests still share the in-flight scan.
          const rows = await this.scanner.scan(userId, true);
          cycle.completedAt = Date.now();
          cycle.error = !rows.length;
          this.logger.log(JSON.stringify({ event: rows.length ? 'scanner.cycle.completed' : 'scanner.cycle.no_data', userId, rows: rows.length, durationMs: Date.now() - cycle.startedAt, nextCycleWithinMs: 30_000 }));
        } catch (error) {
          cycle.error = true;
          this.logger.warn(JSON.stringify({ event: 'scanner.cycle.failed', userId, message: error instanceof Error ? error.message : String(error), retryWithinMs: 30_000 }));
        } finally {
          this.running.delete(userId);
        }
      }));
    } catch (error) {
      this.logger.warn(JSON.stringify({ event: 'scanner.scheduler.failed', message: error instanceof Error ? error.message : String(error), retryWithinMs: 30_000 }));
    }
  }
}
