import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { ExecutionEngine } from './execution-engine.service';
import { IntradayExecutionService } from './intraday-execution.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { marketClock } from './market-clock';
import type { ScanRow } from './scanner.service';
import { matchesStatusFilter } from './signal-status-filter';

type Candidate = { instrumentKey: string; symbol: string; signal: string; confidence: number; price: number; entry?: number | null; stopLoss?: number | null; target1?: number | null; target2?: number | null; target3?: number | null };
type TriggeredSignal = { id: string; userId: string; instrumentKey: string; symbol: string; side: string; entryPrice: number; currentPrice: number; confidence: number; aiScore: number; riskReward: number; volume: number; volumeRatio: number; vwapAligned: boolean; emaAligned: boolean; ema200Aligned: boolean; volumeIncreasing: boolean; marketTrendAligned: boolean; sectorStrength: number; finalTradingScore: number; entryRsi: number; momentumScore?: number | null; signalTime: Date; status: string; stopLoss: number; target1: number; target2: number; target3: number; target1ExecutedPrice?: number | null; atr?: number | null; previousCandleLow?: number | null; previousCandleHigh?: number | null; entryTriggeredAt?: Date | null; runningAt?: Date | null; target1At?: Date | null; stopLossAt?: Date | null; completedAt?: Date | null };
const TARGET1_CONFIRMATION_CAPITAL = 10_000;
const MAX_DEMO_OPEN_TRADES = 5;
const ENTRY_MODES = ['ENTRY_TRIGGERED', 'RUNNING_CONFIRMATION', 'TARGET1_CONFIRMATION', 'TARGET2_CONTINUATION', 'AI_AUTO_SELECT'] as const;
const EXIT_MODES = ['EXIT_AT_TARGET1', 'EXIT_AT_TARGET2', 'EXIT_AT_TARGET3', 'TRAILING_STOP', 'PARTIAL_EXIT', 'TRAILING_AFTER_TARGET1', 'TRAILING_AFTER_TARGET2'] as const;
type DemoExitMode = typeof EXIT_MODES[number];

type DemoCandleDecision = {
  action: 'HOLD' | 'EXIT' | 'BOOK PROFIT' | 'TRAIL STOP' | 'REDUCE RISK';
  reason: string;
  trailingStop?: number;
  strength: 'WEAK' | 'MODERATE' | 'STRONG' | 'VERY STRONG';
  currentTarget?: number;
  timeRemainingSeconds: number;
};

@Injectable()
export class PaperTradingService {
  private readonly logger = new Logger(PaperTradingService.name);
  private readonly demoExecutionLocks = new Set<string>();
  private readonly completedDailyResets = new Map<string, string>();
  private readonly dailyResetTasks = new Map<string, Promise<void>>();
  private readonly liveMarks = new Map<string, { currentPrice: number; pnl: number; pnlPercent: number }>();
  private readonly evaluatedDemoCandles = new Map<string, number>();
  private readonly demoDecisionStates = new Map<string, DemoCandleDecision>();
  private readonly latestConfirmationRows = new Map<string, { row: ScanRow; candleTime: Date }>();
  private readonly optimizerProfiles = new Map<string, { bestStrategy?: string | null; bestSector?: string | null; bestTime?: string | null; worstStrategy?: string | null; worstSector?: string | null; worstTime?: string | null }>();
  private readonly simulationMarginProfiles = new Map<string, Promise<{ intradayMargin: number | null; intradayLeverage: number | null }>>();
  constructor(private readonly prisma: PrismaService, private readonly execution: PaperOrderExecutionService, private readonly engine: ExecutionEngine, private readonly intraday: IntradayExecutionService) {}

  async account(userId: string) {
    try {
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.initialize', userId }));
      const account = await this.prisma.paperTradingAccount.upsert({
        where: { userId },
        create: { userId, autoDemoTrading: true, startingBalance: 10_000, maxOpenTrades: 1, entryMode: 'TARGET1_CONFIRMATION', exitMode: 'EXIT_AT_TARGET3' },
        update: {},
      });
      this.logger.log(JSON.stringify({ event: 'paper.database.wallet.ready', userId, accountId: account.id, startingBalance: account.startingBalance }));
      return account;
    } catch (error) {
      this.logError('paper.database.wallet.failed', error, { userId });
      throw error;
    }
  }

  async createTrade(userId: string, row?: Candidate) {
    try {
      if (!marketClock().canEnter) {
        this.logger.warn(JSON.stringify({ event: 'paper.trade.create.rejected', userId, reason: 'New entries are disabled outside 09:15-15:15 IST' }));
        return false;
      }
      if (!row || !['BUY', 'SELL'].includes(row.signal)) {
        this.logger.warn(JSON.stringify({ event: 'paper.trade.create.rejected', userId, reason: 'Scanner candidate is unavailable' }));
        return false;
      }
      const account = await this.account(userId);
      if (!account.enabled) {
        this.logDemoSkip('Demo Trading service disabled for account', { userId, instrumentKey: row.instrumentKey });
        return false;
      }
      if (row.confidence < account.minimumConfidence) {
        this.logDemoSkip('Confidence too low', { userId, instrumentKey: row.instrumentKey, confidence: row.confidence, minimumConfidence: account.minimumConfidence });
        return false;
      }
      const now = new Date();
      await this.resetExpiredDemoState(userId, now);
      const { start, end } = this.tradingDayBounds(now);
      const active = await this.prisma.paperOrder.findMany({
        where: { userId, status: { in: ['WAITING', 'OPEN'] }, createdAt: { gte: start, lt: end } },
      });
      if (account.maxOpenTrades > 0 && active.length >= Math.min(MAX_DEMO_OPEN_TRADES, account.maxOpenTrades)) {
        this.logDemoSkip('Max trades reached', { userId, instrumentKey: row.instrumentKey, openTrades: active.length, maxOpenTrades: account.maxOpenTrades });
        return false;
      }
      const availableCapital = account.startingBalance + account.realizedPnl
        - active.reduce((sum, order) => sum + Number(order.budget), 0);
      if (availableCapital <= 0) { this.logDemoSkip('Capital unavailable', { userId, instrumentKey: row.instrumentKey, availableCapital }); return false; }
      const previous = await this.prisma.paperOrder.findFirst({
        where: { userId, instrumentKey: row.instrumentKey, createdAt: { gte: start, lt: end } },
      });
      if (previous) {
        this.logger.warn(JSON.stringify({ event: 'paper.trade.create.rejected', userId, instrumentKey: row.instrumentKey, reason: 'Instrument was already traded' }));
        return false;
      }
      const budget = Math.min(account.capitalPerTrade, availableCapital);
      const entry = Number(row.entry), stopLoss = Number(row.stopLoss), target = Number(row.target3);
      if (![entry, stopLoss, target, row.price].every(Number.isFinite) || entry <= 0) {
        this.logDemoSkip('Invalid scanner prices', { userId, instrumentKey: row.instrumentKey, entry, stopLoss, target, currentPrice: row.price });
        return false;
      }
      let sizing;
      try { sizing = await this.intraday.calculateIntradayQuantity({ userId, capital: budget, symbol: row.symbol, instrumentKey: row.instrumentKey, entryPrice: entry, stopLoss, target1: Number(row.target1 ?? target), side: row.signal as 'BUY'|'SELL', riskPerTrade: account.riskPerTrade, maxOpenTrades: account.maxOpenTrades }); }
      catch (error) { this.logDemoSkip('Intraday margin or charge calculation unavailable', { userId, instrumentKey: row.instrumentKey, reason: error instanceof Error ? error.message : String(error) }); return false; }
      if (!sizing.viable) { this.logDemoSkip(sizing.reason, { userId, instrumentKey: row.instrumentKey, ...sizing }); return false; }
      await this.prisma.paperOrder.create({ data: { userId, instrumentKey: row.instrumentKey, symbol: row.symbol, side: row.signal, product: sizing.product, productType: sizing.productType, confidence: row.confidence, quantity: sizing.finalQuantity, budget: sizing.requiredIntradayMargin, plannedEntry: entry, currentPrice: row.price, investment: sizing.notionalValue, notionalValue: sizing.notionalValue, requiredIntradayMargin: sizing.requiredIntradayMargin, availableCapitalAtEntry: availableCapital, marginPerShare: sizing.marginPerShare, maximumMarginQuantity: sizing.marginBasedQuantity, riskAmount: sizing.maximumRisk, riskPerShare: sizing.riskPerShare, riskBasedQuantity: sizing.riskBasedQuantity, estimatedCharges: sizing.estimatedCharges, expectedGrossProfit: sizing.expectedGrossProfit, expectedNetProfit: sizing.expectedNetProfit, target, target1: row.target1, target2: row.target2, stopLoss } });
      this.logger.log(JSON.stringify({ event: 'paper.trade.created', userId, symbol: row.symbol, side: row.signal, product: 'I', quantity: sizing.finalQuantity, requiredIntradayMargin: sizing.requiredIntradayMargin, notionalValue: sizing.notionalValue, plannedEntry: entry }));
      return true;
    } catch (error) { this.logError('paper.trade.create.failed', error, { userId }); return false; }
  }

  async captureTriggeredDemoSignals(userId: string, trades: TriggeredSignal[], at = new Date()) {
    await this.resetExpiredDemoState(userId, at);
    const account = await this.account(userId);
    for (const trade of trades) {
      this.logger.log(JSON.stringify({
        event: 'demo.signal.received',
        message: '[Paper] Signal received',
        userId,
        signalId: trade.id,
        symbol: trade.symbol,
        status: trade.status,
        entryTriggeredAt: trade.entryTriggeredAt ?? null,
      }));
    }
    if (!account.autoDemoTrading) {
      this.logDemoSkip('Auto trading disabled', { userId, receivedSignals: trades.length });
      await this.recordGlobalSkips(userId, 'Auto trading disabled', at, account);
      return false;
    }
    const changed = await this.drainDemoQueue(userId, at);
    this.logger.log(JSON.stringify({ event: 'demo.capture.completed', userId, receivedSignals: trades.length, changed }));
    return changed;
  }

