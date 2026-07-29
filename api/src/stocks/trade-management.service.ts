import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import type { ScanRow } from './scanner.service';

const MANAGEABLE = ['ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'PARTIAL_PROFIT_BOOKED', 'TRAILING_STOP_ACTIVE', 'TARGET2_HIT'];
const STOPPED = ['STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'];

@Injectable()
export class TradeManagementService {
  private readonly logger = new Logger(TradeManagementService.name);
  constructor(private readonly prisma: PrismaService) {}

  async evaluateRows(userId: string, rows: ScanRow[]) {
    for (const row of rows) {
      try { await this.evaluate(userId, row); }
      catch (error) { this.logger.error(`Trade management skipped | ${row.symbol} | ${error instanceof Error ? error.message : String(error)}`); }
    }
  }

  private async evaluate(userId: string, row: ScanRow) {
    const trade = await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey, timeframe: row.timeframe }, include: { managementDecision: true }, orderBy: { signalTime: 'desc' } });
    if (!trade) return;
    const evidence = this.evidence(row, trade.side);
    const candleTime = row.indicators?.latestCandle?.time ? new Date(row.indicators.latestCandle.time) : new Date(row.lastUpdated);
    if (trade.managementDecision?.evaluatedCandleTime && candleTime <= trade.managementDecision.evaluatedCandleTime) return;

    if (STOPPED.includes(trade.status)) {
      if (trade.stopLossAt && candleTime <= trade.stopLossAt) return;
      const reentryStatus = evidence.reentryAllowed ? 'RE-ENTRY ALLOWED' : evidence.reversal ? 'NO RE-ENTRY' : 'WAIT';
      await this.save(trade.id, {
        status: reentryStatus,
        action: reentryStatus,
        reason: evidence.reason(reentryStatus === 'RE-ENTRY ALLOWED' ? 'A fresh confirmed setup satisfies every re-entry gate.' : reentryStatus === 'NO RE-ENTRY' ? 'The previous direction is invalidated; do not re-enter.' : 'The setup remains mixed; wait for confirmation.'),
        confidence: row.confidence,
        reentryStatus,
        trailingStop: null,
        partialProfitPercent: 0,
        evaluatedCandleTime: candleTime,
      });
      return;
    }
    if (!MANAGEABLE.includes(trade.status)) return;

    if (evidence.reversal) {
      const profitPercent = this.profit(trade.side, trade.entryPrice, row.price);
      await this.prisma.aiSignal.update({ where: { id: trade.id }, data: { status: 'AI_EXIT', completedAt: new Date(), exitPrice: row.price, profitPercent, lossPercent: Math.abs(Math.min(0, profitPercent)) } });
      await this.event(trade.id, 'AI_EXIT', row.price, profitPercent, trade.entryTriggeredAt);
      await this.save(trade.id, { status: 'AI EXIT', action: 'FULL EXIT', reason: evidence.reason('Strong reversal evidence triggered an exit before the stop loss.'), confidence: evidence.decisionConfidence, trailingStop: trade.stopLoss, partialProfitPercent: trade.managementDecision?.partialProfitPercent ?? 0, evaluatedCandleTime: candleTime });
      return;
    }

    if (trade.status === 'TARGET1_HIT') {
      if (trade.target1At && candleTime <= trade.target1At) return;
      if (evidence.strongContinuation) {
        await this.prisma.aiSignal.update({ where: { id: trade.id }, data: { status: 'TRAILING_STOP_ACTIVE', stopLoss: trade.entryPrice } });
        await this.event(trade.id, 'TRAILING_STOP_ACTIVE', trade.entryPrice, this.profit(trade.side, trade.entryPrice, row.price), trade.entryTriggeredAt);
        await this.save(trade.id, { status: 'Strong Continuation', action: 'HOLD TRADE', reason: evidence.reason('Trend remains healthy. Continue toward Target 2.'), confidence: evidence.decisionConfidence, trailingStop: trade.entryPrice, partialProfitPercent: 0, evaluatedCandleTime: candleTime });
      } else {
        await this.prisma.aiSignal.update({ where: { id: trade.id }, data: { status: 'PARTIAL_PROFIT_BOOKED', stopLoss: trade.entryPrice } });
        await this.event(trade.id, 'PARTIAL_PROFIT_BOOKED', row.price, this.profit(trade.side, trade.entryPrice, row.price), trade.entryTriggeredAt);
        await this.save(trade.id, { status: 'Partial Profit Booked', action: 'BOOK PARTIAL PROFIT', reason: evidence.reason('Momentum weakened after Target 1. Protect gains, exit 50%, and move stop to entry.'), confidence: evidence.decisionConfidence, trailingStop: trade.entryPrice, partialProfitPercent: 50, evaluatedCandleTime: candleTime });
      }
      return;
    }

    if (trade.status === 'TARGET2_HIT') {
      if (trade.target2At && candleTime <= trade.target2At) return;
      if (evidence.strongContinuation) {
        await this.prisma.aiSignal.update({ where: { id: trade.id }, data: { stopLoss: trade.target1 } });
        await this.event(trade.id, 'TRAILING_STOP_TARGET1', trade.target1, this.profit(trade.side, trade.entryPrice, row.price), trade.entryTriggeredAt);
        await this.save(trade.id, { status: 'Target 2 Continuation', action: 'HOLD TO TARGET 3', reason: evidence.reason('Trend remains strong after Target 2. Trail stop to Target 1.'), confidence: evidence.decisionConfidence, trailingStop: trade.target1, partialProfitPercent: trade.managementDecision?.partialProfitPercent ?? 0, evaluatedCandleTime: candleTime });
      } else {
        const profitPercent = this.profit(trade.side, trade.entryPrice, row.price);
        await this.prisma.aiSignal.update({ where: { id: trade.id }, data: { status: 'AI_EXIT', completedAt: new Date(), exitPrice: row.price, profitPercent } });
        await this.event(trade.id, 'AI_EXIT', row.price, profitPercent, trade.entryTriggeredAt);
        await this.save(trade.id, { status: 'AI EXIT', action: 'FULL EXIT', reason: evidence.reason('Continuation weakened after Target 2. Exit rather than risk protected gains.'), confidence: evidence.decisionConfidence, trailingStop: trade.target1, partialProfitPercent: trade.managementDecision?.partialProfitPercent ?? 0, evaluatedCandleTime: candleTime });
      }
    }
  }

  private evidence(row: ScanRow, side: string) {
    const buy = side === 'BUY', direction = buy ? 1 : -1;
    const indicators = row.indicators ?? {};
    const ema20 = Number(row.ema20), ema50 = Number(row.ema50), vwap = Number(row.vwap), rsi = Number(row.rsi);
    const histogram = Number(indicators.macd?.histogram ?? indicators.histogram), adx = Number(indicators.adx), volumeRatio = Number(indicators.volumeRatio);
    const candle = String(row.candleAnalysis?.current ?? '');
    const patterns = row.patterns ?? [];
    const aligned = direction * (ema20 - ema50) > 0 && direction * (row.price - vwap) > 0 && direction * histogram > 0 && (buy ? rsi >= 50 && rsi <= 72 : rsi <= 50 && rsi >= 28);
    const oppositePattern = buy ? /Bearish|Shooting Star|Evening/i : /Bullish|Hammer|Morning/i;
    const oppositeCandle = oppositePattern.test(candle) || patterns.some((pattern) => oppositePattern.test(pattern));
    const fakeBreakout = Boolean(row.entryValidation?.fakeBreakout);
    const reversalSignals = [oppositeCandle, fakeBreakout, direction * (ema20 - ema50) <= 0, direction * (row.price - vwap) <= 0, direction * histogram <= 0, adx < 18, volumeRatio < .55].filter(Boolean).length;
    const strongContinuation = aligned && adx > 25 && volumeRatio >= 1 && !oppositeCandle && !fakeBreakout;
    const reentryAllowed = Boolean(row.entryValidation?.breakoutConfirmed) && volumeRatio > 1 && aligned && adx > 25 && row.confidence >= 90 && Number(row.riskReward) >= 2 && !this.blocked(row, buy);
    const decisionConfidence = Math.min(99, Math.round(55 + Math.abs(reversalSignals - 3) * 7 + Math.min(20, adx / 2)));
    const reasons = [
      `${aligned ? '✔' : '✕'} EMA, VWAP, RSI and MACD ${aligned ? 'remain aligned' : 'are mixed or adverse'}.`,
      `${volumeRatio >= 1 ? '✔' : '✕'} Volume ${volumeRatio.toFixed(2)}× the 20-candle average.`,
      `${adx > 25 ? '✔' : '✕'} ADX ${adx.toFixed(1)} ${adx > 25 ? 'confirms trend strength' : 'shows weakening trend strength'}.`,
      `${oppositeCandle ? '✕' : '✔'} ${oppositeCandle ? `Opposite candle detected: ${candle}` : 'No strong reversal candle.'}`,
      `${fakeBreakout ? '✕ Fake breakout detected.' : '✔ Breakout structure remains valid.'}`,
    ];
    return { strongContinuation, reversal: reversalSignals >= 3, reentryAllowed, decisionConfidence, reason: (decision: string) => `${reasons.join(' ')} ${decision}` };
  }

  private blocked(row: ScanRow, buy: boolean) {
    const level = Number(buy ? row.indicators?.resistance : row.indicators?.support);
    if (!Number.isFinite(level)) return false;
    return Math.abs(row.price - level) / row.price < .005;
  }
  private profit(side: string, entry: number, exit: number) { return (side === 'BUY' ? exit - entry : entry - exit) / entry * 100; }
  private async event(tradeId: string, type: string, price: number, profitPercent: number, entryAt: Date | null) {
    await this.prisma.aiTradeEvent.upsert({ where: { tradeId_type: { tradeId, type } }, update: {}, create: { tradeId, type, triggerPrice: price, executedPrice: price, profitPercent, holdingMinutes: entryAt ? Math.max(0, Math.round((Date.now() - entryAt.getTime()) / 60_000)) : 0 } });
  }
  private save(tradeId: string, data: { status: string; action: string; reason: string; confidence: number; reentryStatus?: string; trailingStop: number | null; partialProfitPercent: number; evaluatedCandleTime: Date }) {
    return this.prisma.tradeManagementDecision.upsert({ where: { tradeId }, create: { tradeId, ...data }, update: data });
  }
}
