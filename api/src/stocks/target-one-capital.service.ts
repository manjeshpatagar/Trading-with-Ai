import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { UpstoxService } from './upstox.service';
import { CapitalReport, CapitalTrade, simulateTargetOneCapital } from './target-one-capital';

@Injectable()
export class TargetOneCapitalService {
  private readonly jobs = new Map<string, { fingerprint: string; expires: number; state: 'CALCULATING' | 'READY' | 'ERROR'; report: CapitalReport | null }>();
  constructor(private readonly broker: UpstoxService) {}
  get(userId: string, trades: CapitalTrade[]) {
    const fingerprint = createHash('sha256').update(JSON.stringify(trades.map(row => [row.id, row.instrumentKey, row.side, row.target1At, row.target1ObservedPrice, row.completedAt, row.exitPrice]))).digest('hex');
    const previous = this.jobs.get(userId);
    if (previous?.state === 'CALCULATING') return { ...previous, outdated: previous.fingerprint !== fingerprint };
    if (previous?.fingerprint === fingerprint && previous.expires > Date.now()) return { ...previous, outdated: false };
    for (const [key, value] of this.jobs) if (value.state !== 'CALCULATING' && value.expires < Date.now()) this.jobs.delete(key);
    const job: NonNullable<typeof previous> = { fingerprint, expires: Date.now() + 300_000, state: 'CALCULATING', report: null };
    this.jobs.set(userId, job);
    void simulateTargetOneCapital(trades, {
      margin: (trade, quantity) => this.broker.reportIntradayMargin(userId, trade.instrumentKey, trade.side, quantity, trade.target1ObservedPrice!),
      charges: (trade, quantity, exit) => this.broker.reportIntradayCharges(userId, trade.instrumentKey, exit ? (trade.side === 'BUY' ? 'SELL' : 'BUY') : trade.side, quantity, exit ? trade.exitPrice! : trade.target1ObservedPrice!),
    }).then(report => { job.report = report; job.state = 'READY'; job.expires = Date.now() + (report.rows.some(row => row.status === 'UNAVAILABLE') ? 30_000 : 300_000); })
      .catch(() => { job.state = 'ERROR'; job.expires = Date.now() + 30_000; });
    return { ...job, outdated: false };
  }
}