  /** Called after each scanner candle so persisted Target1 candidates are recovered. */
  async evaluateCandleRows(userId: string, rows: ScanRow[], at = new Date()) {
    await this.resetExpiredDemoState(userId, at);
    for (const row of rows) {
      const candleTime = this.candleTime(row, at);
      this.latestConfirmationRows.set(`${userId}:${row.instrumentKey}`, { row, candleTime });
    }
    const entryChanged = await this.drainDemoQueue(userId, at);
    let positionChanged = false;
    for (const row of rows) {
      const orders = await this.prisma.paperOrder.findMany({
        where: { userId, instrumentKey: row.instrumentKey, status: 'OPEN' },
      });
      for (const order of orders) {
        const candleTime = this.candleTime(row, at);
        if ((this.evaluatedDemoCandles.get(order.id) ?? 0) >= candleTime.getTime()) continue;
        this.evaluatedDemoCandles.set(order.id, candleTime.getTime());
        const signal = order.signalId
          ? await this.prisma.aiSignal.findUnique({ where: { id: order.signalId } })
          : await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey: row.instrumentKey }, orderBy: { signalTime: 'desc' } });
        const decision = this.demoDecision(order, signal, row, at);
        this.demoDecisionStates.set(order.id, decision);
        if (order.strategy !== 'Target 1 Confirmation' && decision.trailingStop != null && this.improvesStop(order.side, Number(order.stopLoss), decision.trailingStop)) {
          await this.prisma.paperOrder.update({
            where: { id: order.id },
            data: { stopLoss: decision.trailingStop, currentPrice: row.price },
          });
          order.stopLoss = decision.trailingStop;
          positionChanged = true;
          if (Number(decision.trailingStop) === Number(order.entryPrice)) {
            await this.recordVoice(userId, order.id, 'STOP_MOVED_BREAKEVEN', order.symbol, 'STOP LOSS UPDATED', 'Stop Loss moved to breakeven.');
          }
        }
        if (order.strategy !== 'Target 1 Confirmation' && ['EXIT', 'BOOK PROFIT'].includes(decision.action)) {
          await this.close(order.id, row.price, decision.reason, at);
          positionChanged = true;
        } else {
          this.markOpenOrder(order, row.price);
          this.logger.log(JSON.stringify({
            event: 'demo.trade.candle.decision',
            userId,
            orderId: order.id,
            symbol: order.symbol,
            action: decision.action,
            reason: decision.reason,
            trailingStop: decision.trailingStop ?? order.stopLoss,
            candleTime,
          }));
        }
      }
    }
    return entryChanged || positionChanged;
  }

  async drainDemoQueue(userId: string, at = new Date()) {
    if (this.demoExecutionLocks.has(userId)) {
      this.logDemoSkip('Queue blocked: execution already in progress', { userId });
      return false;
    }
    this.demoExecutionLocks.add(userId);
    let changed = false;
    try {
      const account = await this.account(userId);
      if (!account.autoDemoTrading) {
        this.logDemoSkip('Auto trading disabled', { userId });
        await this.recordGlobalSkips(userId, 'Auto trading disabled', at, account);
        return false;
      }
      if (!account.enabled) {
        this.logDemoSkip('Demo Trading service disabled for account', { userId });
        await this.recordGlobalSkips(userId, 'Demo Trading disabled', at, account);
        return false;
      }
      const clock = marketClock(at);
      if (!clock.canEnter) {
        this.logDemoSkip('Signal expired or market entry window closed', { userId, marketStatus: clock.status, at });
        await this.recordGlobalSkips(userId, 'Market is closed', at, account);
        return false;
      }
      this.logger.log(JSON.stringify({ event: 'demo.validation.started', message: '[Demo] Queue check passed', userId }));
      const { start, end } = this.tradingDayBounds(at);
      changed = await this.executeUnlimitedSignals(userId, start, end, at);
      this.logger.log(JSON.stringify({ event: 'demo.queue.drained', userId, changed, at }));
      return changed;
    } finally {
      this.demoExecutionLocks.delete(userId);
    }
  }

  async processTick(userId: string, instrumentKey: string, price: number, at = new Date()) {
    try {
      await this.resetExpiredDemoState(userId, at);
      const account = await this.prisma.paperTradingAccount.findUnique({ where: { userId } });
      if (!account?.enabled) {
        this.logDemoSkip('Demo Trading service disabled or account missing', { userId, instrumentKey });
        return false;
      }
      if (!Number.isFinite(price) || price <= 0) {
        this.logDemoSkip('Invalid tick price', { userId, instrumentKey, price });
        return false;
      }
      const orders = await this.prisma.paperOrder.findMany({ where: { userId, instrumentKey, status: { in: ['WAITING', 'OPEN'] } } });
      let changed = false;
      let capitalReleased = false;
      for (const order of orders) {
        this.logger.log(JSON.stringify({ event: 'demo.tick.received', message: '[Demo Tick]', userId, orderId: order.id, symbol: order.symbol, instrumentKey, livePrice: price, at }));
        if (order.status === 'WAITING') {
          const reached = order.side === 'BUY' ? price >= order.plannedEntry : price <= order.plannedEntry;
          const marketValue = price * order.quantity;
          await this.retryWrite(() => this.prisma.paperOrder.update({ where: { id: order.id }, data: { currentPrice: price, marketValue } }));
          changed = true;
          if (!marketClock(at).canEnter || !reached) continue;
          const fill = await this.execution.fill({ price, quantity: order.quantity, at });
          await this.retryWrite(() => this.prisma.paperOrder.update({ where: { id: order.id }, data: { status: 'OPEN', tradeStage: 'RUNNING', currentPrice: price, marketValue, ...fill } }));
          continue;
        }

        const entryPrice = Number(order.entryPrice);
        const quantity = Number(order.remainingQuantity ?? order.quantity);
        const openPnl = (order.side === 'BUY' ? price - entryPrice : entryPrice - price) * quantity;
        const pnl = Number(order.partialRealizedPnl ?? 0) + openPnl;
        const pnlPercent = entryPrice && order.quantity ? pnl / (entryPrice * order.quantity) * 100 : 0;
        const marketValue = price * quantity;
        const holdingDuration = order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0;
        const linked = order.signalId
          ? await this.prisma.aiSignal.findUnique({ where: { id: order.signalId }, include: { stopLossDecision: true, managementDecision: true } })
          : await this.prisma.aiSignal.findFirst({ where: { userId, instrumentKey }, include: { stopLossDecision: true, managementDecision: true }, orderBy: { signalTime: 'desc' } });
        const target1 = Number(order.target1 ?? linked?.target1);
        const target2 = Number(order.target2 ?? linked?.target2);
        const target3 = Number(order.target);
        const crossed = (level: number) => Number.isFinite(level) && (order.side === 'BUY' ? price >= level : price <= level);
        const target1Hit = crossed(target1);
        const target2Hit = crossed(target2);
        const target3Hit = crossed(target3);
        const initialStop = Number(order.initialStopLoss ?? order.stopLoss);
        let dynamicStop = Number(order.trailingStop ?? order.stopLoss);
        const configuredExitMode = (EXIT_MODES.includes(account.exitMode as DemoExitMode) ? account.exitMode : 'EXIT_AT_TARGET3') as DemoExitMode;
        if (target1Hit && ['TRAILING_STOP', 'PARTIAL_EXIT', 'TRAILING_AFTER_TARGET1'].includes(configuredExitMode)) {
          dynamicStop = order.side === 'BUY' ? Math.max(dynamicStop, entryPrice) : Math.min(dynamicStop, entryPrice);
        }
        if (target2Hit) {
          dynamicStop = order.side === 'BUY' ? Math.max(dynamicStop, target1) : Math.min(dynamicStop, target1);
        }
        const stopLossHit = order.side === 'BUY' ? price <= dynamicStop : price >= dynamicStop;
        const [squareHour, squareMinute] = String(account.squareOffTime ?? '15:15').split(':').map(Number);
        const squareOff = this.istSeconds(at) >= (squareHour * 60 + squareMinute) * 60;
        const tradeStage = target3Hit ? 'TARGET3_HIT' : target2Hit ? 'TARGET2_HIT' : 'TARGET1_CONFIRMED';

        await this.retryWrite(() => this.prisma.paperOrder.update({
          where: { id: order.id },
          data: { currentPrice: price, marketValue, pnl, pnlPercent, unrealizedPnl: pnl, unrealizedPnlPercent: pnlPercent, durationMinutes: holdingDuration, tradeStage, stopLoss: dynamicStop, trailingStop: dynamicStop, target2HitAt: target2Hit ? order.target2HitAt ?? at : order.target2HitAt, target3HitAt: target3Hit ? order.target3HitAt ?? at : order.target3HitAt },
        }));
        if (tradeStage !== order.tradeStage) {
          const stageRank: Record<string, number> = { TARGET1_CONFIRMED: 1, TARGET2_HIT: 2, TARGET3_HIT: 3 };
          const previousRank = stageRank[order.tradeStage] ?? 0;
          if (target2Hit && previousRank < 2) {
            if (linked) await this.recordExecutionDecision(linked, 'TARGET2', 'Target2 reached; stop moved to breakeven', account.startingBalance + account.realizedPnl - marketValue, order.budget, at);
            await this.recordVoice(userId, order.id, 'TARGET2_REACHED', order.symbol, 'TARGET TWO REACHED', 'Target Two Reached');
          }
          if (target3Hit && previousRank < 3) {
            if (linked) await this.recordExecutionDecision(linked, 'TARGET3', 'Target3 reached', account.startingBalance + account.realizedPnl - marketValue, order.budget, at);
            await this.recordVoice(userId, order.id, 'TRAILING_STOP_ACTIVATED', order.symbol, 'TRAILING STOP ACTIVATED', 'Trailing Stop Activated');
            await this.recordVoice(userId, order.id, 'TARGET3_REACHED', order.symbol, 'TRADE COMPLETED', 'Target Three reached');
          }
        }
        this.liveMarks.set(order.id, { currentPrice: price, pnl, pnlPercent });
        changed = true;
        this.logger.log(JSON.stringify({ event: 'demo.position.updated', message: '[Demo Position Updated]', userId, orderId: order.id, symbol: order.symbol, entryPrice, currentPrice: price, marketValue, pnl, pnlPercent, holdingDuration }));
        const exitMode = configuredExitMode;
        const targetExitReason = this.targetExitReason(exitMode, target1Hit, target2Hit, target3Hit);
        this.logger.log(JSON.stringify({ event: 'demo.target.check', message: '[Target Check]', userId, tradeId: order.id, symbol: order.symbol, currentPrice: price, entry: entryPrice, target1, target2, target3, exitMode, targetHit: target3Hit ? 'TARGET_3' : target2Hit ? 'TARGET_2' : target1Hit ? 'TARGET_1' : null, exitTriggered: Boolean(targetExitReason), databaseUpdated: true, capitalReleased: false, websocketSent: false, uiUpdated: false, tradeStage }));
        this.logger.log(JSON.stringify({ event: 'demo.stoploss.check', message: '[Stop Loss Check]', userId, orderId: order.id, symbol: order.symbol, side: order.side, livePrice: price, stopLoss: order.stopLoss, stopLossHit }));

        if (exitMode === 'PARTIAL_EXIT' && !target3Hit) {
          const desiredExited = target2Hit ? Math.floor(Number(order.quantity) * .8) : target1Hit ? Math.floor(Number(order.quantity) * .5) : 0;
          const alreadyExited = Number(order.partialExitQuantity ?? 0);
          const partialQuantity = Math.min(quantity - 1, Math.max(0, desiredExited - alreadyExited));
          if (partialQuantity > 0) {
            await this.partialExit(order.id, price, partialQuantity, target2Hit ? target1 : entryPrice, at);
            this.logger.log(JSON.stringify({ event: 'demo.trade.partial-exit', userId, tradeId: order.id, rankingScore: order.rankScore, entryReason: order.entryType, exitReason: target2Hit ? 'TARGET_2_PARTIAL_30' : 'TARGET_1_PARTIAL_50', targetHit: target2Hit ? 'TARGET_2' : 'TARGET_1', trailingStopMovement: target2Hit ? target1 : entryPrice, capitalReleased: true, databaseUpdated: true, executionTime: at }));
          }
        }
        const maximumHoldingHit = holdingDuration >= Number(account.maximumHoldingMinutes ?? 180);
        const exitReason = targetExitReason ?? (stopLossHit ? (dynamicStop !== initialStop ? 'TRAILING_STOP' : 'STOPLOSS') : maximumHoldingHit ? 'MAXIMUM_HOLDING_TIME' : squareOff ? `TIME EXIT ${account.squareOffTime}` : null);
        if (exitReason) {
          if (linked && stopLossHit) await this.recordExecutionDecision(linked, 'STOPLOSS', 'Stop loss reached', account.startingBalance + account.realizedPnl - marketValue, order.budget, at);
          await this.close(order.id, price, exitReason, at);
          capitalReleased = true;
          this.logger.log(JSON.stringify({ event: 'demo.trade.closed', message: '[Trade Closed]', userId, tradeId: order.id, symbol: order.symbol, exitPrice: price, exitReason, realizedPnl: pnl, exitTriggered: true, databaseUpdated: true, capitalReleased: true, websocketSent: false, uiUpdated: false, completedAt: at }));
        }
      }
      if (capitalReleased) await this.drainDemoQueue(userId, at);
      return changed;
    } catch (error) { this.logError('paper.portfolio.tick.failed', error, { userId, instrumentKey, price }); return false; }
  }

  async manualExit(userId: string, orderId: string) {
    try {
      const order = await this.prisma.paperOrder.findFirst({ where: { id: orderId, userId, status: 'OPEN' } });
      if (!order) { this.logger.warn(JSON.stringify({ event: 'paper.trade.exit.skipped', userId, orderId, reason: 'Open position not found' })); return false; }
      await this.close(order.id, this.liveMarks.get(order.id)?.currentPrice ?? order.currentPrice, 'MANUAL EXIT', new Date());
      await this.drainDemoQueue(userId);
      return true;
    } catch (error) { this.logError('paper.trade.exit.failed', error, { userId, orderId }); return false; }
  }

  async closeAllEod(at = new Date()) {
    const orders = await this.prisma.paperOrder.findMany({ where: { status: 'OPEN' } });
    let closed = 0;
    for (const order of orders) {
      const price = Number(this.liveMarks.get(order.id)?.currentPrice ?? order.currentPrice);
      if (!Number.isFinite(price) || price <= 0) {
        this.logger.error(JSON.stringify({ event: 'eod.paper.price.invalid', orderId: order.id, instrumentKey: order.instrumentKey, price }));
        continue;
      }
      await this.close(order.id, price, 'End of Day Auto Exit', at, 'CLOSED - EOD EXIT');
      closed += 1;
    }
    await this.prisma.paperOrder.updateMany({
      where: { status: 'WAITING' },
      data: { status: 'CLOSED - EOD EXIT', exitTime: at, exitReason: 'End of Day Auto Exit', pnl: 0, pnlPercent: 0, durationMinutes: 0 },
    });
    for (const userId of [...new Set(orders.map((order) => order.userId))]) await this.optimizeDemoStrategy(userId, at);
    return closed;
  }

  async updateSettings(userId: string, input: Record<string, unknown>) {
    try {
    const current = await this.account(userId);
    const data = {
      enabled: typeof input.enabled === 'boolean' ? input.enabled : current.enabled,
      autoDemoTrading: typeof input.autoDemoTrading === 'boolean' ? input.autoDemoTrading : current.autoDemoTrading,
      startingBalance: this.range(input.startingBalance, 1000, 10_000_000, current.startingBalance),
      maxOpenTrades: Math.round(this.range(input.maxOpenTrades, 0, MAX_DEMO_OPEN_TRADES, current.maxOpenTrades)),
      minimumConfidence: this.range(input.minimumConfidence, 0, 100, current.minimumConfidence),
      riskPerTrade: this.range(input.riskPerTrade, .1, 20, current.riskPerTrade),
      capitalPerTrade: this.range(input.capitalPerTrade, 1000, 10_000_000, current.capitalPerTrade),
      minimumRiskReward: this.range(input.minimumRiskReward, 0, 20, current.minimumRiskReward),
      allowAiWait: typeof input.allowAiWait === 'boolean' ? input.allowAiWait : current.allowAiWait,
      allowReentry: typeof input.allowReentry === 'boolean' ? input.allowReentry : current.allowReentry,
      voiceAlerts: typeof input.voiceAlerts === 'boolean' ? input.voiceAlerts : current.voiceAlerts,
      voiceVolume: Math.round(this.range(input.voiceVolume, 0, 100, current.voiceVolume)),
      voiceSpeed: this.range(input.voiceSpeed, .5, 2, current.voiceSpeed),
      voicePitch: this.range(input.voicePitch, .5, 2, current.voicePitch),
      voiceLanguage: ['en-IN', 'en-US', 'hi-IN'].includes(String(input.voiceLanguage)) ? String(input.voiceLanguage) : current.voiceLanguage,
      entryMode: ENTRY_MODES.includes(String(input.entryMode) as typeof ENTRY_MODES[number]) ? String(input.entryMode) : current.entryMode,
      exitMode: EXIT_MODES.includes(String(input.exitMode) as DemoExitMode) ? String(input.exitMode) : current.exitMode,
      maximumHoldingMinutes: Math.round(this.range(input.maximumHoldingMinutes, 15, 360, current.maximumHoldingMinutes)),
      minimumDailyTrades: Math.round(this.range(input.minimumDailyTrades, 0, 10, current.minimumDailyTrades)),
      preferredDailyTrades: Math.round(this.range(input.preferredDailyTrades, 1, 10, current.preferredDailyTrades)),
      maximumDailyTrades: Math.round(this.range(input.maximumDailyTrades, 1, 10, current.maximumDailyTrades)),
      maximumDailyLoss: this.range(input.maximumDailyLoss, 0, 10_000_000, current.maximumDailyLoss),
      maximumDailyProfit: this.range(input.maximumDailyProfit, 0, 10_000_000, current.maximumDailyProfit),
      squareOffTime: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.squareOffTime)) ? String(input.squareOffTime) : current.squareOffTime,
    };
    const updated = await this.prisma.paperTradingAccount.update({ where: { userId }, data });
    if (current.maxOpenTrades !== 0 && updated.maxOpenTrades === 0) {
      await this.prisma.demoTradeQueue.updateMany({
        where: { userId, status: 'WAITING_FOR_CAPITAL' },
        data: { status: 'REJECTED', rejectedAt: new Date(), rejectReason: 'Unlimited mode executes signals directly' },
      });
    }
    if (updated.autoDemoTrading) {
      const triggered = await this.prisma.aiSignal.findMany({ where: { userId, status: { in: ['RUNNING', 'TARGET1_HIT'] }, entryTriggeredAt: { not: null }, stopLossAt: null, completedAt: null } });
      await this.captureTriggeredDemoSignals(userId, triggered);
    }
    return updated;
    } catch (error) { this.logError('paper.database.settings.failed', error, { userId }); return this.defaultAccount(userId); }
  }

  async dashboard(userId: string) {
    try {
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.start', userId }));
    const now = new Date();
    await this.resetExpiredDemoState(userId, now);
    const account = await this.account(userId);
    const { start, end } = this.tradingDayBounds(now);
    const storedOrders = await this.prisma.paperOrder.findMany({
      where: { userId, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const executionDecisions = await this.prisma.demoExecutionDecision.findMany({
      where: { userId, createdAt: { gte: start, lt: end } }, orderBy: { createdAt: 'desc' }, take: 200,
    });
    const orders = storedOrders.map((order) => {
      const mark = this.liveMarks.get(order.id);
      const decision = this.demoDecisionStates.get(order.id);
      const live = mark && ['WAITING', 'OPEN'].includes(order.status) ? { ...order, ...mark } : order;
      return decision ? {
        ...live,
        trailingStop: decision.trailingStop ?? order.stopLoss,
        aiDecision: decision.action,
        decisionReason: decision.reason,
        strength: decision.strength,
        currentTarget: decision.currentTarget ?? order.target,
        timeRemainingSeconds: decision.timeRemainingSeconds,
      } : live;
    });
    const clock = marketClock(now);
    const eodRuns = await this.prisma.eodRiskRun.findMany({ where: { tradingDate: clock.tradingDate, userId: { in: ['ALL', userId] } }, orderBy: { startedAt: 'desc' } });
    const riskManager = { ...clock, status: eodRuns.some((run) => run.status === 'RUNNING') ? 'AUTO EXIT RUNNING' : clock.status, alert: eodRuns.find((run) => run.status === 'FAILED')?.alert ?? null };
    const openPositions = orders.filter((order) => order.status === 'OPEN');
    const waitingOrders = orders.filter((order) => order.status === 'WAITING');
    const closedTrades = orders.filter((order) => order.status === 'COMPLETED' || order.status.startsWith('CLOSED'));
    const closedToday = closedTrades.filter((order) => order.exitTime && order.exitTime >= start && order.exitTime < end);
    const usedCapital = openPositions.reduce((sum, order) => sum + Number(order.budget), 0);
    const virtualBalance = account.startingBalance + account.realizedPnl;
    const unrealizedPnl = openPositions.reduce((sum, order) => sum + order.pnl, 0);
    const wins = closedToday.filter((order) => order.pnl > 0), losses = closedToday.filter((order) => order.pnl < 0);
    const sum = (items: typeof closedTrades) => items.reduce((total, order) => total + order.pnl, 0);
    const average = (items: typeof closedTrades) => items.length ? sum(items) / items.length : 0;
    const target1Hits = await this.prisma.aiSignal.count({ where: { userId, target1At: { gte: start, lt: end } } });
    const strategyOrders = orders.filter((order) => order.strategy === 'Target 1 Confirmation');
    const strategyClosed = strategyOrders.filter((order) => order.status === 'COMPLETED' || order.status.startsWith('CLOSED'));
    const strategyWins = strategyClosed.filter((order) => order.pnl > 0);
    const grossProfit = strategyWins.reduce((total, order) => total + order.pnl, 0);
    const grossLoss = Math.abs(strategyClosed.filter((order) => order.pnl < 0).reduce((total, order) => total + order.pnl, 0));
    const target1ConfirmationStatistics = {
      todayTarget1Hits: target1Hits,
      tradesExecuted: strategyOrders.length,
      target2Hits: strategyOrders.filter((order) => order.target2HitAt).length,
      target3Hits: strategyOrders.filter((order) => order.target3HitAt).length,
      trailingStopExits: strategyClosed.filter((order) => /TRAILING STOP/i.test(order.exitReason ?? '')).length,
      stopLossExits: strategyClosed.filter((order) => /STOP\s?LOSS/i.test(order.exitReason ?? '')).length,
      winRate: strategyClosed.length ? strategyWins.length / strategyClosed.length * 100 : 0,
      averageProfit: strategyWins.length ? grossProfit / strategyWins.length : 0,
      averageHoldingTime: strategyClosed.length ? strategyClosed.reduce((total, order) => total + Number(order.durationMinutes ?? 0), 0) / strategyClosed.length : 0,
      profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit > 0 ? grossProfit : 0,
    };
    const todaySignals = await this.prisma.aiSignal.findMany({ where: { userId, signalTime: { gte: start, lt: end } }, orderBy: { confidence: 'desc' } });
    const candidates = todaySignals
      .filter((signal) => Boolean(signal.target1At))
      .map((signal) => ({ signal, evaluation: this.evaluateTarget1Candidate(signal) }))
      .sort((left, right) => right.evaluation.score - left.evaluation.score)
      .slice(0, 10)
      .map(({ signal, evaluation }, index) => ({ rank: index + 1, signalId: signal.id, stock: signal.symbol, side: signal.side, confidence: signal.confidence, aiScore: signal.aiScore, riskReward: signal.riskReward, currentPrice: signal.currentPrice, target1Time: signal.target1At, target2Probability: Math.min(95, Math.round(evaluation.score * .9)), target3Probability: Math.min(90, Math.round(evaluation.score * .75)), historicalSuccess: 70, entryQuality: evaluation.quality, finalScore: evaluation.score, decision: evaluation.ready ? 'QUALIFIED' : evaluation.reason }));
    const skipped = executionDecisions.filter((item) => item.decision === 'SKIPPED');
    const skipReasonCounts = new Map<string, number>();
    for (const item of skipped) skipReasonCounts.set(item.reason, (skipReasonCounts.get(item.reason) ?? 0) + 1);
    const signalsFound = todaySignals.filter((signal) => Boolean(signal.target1At)).length;
    const signalsExecuted = new Set(orders.map((order) => order.signalId).filter(Boolean)).size;
    const qualifiedSignalIds = new Set(executionDecisions.filter((item) => ['VALIDATED', 'EXECUTED', 'BUY'].includes(item.decision)).map((item) => item.signalId));
    const qualifiedSignals = qualifiedSignalIds.size;
    const qualifiedExecutedSignals = new Set(orders.map((order) => order.signalId).filter((id): id is string => Boolean(id) && qualifiedSignalIds.has(id!))).size;
    const signalById = new Map(todaySignals.map((signal) => [signal.id, signal]));
    const averageEntryDelay = strategyOrders.length ? strategyOrders.reduce((total, order) => { const signal = order.signalId ? signalById.get(order.signalId) : null; return total + (signal && order.entryTime ? Math.max(0, order.entryTime.getTime() - signal.signalTime.getTime()) / 1000 : 0); }, 0) / strategyOrders.length : 0;
    const averageSlippage = strategyOrders.length ? strategyOrders.reduce((total, order) => total + Math.abs(Number(order.entryPrice ?? order.plannedEntry) - Number(order.plannedEntry)), 0) / strategyOrders.length : 0;
    const grossDailyProfit = sum(wins), grossDailyLoss = Math.abs(sum(losses));
    const liveProfitFactor = grossDailyLoss ? grossDailyProfit / grossDailyLoss : grossDailyProfit > 0 ? grossDailyProfit : 0;
    const expectancy = closedToday.length ? sum(closedToday) / closedToday.length : 0;
    let equity = 0, peak = 0, maximumDrawdown = 0;
    for (const order of [...closedToday].sort((a, b) => Number(a.exitTime) - Number(b.exitTime))) { equity += Number(order.pnl); peak = Math.max(peak, equity); maximumDrawdown = Math.max(maximumDrawdown, peak - equity); }
    const capitalUtilization = account.startingBalance ? usedCapital / account.startingBalance * 100 : 0;
    const v2Statistics = {
      todayQualifiedSignals: candidates.filter((item) => item.decision === 'QUALIFIED').length,
      target1Confirmed: todaySignals.filter((signal) => Boolean(signal.target1At)).length,
      waitingConfirmation: candidates.filter((item) => item.decision === 'Waiting Confirmation Candle').length,
      confirmationFailed: skipped.filter((item) => /Trend|VWAP|EMA|Volume|Reversal|Expired|Quality/i.test(item.reason)).length,
      executedTrades: orders.length,
      skippedTrades: skipped.length,
      partialProfit: orders.filter((order) => order.partialExitAt).length,
      target3Completed: orders.filter((order) => order.target3HitAt).length,
      trailingStops: orders.filter((order) => order.trailingStop != null).length,
      currentOpenTrades: openPositions.length,
    };
    const executionStatistics = {
      signalsFound,
      qualifiedSignals,
      signalsExecuted,
      signalsSkipped: new Set(skipped.map((item) => item.signalId)).size,
      executionPercentage: signalsFound ? signalsExecuted / signalsFound * 100 : 0,
      executionRate: qualifiedSignals ? qualifiedExecutedSignals / qualifiedSignals * 100 : 0,
      averageProfit: average(wins),
      averageLoss: Math.abs(average(losses)),
      executionAccuracy: signalsFound ? signalsExecuted / signalsFound * 100 : 0,
      capitalUtilization,
      averageEntryDelay,
      averageExecutionDelayMs: averageEntryDelay * 1000,
      averageExitDelay: 0,
      averageHolding: closedToday.length ? closedToday.reduce((total, order) => total + Number(order.durationMinutes ?? 0), 0) / closedToday.length : 0,
      averageSlippage,
      liveProfitFactor,
      expectancy,
      maximumDrawdown,
      recoveryRate: maximumDrawdown ? Math.max(0, sum(closedToday)) / maximumDrawdown : sum(closedToday) > 0 ? sum(closedToday) : 0,
      skipReasons: [...skipReasonCounts].map(([reason, count]) => ({ reason, count })).sort((left, right) => right.count - left.count),
    };
    // The portfolio endpoint is session-scoped. Historical simulation data is
    // available only through capitalSimulation(), which is explicitly mode-aware.
    const backtest = this.target1Backtest(todaySignals);
    if (clock.shouldAutoExit) await this.optimizeDemoStrategy(userId, now);
    const optimizer = await this.prisma.demoStrategyOptimizer.findFirst({ where: { userId }, orderBy: { tradingDate: 'desc' } });
    const response = {
      account,
      summary: { virtualBalance, usedCapital, availableCapital: Math.max(0, virtualBalance - usedCapital), todayPnl: sum(closedToday) + unrealizedPnl, openPositions: openPositions.length, closedTrades: closedToday.length, winRate: closedToday.length ? wins.length / closedToday.length * 100 : 0 },
      performance: { todayProfit: sum(wins), todayLoss: Math.abs(sum(losses)), winningTrades: wins.length, losingTrades: losses.length, averageProfit: average(wins), averageLoss: Math.abs(average(losses)), profitFactor: liveProfitFactor, expectancy, maximumDrawdown, capitalUtilization, largestWin: wins.length ? Math.max(...wins.map((order) => order.pnl)) : 0, largestLoss: losses.length ? Math.abs(Math.min(...losses.map((order) => order.pnl))) : 0 },
      openPositions, waitingOrders, tradeHistory: closedTrades, executionDecisions, executionLog: executionDecisions, executionStatistics, target1ConfirmationStatistics, v2Statistics, bestEntryCandidates: candidates, backtest, optimizer,
      riskManager,
    };
    const safe = this.sanitize(response);
    this.logger.log(JSON.stringify({ event: 'paper.portfolio.load.success', userId, openPositions: openPositions.length, waitingOrders: waitingOrders.length, history: closedTrades.length, usedCapital: safe.summary.usedCapital, availableCapital: safe.summary.availableCapital }));
    const portfolioSummary = { profit: safe.performance.todayProfit, loss: safe.performance.todayLoss, roi: account.startingBalance ? safe.summary.todayPnl / account.startingBalance * 100 : 0 };
    return { ...safe, balance: safe.summary.virtualBalance, usedCapital: safe.summary.usedCapital, availableCapital: safe.summary.availableCapital, positions: safe.openPositions, history: safe.tradeHistory, summary: { ...safe.summary, ...portfolioSummary } };
    } catch (error) {
      this.logError('paper.portfolio.load.failed', error, { userId });
      return this.emptyPortfolio(userId);
    }
  }

  async voiceCenter(userId: string) {
    const account = await this.account(userId);
    const alerts = await this.prisma.paperVoiceAlert.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 200 });
    return {
      settings: { voiceAlerts: account.voiceAlerts, voiceVolume: account.voiceVolume, voiceSpeed: account.voiceSpeed, voicePitch: account.voicePitch, voiceLanguage: account.voiceLanguage },
      pending: alerts.filter((alert) => alert.status === 'PENDING').reverse(),
      executionLog: alerts,
    };
  }

  async acknowledgeVoice(userId: string, id: string, status: 'SPOKEN' | 'TOASTED') {
    return this.retryWrite(() => this.prisma.paperVoiceAlert.updateMany({ where: { id, userId, status: 'PENDING' }, data: { status, spokenAt: new Date() } }));
  }

  async recordVoice(userId: string, tradeId: string, eventName: string, symbol: string, title: string, message: string, payload: Record<string, unknown> = {}) {
    try {
      await this.prisma.paperVoiceAlert.create({ data: { userId, tradeId, eventName, symbol, title, message, payload: JSON.stringify(payload) } });
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'P2002')) this.logger.warn(JSON.stringify({ event: 'paper.voice.outbox.failed', userId, tradeId, eventName, reason: error instanceof Error ? error.message : String(error) }));
    }
  }

  private async close(orderId: string, price: number, reason: string, at: Date, status = 'COMPLETED') {
    try {
    const order = await this.prisma.paperOrder.findUniqueOrThrow({ where: { id: orderId } });
    const remainingQuantity = Number(order.remainingQuantity ?? order.quantity);
    const result = await this.execution.close({ side: order.side, entryPrice: Number(order.entryPrice), price, quantity: remainingQuantity, reason, at });
    const grossPnl = Number(order.partialRealizedPnl ?? 0) + result.pnl;
    let charges = Number(order.estimatedCharges ?? 0);
    try { charges = (await this.intraday.estimateRoundTripCharges(order.userId, order.instrumentKey, order.side as 'BUY'|'SELL', Number(order.quantity), Number(order.entryPrice), price)).total; } catch (error) { this.logger.warn(JSON.stringify({ event:'demo.exit.charges.fallback',orderId,estimatedCharges:charges,reason:error instanceof Error?error.message:String(error) })); }
    const totalPnl = grossPnl - charges;
    const totalPercent = order.entryPrice && order.quantity ? totalPnl / (Number(order.entryPrice) * Number(order.quantity)) * 100 : 0;
    await this.prisma.$transaction([
      this.prisma.paperOrder.update({ where: { id: order.id }, data: { status, tradeStage: reason, currentPrice: price, marketValue: 0, remainingQuantity: 0, unrealizedPnl: 0, unrealizedPnlPercent: 0, completedAt: at, durationMinutes: order.entryTime ? Math.max(0, Math.floor((at.getTime() - order.entryTime.getTime()) / 60_000)) : 0, ...result, estimatedCharges: charges, grossPnl, netPnl: totalPnl, pnl: totalPnl, pnlPercent: totalPercent } }),
      this.prisma.paperTradingAccount.update({ where: { userId: order.userId }, data: { realizedPnl: { increment: totalPnl } } }),
    ]);
    if (order.signalId) {
      const signal = await this.prisma.aiSignal.findUnique({ where: { id: order.signalId } });
      if (signal) await this.recordExecutionDecision(signal, 'EXIT', reason, 0, order.budget, at);
    }
    this.liveMarks.delete(order.id);
    this.demoDecisionStates.delete(order.id);
    this.evaluatedDemoCandles.delete(order.id);
    this.logger.log(JSON.stringify({ event: 'paper.trade.exit', userId: order.userId, orderId, symbol: order.symbol, price, reason, pnl: totalPnl }));
    if (/STOP\s?LOSS/i.test(reason)) await this.recordVoice(order.userId, order.id, 'STOP_LOSS_HIT', order.symbol, 'STOP LOSS HIT', 'Stop Loss hit. Trade closed.');
    const outcome = totalPnl >= 0 ? `Profit ${Math.round(totalPnl)} rupees.` : `Loss ${Math.round(Math.abs(totalPnl))} rupees.`;
    await this.recordVoice(order.userId, order.id, 'TRADE_CLOSED', order.symbol, 'DEMO TRADE COMPLETED', `Trade Completed. ${outcome}`, { pnl: totalPnl, exitPrice: price, exitReason: reason });
    } catch (error) { this.logError('paper.trade.close.failed', error, { orderId, price, reason }); throw error; }
  }
  private async partialExit(orderId: string, price: number, quantity: number, nextStop: number, at: Date) {
    const order = await this.prisma.paperOrder.findUniqueOrThrow({ where: { id: orderId } });
    const remaining = Number(order.remainingQuantity ?? order.quantity);
    const exitQuantity = Math.min(quantity, Math.max(0, remaining - 1));
    if (!exitQuantity) return;
    const result = await this.execution.close({ side: order.side, entryPrice: Number(order.entryPrice), price, quantity: exitQuantity, reason: 'PARTIAL_EXIT', at });
    const partialRealizedPnl = Number(order.partialRealizedPnl ?? 0) + result.pnl;
    const remainingQuantity = remaining - exitQuantity;
    await this.prisma.$transaction([
      this.prisma.paperOrder.update({ where: { id: order.id }, data: { remainingQuantity, partialExitQuantity: Number(order.partialExitQuantity ?? 0) + exitQuantity, partialExitPrice: price, partialExitAt: at, partialRealizedPnl, currentPrice: price, marketValue: price * remainingQuantity, stopLoss: nextStop, trailingStop: nextStop } }),
      this.prisma.paperTradingAccount.update({ where: { userId: order.userId }, data: { realizedPnl: { increment: result.pnl } } }),
    ]);
  }
  private targetExitReason(exitMode: DemoExitMode, target1Hit: boolean, target2Hit: boolean, target3Hit: boolean) {
    if (exitMode === 'EXIT_AT_TARGET1' && target1Hit) return 'TARGET_1';
    if (exitMode === 'EXIT_AT_TARGET2' && target2Hit) return 'TARGET_2';
    if (['EXIT_AT_TARGET3', 'PARTIAL_EXIT', 'TRAILING_STOP', 'TRAILING_AFTER_TARGET1', 'TRAILING_AFTER_TARGET2'].includes(exitMode) && target3Hit) return 'TARGET_3';
    return null;
  }
  private async executeUnlimitedSignals(
    userId: string,
    start: Date,
    end: Date,
    at: Date,
  ) {
    const account = await this.account(userId);
    const signals = await this.prisma.aiSignal.findMany({
      where: {
        userId,
        signalTime: { gte: start, lt: end },
        status: 'RUNNING',
        runningAt: { not: null },
        completedAt: null,
        stopLossAt: null,
      },
      orderBy: [{ confidence: 'desc' }, { aiScore: 'desc' }, { riskReward: 'desc' }, { momentumScore: 'desc' }, { volume: 'desc' }, { signalTime: 'desc' }],
    });
    if (!signals.length) {
      this.logDemoSkip('No active signals found', { userId, start, end });
      return false;
    }

    const existing = await this.prisma.paperOrder.findMany({
      where: { signalId: { in: signals.map((signal) => signal.id) } },
      select: { signalId: true },
    });
    const executedSignalIds = new Set(existing.map((order) => order.signalId).filter(Boolean));
    const ranked = signals.map((signal) => ({ signal, evaluation: this.evaluateTarget1Candidate(signal, account.minimumConfidence) }))
      .sort((left, right) => right.evaluation.score - left.evaluation.score || right.signal.signalTime.getTime() - left.signal.signalTime.getTime());
    let changed = false;
    for (const { signal, evaluation } of ranked) {
      const active = await this.prisma.paperOrder.findMany({
        where: { userId, status: { in: ['WAITING', 'OPEN'] } },
        select: { budget: true, investment: true, instrumentKey: true },
      });
      const usedCapital = active.reduce((sum, order) => sum + Number(order.budget), 0);
      const availableCapital = account.startingBalance + account.realizedPnl - usedCapital;
      const allocation = Math.min(Number(account.capitalPerTrade), availableCapital);
      const decision = (result: 'SKIPPED' | 'EXECUTED', reason: string) => this.recordExecutionDecision(signal, result, reason, availableCapital, allocation, at);
      await this.recordExecutionDecision(signal, 'START', `Ranked candidate evaluation started; final score ${evaluation.score.toFixed(2)}`, availableCapital, allocation, at);
      const duplicateInstrument = active.some((order) => order.instrumentKey === signal.instrumentKey);
      if (executedSignalIds.has(signal.id) || duplicateInstrument) {
        await decision('SKIPPED', 'Duplicate position exists');
        continue;
      }
      if (!evaluation.ready) { await decision('SKIPPED', evaluation.reason); continue; }
      if (!['BUY', 'SELL'].includes(signal.side)) {
        await decision('SKIPPED', 'Invalid BUY/SELL side');
        continue;
      }
      const target1Mode = account.entryMode === 'TARGET1_CONFIRMATION';
      const executionPrice = Number(target1Mode ? signal.target1ExecutedPrice ?? signal.target1 : signal.currentPrice);
      if (!Number.isFinite(executionPrice) || executionPrice <= 0) {
        await decision('SKIPPED', 'Current price invalid');
        continue;
      }
      let sizing;
      try { sizing = await this.intraday.calculateIntradayQuantity({ userId, capital: allocation, symbol: signal.symbol, instrumentKey: signal.instrumentKey, entryPrice: executionPrice, stopLoss: Number(signal.stopLoss), target1: Number(signal.target1), side: signal.side as 'BUY'|'SELL', riskPerTrade: Number(account.riskPerTrade), maxOpenTrades: Number(account.maxOpenTrades) }); }
      catch (error) { await decision('SKIPPED', `REVALIDATE: Intraday margin or charge calculation unavailable: ${error instanceof Error ? error.message : String(error)}`); continue; }
      this.logger.log(JSON.stringify({ event:'demo.intraday.execution',message:'[DEMO INTRADAY EXECUTION]',symbol:signal.symbol,side:signal.side,capital:sizing.capital,product:sizing.productType,entryPrice:executionPrice,intradayMarginPerShare:sizing.marginPerShare,maximumMarginQuantity:sizing.marginBasedQuantity,maximumRisk:sizing.maximumRisk,riskPerShare:sizing.riskPerShare,riskBasedQuantity:sizing.riskBasedQuantity,finalQuantity:sizing.finalQuantity,requiredMargin:sizing.requiredIntradayMargin,estimatedCharges:sizing.estimatedCharges,expectedGrossProfit:sizing.expectedGrossProfit,expectedNetProfit:sizing.expectedNetProfit,decision:sizing.viable?'EXECUTE':'SKIP',reason:sizing.reason }));
      if (!sizing.viable) { await decision('SKIPPED', sizing.reason); continue; }
      const central = this.engine.decide({ ...signal, signalTime: at, currentPrice: executionPrice }, { now: at, marketOpen: marketClock(at).canEnter, availableCapital: sizing.usableCapital, affordableQuantity: sizing.marginBasedQuantity, tradingCapital: Number(account.startingBalance), riskPercent: Number(account.riskPerTrade), openTrades: active.length, maxOpenTrades: account.maxOpenTrades, dailyLoss: Math.max(0, -Number(account.realizedPnl)), maximumDailyLoss: Number(account.maximumDailyLoss), duplicatePosition: duplicateInstrument, minimumConfidence: Number(account.minimumConfidence), minimumRiskReward: Number(account.minimumRiskReward), allowMedium: true });
      if (central.action !== 'EXECUTE') { await decision('SKIPPED', `${central.action}: ${central.reason}`); continue; }
      const quantity = central.quantity;
      if (quantity <= 0) {
        await decision('SKIPPED', 'Capital per trade cannot buy one share');
        continue;
      }
      const capitalUsed = sizing.requiredIntradayMargin;
      const initialStopLoss = Number(signal.stopLoss);
      await this.recordExecutionDecision(signal, 'VALIDATED', `All entry validations passed; final score ${evaluation.score.toFixed(2)}`, availableCapital, allocation, at);
      const fill = await this.execution.fill({ price: executionPrice, quantity, at });
      let position;
      try {
        position = await this.prisma.paperOrder.create({
          data: {
          userId,
          signalId: signal.id,
          instrumentKey: signal.instrumentKey,
          symbol: signal.symbol,
          side: signal.side,
          confidence: signal.confidence,
          product: sizing.product,
          productType: sizing.productType,
          status: 'OPEN',
          quantity,
          remainingQuantity: quantity,
          budget: capitalUsed,
          plannedEntry: signal.entryPrice,
          currentPrice: executionPrice,
          target: signal.target3,
          target1: signal.target1,
          target2: signal.target2,
          stopLoss: initialStopLoss,
          initialStopLoss,
          trailingStop: initialStopLoss,
          strategy: target1Mode ? 'Target 1 Confirmation' : 'Direct Entry',
          entryType: target1Mode ? 'Target1 Hit' : 'Validated Entry',
          target1Time: signal.target1At,
          marketValue: capitalUsed,
          notionalValue: sizing.notionalValue,
          requiredIntradayMargin: sizing.requiredIntradayMargin,
          availableCapitalAtEntry: availableCapital,
          marginPerShare: sizing.marginPerShare,
          maximumMarginQuantity: sizing.marginBasedQuantity,
          riskAmount: sizing.maximumRisk,
          riskPerShare: sizing.riskPerShare,
          riskBasedQuantity: sizing.riskBasedQuantity,
          estimatedCharges: sizing.estimatedCharges,
          expectedGrossProfit: sizing.expectedGrossProfit,
          expectedNetProfit: sizing.expectedNetProfit,
          tradeStage: target1Mode ? 'TARGET1_CONFIRMED' : 'RUNNING',
          rankScore: evaluation.score,
          entryQuality: 'Qualified',
          ...fill,
            investment: sizing.notionalValue,
          },
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        await this.recordExecutionDecision(signal, 'ERROR', reason, availableCapital, allocation, at);
        this.logError('demo.paper-order.create.failed', error, { userId, signalId: signal.id, symbol: signal.symbol });
        continue;
      }
      if (target1Mode) await this.recordExecutionDecision(signal, 'TARGET1', 'Target1 reached', availableCapital, allocation, signal.target1At ?? at);
      await this.recordExecutionDecision(signal, 'BUY', `Paper position opened at ${executionPrice}; ranking score ${evaluation.score.toFixed(2)}`, availableCapital - capitalUsed, allocation, at);
      await decision('EXECUTED', `${target1Mode ? 'Target1 continuation' : 'Direct entry'} validated and position created`);
      if (target1Mode) await this.recordVoice(userId, position.id, 'TARGET1_CONFIRMED', signal.symbol, 'TARGET ONE CONFIRMED', 'Target One confirmed');
      await this.recordVoice(userId, position.id, 'DEMO_TRADE_EXECUTED', signal.symbol, 'DEMO TRADE EXECUTED', 'Demo Trade Executed', { side: signal.side, quantity, investment: capitalUsed, entryPrice: executionPrice });
      executedSignalIds.add(signal.id);
      changed = true;
    }
    return changed;
  }

  private evaluateTarget1Candidate(signal: TriggeredSignal, minimumConfidence = 90) {
    const score = this.engine.rank(signal);
    const validations = [
      { pass: Boolean(signal.runningAt), reason: 'Signal Status Failed: RUNNING was never reached' },
      { pass: ['BUY', 'SELL'].includes(signal.side), reason: 'Invalid BUY/SELL side' },
      { pass: Number.isFinite(Number(signal.currentPrice)) && Number(signal.currentPrice) > 0, reason: 'Entry Price Invalid' },
      { pass: Number.isFinite(Number(signal.stopLoss)) && Number(signal.stopLoss) > 0, reason: 'Stop Loss Invalid' },
      { pass: Number.isFinite(Number(signal.target3)) && Number(signal.target3) > 0, reason: 'Target3 Invalid' },
    ];
    const failed = validations.find((item) => !item.pass);
    return { ready: !failed, reason: failed?.reason ?? 'Qualified', score: Math.max(0, Math.min(100, score)), quality: failed ? 'Rejected' : score >= 85 ? 'Elite' : score >= 75 ? 'Excellent' : 'Qualified' };
  }
  private evaluateExecutionCandidate(signal: TriggeredSignal, account: { minimumConfidence: number }) {
    const result = this.evaluateTarget1Candidate(signal, account.minimumConfidence);
    return { ...result, checks: [{ key: 'strict-entry', label: 'Strict Entry Confirmation', passed: result.ready, detail: result.reason }], components: { finalTradingScore: result.score } };
  }

  private entryModeLabel(mode: string) {
    return ({ ENTRY_TRIGGERED: 'Entry Triggered', RUNNING_CONFIRMATION: 'Running Confirmation', TARGET1_CONFIRMATION: 'Target 1 Confirmation', TARGET2_CONTINUATION: 'Target 2 Continuation', AI_AUTO_SELECT: 'AI Auto Select' } as Record<string, string>)[mode] ?? 'Target 1 Confirmation';
  }

  private istMinutes(at: Date) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
    return Number(parts.find((part) => part.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((part) => part.type === 'minute')?.value ?? 0);
  }

  private async recordExecutionDecision(signal: TriggeredSignal, decision: 'START' | 'VALIDATED' | 'BUY' | 'TARGET1' | 'TARGET2' | 'TARGET3' | 'EXIT' | 'STOPLOSS' | 'ERROR' | 'SKIPPED' | 'EXECUTED', reason: string, availableCapital: number, capitalPerTrade: number, at: Date) {
    const data = { userId: signal.userId, signalId: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, signalStatus: signal.status, decision, reason, currentPrice: Number(signal.currentPrice), target1Time: signal.target1At ?? null, confidence: signal.confidence, riskReward: signal.riskReward, availableCapital, capitalPerTrade, createdAt: at };
    await this.prisma.demoExecutionDecision.upsert({
      where: { signalId_decision_reason: { signalId: signal.id, decision, reason } }, update: { ...data, createdAt: at }, create: data,
    });
    const payload = JSON.stringify({ event: 'demo.execution.decision', signal: signal.symbol, ...data });
    if (decision === 'SKIPPED' || decision === 'ERROR') this.logger.warn(payload); else this.logger.log(payload);
  }

  private target1ConfirmationStop(side: string, livePrice: number, atrValue?: number | null, previousCandleLow?: number | null, previousCandleHigh?: number | null) {
    const buy = side === 'BUY';
    const atr = Number(atrValue);
    const previousBoundary = Number(buy ? previousCandleLow : previousCandleHigh);
    const candidates = [
      previousBoundary,
      Number.isFinite(atr) && atr > 0 ? livePrice + (buy ? -1 : 1) * atr * .8 : NaN,
      livePrice * (buy ? .996 : 1.004),
    ].filter((value) => Number.isFinite(value) && (buy ? value < livePrice : value > livePrice));
    return buy ? Math.max(...candidates) : Math.min(...candidates);
  }

  private async recordGlobalSkips(userId: string, reason: string, at: Date, suppliedAccount?: Awaited<ReturnType<PaperTradingService['account']>>) {
    const account = suppliedAccount ?? await this.account(userId);
    const { start, end } = this.tradingDayBounds(at);
    const signals = await this.prisma.aiSignal.findMany({ where: { userId, target1At: { gte: start, lt: end } } });
    const active = await this.prisma.paperOrder.findMany({ where: { userId, status: { in: ['WAITING', 'OPEN'] } }, select: { budget: true, investment: true } });
    const availableCapital = account.startingBalance + account.realizedPnl - active.reduce((sum, order) => sum + Number(order.budget), 0);
    for (const signal of signals) await this.recordExecutionDecision(signal, 'SKIPPED', reason, availableCapital, TARGET1_CONFIRMATION_CAPITAL, at);
  }

  private logDemoSkip(reason: string, context: Record<string, unknown>) {
    this.logger.warn(JSON.stringify({
      event: 'demo.trade.skipped',
      message: `[Demo] Trade skipped because: ${reason}`,
      reason,
      ...context,
    }));
  }

  private logDemoBlocked(functionName: string, reason: string, context: Record<string, unknown>) {
    this.logger.warn(JSON.stringify({
      event: 'paper.execution.blocked',
      message: `[Paper] BLOCKED: ${reason}`,
      file: 'paper-trading.service.ts',
      function: functionName,
      reason,
      ...context,
    }));
  }

  private demoDecision(order: any, signal: any, row: ScanRow, at: Date): DemoCandleDecision {
    const buy = order.side === 'BUY';
    const direction = buy ? 1 : -1;
    const indicators = row.indicators ?? {};
    const entry = Number(order.entryPrice);
    const ema20 = Number(row.ema20);
    const ema50 = Number(row.ema50);
    const vwap = Number(row.vwap);
    const rsi = Number(row.rsi);
    const macd = Number(indicators.macd?.histogram ?? row.macd ?? indicators.histogram);
    const volumeRatio = Number(indicators.volumeRatio);
    const adx = Number(indicators.adx);
    const supertrend = Number(indicators.supertrend);
    const momentum = Number(indicators.momentum ?? indicators.roc);
    const target1Hit = signal && (signal.target1At || (buy ? row.price >= signal.target1 : row.price <= signal.target1));
    const target2Hit = signal && (signal.target2At || (buy ? row.price >= signal.target2 : row.price <= signal.target2));
    const profitable = direction * (row.price - entry) > 0;
    const aligned = [
      direction * (row.price - ema20) > 0,
      direction * (ema20 - ema50) > 0,
      direction * (row.price - vwap) > 0,
      direction * macd > 0,
      buy ? rsi >= 52 && rsi <= 72 : rsi <= 48 && rsi >= 28,
      volumeRatio >= 1,
      adx >= 25,
      !Number.isFinite(supertrend) || direction * (row.price - supertrend) > 0,
      !Number.isFinite(momentum) || direction * momentum > 0,
      !row.entryValidation?.fakeBreakout,
    ];
    const strongCount = aligned.filter(Boolean).length;
    const strong = strongCount >= 9;
    const veryStrong = strongCount === aligned.length && volumeRatio >= 1.2 && adx >= 30;
    const weak = strongCount <= 6 || volumeRatio < .7 || direction * macd <= 0 || direction * (row.price - vwap) <= 0;
    let trailingStop = this.logicalStop(order.side, row, row.price, Number(order.stopLoss));
    if (target1Hit) trailingStop = buy ? Math.max(trailingStop, entry) : Math.min(trailingStop, entry);
    if (target2Hit && signal) trailingStop = buy ? Math.max(trailingStop, Number(signal.target1)) : Math.min(trailingStop, Number(signal.target1));

    const seconds = this.istSeconds(at);
    const afterThree = seconds >= 15 * 3600;
    const afterThreeFifteen = seconds >= 15 * 3600 + 15 * 60;
    const strength: DemoCandleDecision['strength'] = veryStrong ? 'VERY STRONG' : strong ? 'STRONG' : weak ? 'WEAK' : 'MODERATE';
    const currentTarget = signal ? Number(target2Hit ? signal.target3 : target1Hit ? signal.target2 : signal.target1) : Number(order.target);
    const timeRemainingSeconds = Math.max(0, (afterThree ? 15 * 3600 + 15 * 60 : 15 * 3600) - seconds);
    const state = (decision: Omit<DemoCandleDecision, 'strength' | 'currentTarget' | 'timeRemainingSeconds'>): DemoCandleDecision => ({
      ...decision, strength, currentTarget, timeRemainingSeconds,
    });
    const weaknessReason = volumeRatio < .7
      ? 'Volume Drop'
      : direction * (row.price - vwap) <= 0
        ? 'VWAP Breakdown'
        : direction * macd <= 0
          ? (buy ? 'MACD Bearish' : 'MACD Bullish')
          : (buy ? rsi < 50 : rsi > 50)
            ? 'RSI Weak'
            : direction * (row.price - ema20) <= 0
              ? 'Trend Failure'
              : 'Weak Momentum';
    if (target2Hit && !veryStrong) return state({ action: 'BOOK PROFIT', reason: 'Target 2 Booked', trailingStop });
    if (afterThreeFifteen && !veryStrong) return state({ action: profitable ? 'BOOK PROFIT' : 'EXIT', reason: 'Time Exit (3:15 PM)', trailingStop: profitable ? entry : trailingStop });
    if (afterThree && !profitable) return state({ action: 'EXIT', reason: 'Capital Protection', trailingStop });
    if (afterThree && weak) return state({ action: 'BOOK PROFIT', reason: `Time Exit (3 PM) - ${weaknessReason}`, trailingStop: entry });
    if (weak) return state({ action: profitable ? 'BOOK PROFIT' : 'EXIT', reason: weaknessReason, trailingStop });
    if (afterThree && profitable) trailingStop = buy ? Math.max(trailingStop, entry) : Math.min(trailingStop, entry);
    if (target1Hit || this.improvesStop(order.side, Number(order.stopLoss), trailingStop)) {
      return state({ action: target1Hit ? 'TRAIL STOP' : 'REDUCE RISK', reason: target1Hit ? 'Target 1 - Stop Moved to Entry' : 'Capital Protection', trailingStop });
    }
    return state({ action: 'HOLD', reason: strong ? 'Strong Trend' : 'Trade Valid', trailingStop });
  }

  private logicalStop(side: string, row: ScanRow, price: number, fallback: number) {
    const buy = side === 'BUY';
    const direction = buy ? 1 : -1;
    const indicators = row.indicators ?? {};
    const atr = Number(indicators.atr);
    const swing = Number(buy
      ? indicators.swingLow ?? indicators.support ?? row.todayLow
      : indicators.swingHigh ?? indicators.resistance ?? row.todayHigh);
    const candidates = [
      Number.isFinite(atr) && atr > 0 ? price - direction * atr * 1.25 : NaN,
      Number(row.ema20),
      swing,
      Number(row.vwap),
      fallback,
    ].filter((value) => Number.isFinite(value) && (buy ? value < price : value > price));
    return candidates.length ? (buy ? Math.max(...candidates) : Math.min(...candidates)) : NaN;
  }

  private markOpenOrder(order: any, price: number) {
    const entryPrice = Number(order.entryPrice);
    const pnl = (order.side === 'BUY' ? price - entryPrice : entryPrice - price) * Number(order.quantity);
    const pnlPercent = entryPrice ? pnl / (entryPrice * Number(order.quantity)) * 100 : 0;
    this.liveMarks.set(order.id, { currentPrice: price, pnl, pnlPercent });
  }

  private improvesStop(side: string, current: number, candidate: number) {
    return Number.isFinite(candidate) && (side === 'BUY' ? candidate > current : candidate < current);
  }

  private candleTime(row: ScanRow, fallback: Date) {
    const value = row.indicators?.latestCandle?.time ?? row.lastUpdated;
    const date = value ? new Date(value) : fallback;
    return Number.isFinite(date.getTime()) ? date : fallback;
  }

  private istSeconds(at: Date) {
    const values = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(at);
    const parts = Object.fromEntries(values.map((part) => [part.type, part.value]));
    return Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  }
  private tradingDayBounds(at: Date) {
    const tradingDate = marketClock(at).tradingDate;
    return {
      start: new Date(`${tradingDate}T00:00:00+05:30`),
      end: new Date(new Date(`${tradingDate}T00:00:00+05:30`).getTime() + 86_400_000),
    };
  }
  private async resetExpiredDemoState(userId: string, at: Date) {
    const tradingDate = marketClock(at).tradingDate;
    if (this.completedDailyResets.get(userId) === tradingDate) return;
    const resetKey = `${userId}:${tradingDate}`;
    const running = this.dailyResetTasks.get(resetKey);
    if (running) return running;
    const task = this.performExpiredDemoReset(userId, at)
      .then(() => { this.completedDailyResets.set(userId, tradingDate); })
      .finally(() => this.dailyResetTasks.delete(resetKey));
    this.dailyResetTasks.set(resetKey, task);
    return task;
  }
  private async performExpiredDemoReset(userId: string, at: Date) {
    const { start } = this.tradingDayBounds(at);
    const staleOrders = await this.prisma.paperOrder.findMany({
      where: { userId, status: { in: ['WAITING', 'OPEN'] }, createdAt: { lt: start } },
    });
    for (const order of staleOrders) {
      if (order.status === 'OPEN') {
        await this.close(order.id, Number(order.currentPrice), 'End of Day Auto Exit', start, 'CLOSED - EOD EXIT');
      } else {
        await this.prisma.paperOrder.update({
          where: { id: order.id },
          data: { status: 'CLOSED - EOD EXIT', exitTime: start, exitReason: 'End of Day Auto Exit', pnl: 0, pnlPercent: 0, durationMinutes: 0 },
        });
      }
    }
    const staleQueueEntry = await this.prisma.demoTradeQueue.findFirst({
      where: { userId, status: 'WAITING_FOR_CAPITAL', queuedAt: { lt: start } },
      select: { id: true },
    });
    if (staleQueueEntry) {
      await this.prisma.demoTradeQueue.updateMany({
        where: { userId, status: 'WAITING_FOR_CAPITAL', queuedAt: { lt: start } },
        data: { status: 'REJECTED', rejectedAt: start, rejectReason: 'Previous trading day expired' },
      });
    }
  }
  private target1Backtest(signals: any[], instruments = new Map<string, { intradayMargin: number | null; intradayLeverage: number | null }>()) {
    const completed = signals.filter((signal) => signal.completedAt && Number.isFinite(Number(signal.exitPrice)));
    const summarize = (eligible: (signal: any) => boolean, entry: (signal: any) => number) => {
      const trades = completed.filter(eligible).map((signal) => ({
        signalId: signal.id,
        symbol: signal.symbol,
        side: signal.side,
        date: signal.completedAt.toISOString(),
        entryTime: (signal.entryTriggeredAt ?? signal.runningAt ?? signal.signalTime).toISOString(),
        exitTime: signal.completedAt.toISOString(),
        instrumentKey: signal.instrumentKey,
        entryPrice: entry(signal),
        exitPrice: Number(signal.exitPrice),
        stopLoss: Number(signal.stopLoss),
        exitReason: signal.stopLossAt ? 'STOP_LOSS' : signal.target3At ? 'TARGET_3' : signal.target2At ? 'TARGET_2' : signal.target1At ? 'TARGET_1' : 'COMPLETED',
        intradayMarginPercent: Number(instruments.get(signal.instrumentKey)?.intradayMargin),
        intradayLeverage: Number(instruments.get(signal.instrumentKey)?.intradayLeverage),
      })).filter((trade) => trade.entryPrice > 0 && trade.exitPrice > 0);
      const returns = trades.map((trade) => {
        const start = trade.entryPrice, exit = trade.exitPrice, direction = trade.side === 'BUY' ? 1 : -1;
        return start > 0 ? direction * (exit - start) / start * 100 : 0;
      });
      const wins = returns.filter((value) => value > 0), losses = returns.filter((value) => value < 0);
      const grossProfit = wins.reduce((sum, value) => sum + value, 0), grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
      let equity = 0, peak = 0, drawdown = 0;
      for (const value of returns) { equity += value; peak = Math.max(peak, equity); drawdown = Math.max(drawdown, peak - equity); }
      return { trades, tradeCount: returns.length, winRate: returns.length ? wins.length / returns.length * 100 : 0, averageProfit: wins.length ? grossProfit / wins.length : 0, averageLoss: losses.length ? grossLoss / losses.length : 0, profitFactor: grossLoss ? grossProfit / grossLoss : grossProfit, drawdown, expectedReturn: returns.length ? returns.reduce((sum, value) => sum + value, 0) / returns.length : 0 };
    };
    return {
      entryTriggered: summarize((signal) => Boolean(signal.entryTriggeredAt), (signal) => Number(signal.entryExecutedPrice ?? signal.entryPrice)),
      target1Confirmation: summarize((signal) => Boolean(signal.target1At), (signal) => Number(signal.target1ExecutedPrice ?? signal.target1)),
    };
  }

  async capitalSimulation(userId: string, mode: 'today' | 'last7' | 'historical', limit = 500) {
    const now = new Date();
    const today = marketClock(now).tradingDate;
    const todayStart = new Date(`${today}T09:15:00+05:30`);
    const todayEnd = new Date(`${today}T23:59:59.999+05:30`);
    let signals: any[] = [];
    let sessionDates: string[] = [];
    if (mode === 'today') {
      signals = await this.prisma.aiSignal.findMany({ where: { userId, top100Selected: true, side: { in: ['BUY', 'SELL'] }, signalTime: { gte: todayStart, lte: todayEnd } }, orderBy: { signalTime: 'asc' } });
      sessionDates = [today];
    } else {
      const candidates = await this.prisma.aiSignal.findMany({
        where: { userId, top100Selected: true, side: { in: ['BUY', 'SELL'] }, signalTime: mode === 'historical' ? { lt: todayStart } : { gte: new Date(todayStart.getTime() - 60 * 86_400_000), lte: todayEnd } },
        orderBy: { signalTime: 'desc' },
        take: mode === 'historical' ? Math.max(1, Math.min(5_000, limit)) : undefined,
      });
      if (mode === 'last7') {
        sessionDates = [...new Set(candidates.map((signal) => this.istDate(signal.signalTime)))].slice(0, 7);
        const selected = new Set(sessionDates);
        signals = candidates.filter((signal) => selected.has(this.istDate(signal.signalTime))).sort((a, b) => Number(a.signalTime) - Number(b.signalTime));
      } else {
        signals = candidates.sort((a, b) => Number(a.signalTime) - Number(b.signalTime));
        sessionDates = [...new Set(signals.map((signal) => this.istDate(signal.signalTime)))];
      }
    }
    const completed = signals.filter((signal) => signal.completedAt && Number.isFinite(Number(signal.exitPrice)));
    const counts = {
      signalsFound: signals.length,
      waiting: signals.filter((signal) => matchesStatusFilter(signal, 'WAITING')).length,
      entryTriggered: signals.filter((signal) => matchesStatusFilter(signal, 'ENTRY_TRIGGERED')).length,
      running: signals.filter((signal) => matchesStatusFilter(signal, 'RUNNING')).length,
      target1Hit: signals.filter((signal) => matchesStatusFilter(signal, 'TARGET1_HIT')).length,
      target2Hit: signals.filter((signal) => matchesStatusFilter(signal, 'TARGET2_HIT')).length,
      target3Hit: signals.filter((signal) => matchesStatusFilter(signal, 'TARGET3_HIT')).length,
      completed: signals.filter((signal) => matchesStatusFilter(signal, 'COMPLETED') && Boolean(signal.completedAt)).length,
      winningTrades: completed.filter((signal) => Number(signal.profitPercent) > 0).length,
      losingTrades: completed.filter((signal) => Number(signal.profitPercent) < 0).length,
      stopLoss: signals.filter((signal) => matchesStatusFilter(signal, 'STOPLOSS_HIT')).length,
    };
    const instrumentRows = await this.prisma.nseInstrument.findMany({ where: { instrumentKey: { in: [...new Set(completed.map((signal) => signal.instrumentKey))] } }, select: { instrumentKey: true, intradayMargin: true, intradayLeverage: true } });
    const instrumentMap = new Map(instrumentRows.map((row) => [row.instrumentKey, row]));
    if (mode === 'today') {
      for (const signal of completed) {
        const saved = instrumentMap.get(signal.instrumentKey);
        if (Number(saved?.intradayMargin) > 0 || Number(saved?.intradayLeverage) > 0) continue;
        const key = `${userId}:${signal.instrumentKey}:${signal.side}`;
        let pending = this.simulationMarginProfiles.get(key);
        if (!pending) { pending = this.intraday.getMarginProfile(userId, signal.instrumentKey, signal.side, Number(signal.entryExecutedPrice ?? signal.entryPrice)); this.simulationMarginProfiles.set(key, pending); }
        try { const profile = await pending; instrumentMap.set(signal.instrumentKey, { instrumentKey: signal.instrumentKey, ...profile }); await this.prisma.nseInstrument.updateMany({ where: { instrumentKey: signal.instrumentKey }, data: profile }); }
        catch (error) { this.logger.warn(JSON.stringify({ event: 'simulation.intraday-margin.unavailable', signalId: signal.id, instrumentKey: signal.instrumentKey, reason: error instanceof Error ? error.message : String(error) })); this.simulationMarginProfiles.delete(key); }
      }
    }
    const backtest = this.target1Backtest(signals, instrumentMap);
    return { mode, sessionDate: mode === 'today' ? today : null, sessionDates, generatedAt: now.toISOString(), counts, sourceTradeCount: completed.length, backtest };
  }

  private istDate(value: Date) { return value.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }); }

  private async optimizeDemoStrategy(userId: string, at: Date) {
    const { start, end } = this.tradingDayBounds(at);
    const orders = await this.prisma.paperOrder.findMany({ where: { userId, status: { startsWith: 'CLOSED' }, exitTime: { gte: start, lt: end } } });
    if (!orders.length) return null;
    const signals = await this.prisma.aiSignal.findMany({ where: { id: { in: orders.map((order) => order.signalId).filter((id): id is string => Boolean(id)) } } });
    const byId = new Map(signals.map((signal) => [signal.id, signal]));
    const ranked = (key: (order: typeof orders[number]) => string) => {
      const groups = new Map<string, { pnl: number; count: number }>();
      for (const order of orders) { const name = key(order) || 'Unknown', current = groups.get(name) ?? { pnl: 0, count: 0 }; current.pnl += order.pnl; current.count += 1; groups.set(name, current); }
      return [...groups].sort((a, b) => b[1].pnl / b[1].count - a[1].pnl / a[1].count);
    };
    const strategy = ranked((order) => byId.get(order.signalId ?? '')?.strategy ?? order.strategy);
    const sector = ranked((order) => byId.get(order.signalId ?? '')?.sector ?? 'NSE Equity');
    const hour = ranked((order) => order.entryTime ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(order.entryTime) + ':00' : 'Unknown');
    const winners = orders.filter((order) => order.pnl > 0), losers = orders.filter((order) => order.pnl < 0);
    const meanSignal = (items: typeof orders, field: 'confidence' | 'aiScore' | 'riskReward') => items.length ? items.reduce((sum, order) => sum + Number(byId.get(order.signalId ?? '')?.[field] ?? 0), 0) / items.length : null;
    const data = { userId, tradingDate: marketClock(at).tradingDate, bestStrategy: strategy[0]?.[0], worstStrategy: strategy.at(-1)?.[0], bestSector: sector[0]?.[0], worstSector: sector.at(-1)?.[0], bestTime: hour[0]?.[0], worstTime: hour.at(-1)?.[0], bestConfidence: meanSignal(winners, 'confidence'), worstConfidence: meanSignal(losers, 'confidence'), bestAiScore: meanSignal(winners, 'aiScore'), bestRiskReward: meanSignal(winners, 'riskReward'), sampleSize: orders.length, summary: JSON.stringify({ strategy, sector, hour }) };
    const optimized = await this.prisma.demoStrategyOptimizer.upsert({ where: { userId_tradingDate: { userId, tradingDate: data.tradingDate } }, update: data, create: data });
    this.optimizerProfiles.set(userId, optimized);
    return optimized;
  }
  private range(value: unknown, minimum: number, maximum: number, fallback: number) { const number = Number(value); return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : fallback; }
  private async retryWrite<T>(operation: () => Promise<T>, attempts = 3): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        if (code !== 'P1008' || attempt >= attempts) throw error;
        this.logger.warn(JSON.stringify({ event: 'paper.database.write.retry', attempt, code }));
        await new Promise((resolve) => setTimeout(resolve, attempt * 100));
      }
    }
  }
  private defaultAccount(userId: string) { return { id: '', userId, enabled: true, autoDemoTrading: true, startingBalance: 10_000, minimumConfidence: 90, maxOpenTrades: 1, riskPerTrade: 2, capitalPerTrade: 10_000, minimumRiskReward: 3, allowAiWait: true, allowReentry: true, voiceAlerts: true, voiceVolume: 100, voiceSpeed: 1, voicePitch: 1, voiceLanguage: 'en-IN', entryMode: 'TARGET1_CONFIRMATION', exitMode: 'EXIT_AT_TARGET3', maximumHoldingMinutes: 180, minimumDailyTrades: 2, preferredDailyTrades: 5, maximumDailyTrades: 10, maximumDailyLoss: 1000, maximumDailyProfit: 2000, squareOffTime: '14:45', realizedPnl: 0, createdAt: new Date(0), updatedAt: new Date(0) }; }
  private emptyPortfolio(userId: string) {
    const account = this.defaultAccount(userId);
    return { balance: 10_000, usedCapital: 0, availableCapital: 10_000, positions: [], history: [], account, summary: { profit: 0, loss: 0, roi: 0, virtualBalance: 10_000, usedCapital: 0, availableCapital: 10_000, todayPnl: 0, openPositions: 0, closedTrades: 0, winRate: 0 }, performance: { todayProfit: 0, todayLoss: 0, winningTrades: 0, losingTrades: 0, averageProfit: 0, averageLoss: 0, largestWin: 0, largestLoss: 0 }, openPositions: [], waitingOrders: [], tradeHistory: [], executionDecisions: [], target1ConfirmationStatistics: { todayTarget1Hits: 0, tradesExecuted: 0, target2Hits: 0, target3Hits: 0, trailingStopExits: 0, stopLossExits: 0, winRate: 0, averageProfit: 0, averageHoldingTime: 0, profitFactor: 0 }, v2Statistics: { todayQualifiedSignals: 0, target1Confirmed: 0, waitingConfirmation: 0, confirmationFailed: 0, executedTrades: 0, skippedTrades: 0, partialProfit: 0, target3Completed: 0, trailingStops: 0, currentOpenTrades: 0 }, bestEntryCandidates: [], backtest: { entryTriggered: {}, target1Confirmation: {} }, optimizer: null, riskManager: marketClock() };
  }
  private sanitize<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => this.sanitize(item)) as T;
    if (value instanceof Date) return value as T;
    if (value && typeof value === 'object') { const output: Record<string, unknown> = {}; for (const [key, item] of Object.entries(value)) output[key] = item === undefined || (typeof item === 'number' && !Number.isFinite(item)) ? 0 : this.sanitize(item); return output as T; }
    return value;
  }
  private logError(event: string, error: unknown, context: Record<string, unknown>) {
    const exception = error instanceof Error ? error : new Error(String(error));
    const prisma = error && typeof error === 'object' ? { code: 'code' in error ? String(error.code) : undefined, meta: 'meta' in error ? error.meta : undefined } : {};
    this.logger.error(JSON.stringify({ event, ...context, exceptionName: exception.name, message: exception.message, ...prisma, stack: exception.stack }), exception.stack);
  }
}
