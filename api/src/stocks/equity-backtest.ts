import { Candle, IndicatorService } from './indicator.service';
import { technicalEvidence } from './technical-score';
import { completedCandles } from './market-snapshot';
import { StrategySetupService } from './strategy-setup.service';
import { RiskManagementService } from './risk-management.service';
import { PaperOrderExecutionService, simulatedMarketPrice } from './paper-order-execution.service';
import { estimateCharges } from './closed-trade-history.service';
import { marketClock, strategyDemoClock } from './market-clock';
import { LedgerTrade, summarizeLedger } from './trade-ledger';

type Setup = ReturnType<StrategySetupService['evaluate']>[number];
export type BacktestOptions = { startingEquity: number; riskPercent: number; leverage: number; slippageBps: number; spreadBps: number; minimumTechnicalScore: number;
  entryMode: 'ORIGINAL_SIGNAL' | 'CONFIRMED_RETEST' | 'TARGET1'; from?: number; to?: number };
const defaults: BacktestOptions = { startingEquity: 10000, riskPercent: .5, leverage: 5, slippageBps: 2, spreadBps: 2, minimumTechnicalScore: 60, entryMode: 'ORIGINAL_SIGNAL' };

/** Chronological replay, with the live setup/risk/fill modules and a conservative OHLC execution policy. */
export class EquityBacktest {
  constructor(private readonly setups = new StrategySetupService(), private readonly evidence = technicalEvidence) {}
  async run(instrument: { symbol: string; instrumentKey: string }, input: Candle[], configuration: Partial<BacktestOptions> = {}) {
    const config = { ...defaults, ...configuration };
    if (![config.startingEquity, config.riskPercent, config.leverage].every(value => Number.isFinite(value) && value > 0)
      || !Number.isFinite(config.slippageBps) || config.slippageBps < 0 || config.slippageBps > 100
      || !['ORIGINAL_SIGNAL', 'CONFIRMED_RETEST', 'TARGET1'].includes(config.entryMode)) throw new Error('INVALID_BACKTEST_CONFIGURATION');
    const until = config.to ?? Math.max(...input.map(bar => Date.parse(bar.time) + 300000));
    const candles = completedCandles(input, until);
    const risk = new RiskManagementService(), execution = new PaperOrderExecutionService();
    const trades: Array<LedgerTrade & { stopLoss: number; target: number; exitReason?: string; grossPnl?: number; charges?: number }> = [];
    let open: typeof trades[number] | undefined, pending: Setup | undefined, equity = config.startingEquity;
    let generated = 0, rejected = 0;
    const seen = new Set<string>();
    const adverse = (price: number, side: string, exit = false) => simulatedMarketPrice(price, exit ? side === 'BUY' ? 'SELL' : 'BUY' : side, config.slippageBps, config.spreadBps);
    const close = async (price: number, at: number, reason: string) => {
      if (!open) return;
      const result = await execution.close({ side: open.side, entryPrice: open.entryPrice!, price: adverse(price, open.side, true), quantity: open.quantity, at: new Date(at), reason });
      const charges = estimateCharges(open.entryPrice!, result.exitPrice, open.quantity, open.side).totalCharges;
      Object.assign(open, result, { status: 'CLOSED', grossPnl: result.pnl, charges, netPnl: result.pnl - charges });
      equity += open.netPnl!; open = undefined;
    };
    for (let index = 200; index < candles.length; index++) {
      const bar = candles[index], at = Date.parse(bar.time), end = at + 300000;
      if (config.from !== undefined && at < config.from) continue;
      if (open) {
        const stopped = open.side === 'BUY' ? bar.low <= open.stopLoss : bar.high >= open.stopLoss;
        const target = open.side === 'BUY' ? bar.high >= open.target : bar.low <= open.target;
        if (stopped) await close(open.side === 'BUY' ? Math.min(bar.open, open.stopLoss) : Math.max(bar.open, open.stopLoss), end, 'STOP LOSS');
        else if (target) await close(open.target, end, 'TARGET');
        else if (strategyDemoClock(new Date(end)).shouldAutoExit) await close(bar.close, end, 'End of Day Auto Exit');
        continue; // Never recycle an intrabar exit into another entry on the same bar.
      }
      if (!strategyDemoClock(new Date(at)).canEnter) continue;
      if (pending && Date.parse(pending.expiresAt) <= at) pending = undefined;
      if (!pending) {
        // The execution candle is deliberately absent from the strategy input.
        const history = candles.slice(Math.max(0, index - 400), index);
        const technical = this.evidence(new IndicatorService().calculate(history), history.at(-1)!.close);
        const candidates = this.setups.evaluate(instrument, history, at, technical.aiScore);
        generated += candidates.length;
        rejected += candidates.filter(setup => !setup.eligibleSetup).length;
        pending = candidates.find(setup => setup.eligibleSetup && technical.aiScore >= Math.max(48, config.minimumTechnicalScore)
          && setup.direction === (technical.direction > 0 ? 'BUY' : technical.direction < 0 ? 'SELL' : 'HOLD') && (config.entryMode !== 'CONFIRMED_RETEST' || setup.strategyName === 'Breakout + Retest'));
      }
      if (!pending) continue;
      const setup = pending, key = `${setup.strategyName}:${setup.direction}:${setup.marketDataTimestamp}`;
      if (seen.has(key)) { pending = undefined; continue; }
      const level = config.entryMode === 'TARGET1' ? setup.target1 : setup.referenceEntryPrice;
      const touched = setup.direction === 'BUY' ? bar.high >= level : bar.low <= level;
      if (!touched) continue;
      seen.add(key); pending = undefined;
      const fillAtOpen = setup.direction === 'BUY' ? bar.open >= level : bar.open <= level;
      const price = adverse(fillAtOpen ? bar.open : level, setup.direction);
      if (config.entryMode !== 'TARGET1' && Math.abs(price - setup.referenceEntryPrice) > Math.abs(setup.referenceEntryPrice - setup.stopLossPrice) * .5) { rejected++; continue; }
      const day = marketClock(new Date(at)).tradingDate;
      const today = trades.filter(trade => trade.exitTime && marketClock(trade.exitTime).tradingDate === day);
      const realizedPnl = today.reduce((total, trade) => total + (trade.netPnl ?? 0), 0);
      let losses = 0; for (const trade of [...today].reverse()) { if ((trade.netPnl ?? 0) >= 0) break; losses++; }
      const stop = [...today].reverse().find(trade => trade.exitReason === 'STOP LOSS');
      const admission = risk.daily({ dayStartEquity: equity - realizedPnl, realizedPnl, unrealizedPnl: 0, consecutiveLosses: losses,
        symbolEntries: trades.filter(trade => trade.entryTime && marketClock(trade.entryTime).tradingDate === day).length,
        lastStopAt: stop?.exitTime?.getTime() ?? null, at }, { maxDailyLossPercent: 3, maxCombinedLossPercent: 4, maxConsecutiveLosses: 3, maxEntriesPerSymbol: 2, stopCooldownMinutes: 15, allowReentry: true });
      const sizing = risk.size({ capital: equity, accountBalance: equity, entryPrice: price, stopLoss: setup.stopLossPrice,
        side: setup.direction, target: setup.target3, riskPercent: config.riskPercent, leverage: config.leverage });
      if (admission.length || !sizing.eligible) { rejected++; continue; }
      const fill = await execution.fill({ price, quantity: sizing.quantity, at: new Date(fillAtOpen ? at : end) });
      open = { id: String(trades.length + 1), symbol: instrument.symbol, side: setup.direction, status: 'OPEN', quantity: sizing.quantity,
        ...fill, exitPrice: null, exitTime: null, pnl: 0, netPnl: null, riskAmount: sizing.monetaryRisk, stopLoss: setup.stopLossPrice, target: setup.target3,
        entryMode: config.entryMode, configurationSnapshot: JSON.stringify({ setup, backtest: config }) };
      trades.push(open);
      // Unknown intrabar ordering: permit an adverse stop, never an entry-bar target win.
      if (setup.direction === 'BUY' ? bar.low <= open.stopLoss : bar.high >= open.stopLoss) await close(setup.direction === 'BUY' ? Math.min(bar.open, open.stopLoss) : Math.max(bar.open, open.stopLoss), end, 'STOP LOSS');
      else if (strategyDemoClock(new Date(end)).shouldAutoExit) await close(bar.close, end, 'End of Day Auto Exit');
    }
    return { configuration: config, candles: candles.length, generatedAssessments: generated, rejectedAssessmentsOrEntries: rejected,
      assumptions: ['Completed 5-minute bars; chronological evaluation', 'Stop first for ambiguous OHLC bars', 'No target profit on an intrabar entry bar', 'Configured adverse slippage and estimated charges', 'Open end-of-data positions remain running', 'No partial fills, bid/ask depth or survivorship corrections'],
      trades, performance: summarizeLedger(trades, config.startingEquity) };
  }
}
