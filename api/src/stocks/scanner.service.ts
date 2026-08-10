import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadGatewayException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { PrismaService } from '../prisma.service';
import { Candle } from './indicator.service';
import { UpstoxService } from './upstox.service';
import { MarketGateway } from './market.gateway';
import { SignalHistoryService } from './signal-history.service';
import { LiveQuote, QuoteBatchResult, QuoteBatchService } from './quote-batch.service';
import { IndicatorEngine } from './indicator-engine.service';
import { AiRankingEngine } from './ai-ranking-engine.service';
import { SignalEngine } from './signal-engine.service';
import { TradeManagementService } from './trade-management.service';
import { PaperTradingService } from './paper-trading.service';

type Instrument = { instrument_key?: string; trading_symbol?: string; exchange?: string; isin?: string; name?: string; instrument_token?: string; exchange_token?: string; instrument_type?: string; segment?: string; sector?: string; status?: string; intraday_margin?: number; intraday_leverage?: number };
type Live = LiveQuote;
export type ScanRow = { symbol: string; company: string; sector: string; instrumentKey: string; universeRank: number; selectionScore: number; price: number; change: number; changePercent: number; volume: number; rsi: number | null; macd: number | null; ema9: number | null; ema20: number | null; ema50: number | null; vwap: number | null; previousDayHigh: number | null; previousDayLow: number | null; todayHigh: number | null; todayLow: number | null; openingRangeHigh: number | null; openingRangeLow: number | null; signal: 'BUY' | 'SELL' | 'HOLD'; confidence: number; score: number; aiScore: number; buyProbability: number; sellProbability: number; holdProbability: number; tags: string[]; indicators: Record<string, any>; scoreBreakdown: Record<'trend' | 'momentum' | 'volume' | 'breakoutQuality' | 'candlestickPatterns' | 'indicatorAlignment', number>; trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; entry: number | null; buyLevel: number | null; sellLevel: number | null; safeEntry: number | null; aggressiveEntry: number | null; stopLoss: number | null; target1: number | null; target2: number | null; target3: number | null; riskReward: number | null; expectedProfitPercent: number | null; expectedLossPercent: number | null; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; intradayScore: number; signalStrength: string; timeframe: string; lastUpdated: string; reason: string; patterns: string[]; entryQuality: 'Excellent' | 'Good' | 'Average' | 'Weak' | 'Poor' | 'Fake Breakout'; entryValidation: Record<string, boolean>; probabilities: { target1: number; target2: number; target3: number; stopLoss: number; reversal: number; trendContinuation: number }; candleAnalysis: Record<string, unknown>; trendStrength: string; aiDecision: string; aiExplanation: string[]; openingGapPercent: number };
export type ScanCoverage = { requested: number; analyzed: number; unavailable: number; quotesReceived: number; invalidKeys: number; failedBatches: number; totalBatches: number; partial: boolean; message: string };
export type ScanReport = { rows: ScanRow[]; coverage: ScanCoverage };

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);
  private readonly reports = new Map<string, ScanReport>();
  private readonly activeScans = new Map<string, Promise<ScanRow[]>>();
  constructor(private readonly upstox: UpstoxService, private readonly quoteBatches: QuoteBatchService, private readonly indicators: IndicatorEngine, private readonly signals: SignalEngine, private readonly ranking: AiRankingEngine, private readonly tradeManagement: TradeManagementService, private readonly paperTrading: PaperTradingService, private readonly prisma: PrismaService, private readonly market: MarketGateway, private readonly signalHistory: SignalHistoryService, @Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async scan(userId: string, force = false, persistSignals = true) {
    const activeKey = `${userId}:${persistSignals ? 'persist' : 'read-only'}`;
    const active = this.activeScans.get(activeKey);
    if (active) {
      this.logger.debug(`Joining active scanner task | User ID: ${userId} | Persist signals: ${persistSignals}`);
      return active;
    }
    const task = this.scanOnce(userId, force, persistSignals);
    this.activeScans.set(activeKey, task);
    try {
      return await task;
    } finally {
      if (this.activeScans.get(activeKey) === task) this.activeScans.delete(activeKey);
    }
  }

  private async scanOnce(userId: string, force = false, persistSignals = true) {
    const startedAt = Date.now();
    const cacheKey = `scanner:${userId}:${this.tradingDate()}`;
    if (force) await this.cache.del(cacheKey);
    const cached = await this.cache.get<ScanRow[]>(cacheKey);
    if (cached?.length) return cached;
    this.logger.log('Scanner Started');
    this.stage(1, 'Instrument universe');
    const instruments = await this.syncInstruments();
    this.logger.log(`Loaded NSE instruments: ${instruments.length}`);
    if (!instruments.length) throw new ServiceUnavailableException('Scanner failed at Stage 1: zero active NSE EQ instruments were loaded. See ScannerService logs for the downloaded instrument fields and rejected-record reasons.');
    this.stage(2, 'Live quotes');
    const firstInstrument = instruments[0];
    this.logger.log(`[SCANNER FIRST INSTRUMENT — DATABASE] ${JSON.stringify({ instrumentKey: firstInstrument.instrumentKey, symbol: firstInstrument.symbol })}`);
    this.logger.log(`Total Stocks: ${instruments.length}`);
    const quoteResult = await this.quoteBatches.fetchAll(userId, instruments.map((item) => item.instrumentKey));
    const live = quoteResult.prices;
    this.logger.log(`Quotes requested: ${quoteResult.requested}`);
    this.logger.log(`Quotes received: ${live.size}`);
    this.logger.log(`Quotes failed: ${quoteResult.failed}`);
    if (!live.size) {
      const report = this.report([], instruments.length, quoteResult);
      this.reports.set(userId, report);
      this.logger.error(`Scanner Completed with no provider data | ${JSON.stringify(report.coverage)}`);
      return [];
    }
    const firstQuote = live.get(firstInstrument.instrumentKey);
    this.logger.log(`[SCANNER FIRST INSTRUMENT — LOOKUP] ${JSON.stringify({ instrumentKey: firstInstrument.instrumentKey, mapKeys: [...live.keys()], lookupResult: firstQuote ?? null })}`);
    this.logger.log(`[SCANNER FIRST INSTRUMENT — QUOTE] ${JSON.stringify({ quote: firstQuote ?? null, quotePrice: firstQuote?.price, quotePriceType: typeof firstQuote?.price })}`);
    if (firstQuote?.price === undefined) this.logger.warn(`[SCANNER FIRST INSTRUMENT] quote.price is undefined; continuing with other NSE equities as required.`);
    const candidates = instruments.filter((instrument) => { const quote = live.get(instrument.instrumentKey); return quote && quote.price >= 60 && quote.price <= 600; });
    const rankedUniverse = this.ranking.rankUniverse(candidates, live);
    const universe = rankedUniverse.slice(0, 100);
    const universeMeta = new Map(rankedUniverse.map((instrument, index) => [instrument.instrumentKey, { universeRank: index + 1, selectionScore: instrument.selectionScore }]));
    this.logger.log(`Stage 2 liquidity universe | LTP ₹60–₹600 candidates: ${candidates.length} | Selected Top 100 by liquidity, average/relative volume, volatility and AI pre-score: ${universe.length}`);
    if (!universe.length) {
      const report = this.report([], instruments.length, quoteResult);
      this.reports.set(userId, report);
      this.logger.warn(`Scanner Completed with no price-eligible instruments | ${JSON.stringify(report.coverage)}`);
      return [];
    }
    await this.market.subscribeMany(userId, universe.map((instrument) => instrument.instrumentKey));
    for (const instrument of universe) {
      const websocketPrice = this.market.latestPrice(instrument.instrumentKey);
      const quote = live.get(instrument.instrumentKey);
      if (quote && websocketPrice !== null) live.set(instrument.instrumentKey, { ...quote, price: websocketPrice });
    }

    this.stage(3, 'Historical candles');
    let historicalCandleCount = 0, historicalRequests = 0, historicalSuccess = 0, historicalFailures = 0;
    let indicatorsCalculated = 0, indicatorsSkipped = 0;
    let aiScoreCount = 0;
    let patternsDetected = 0;
    let buyCount = 0, sellCount = 0, holdCount = 0;
    const rows: ScanRow[] = [];
    this.logger.log(`Historical request queue | length: ${universe.length} | concurrency: 6`);
    await this.pool(universe, 6, async (instrument) => {
      const quote = live.get(instrument.instrumentKey);
      if (!quote || quote.price === undefined) {
        this.logger.warn(`Stage 2 quote skipped | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Quote response: ${JSON.stringify(quote ?? null)} | Reason: quote.price is undefined | Historical request not made`);
        return;
      }
      try {
        historicalRequests += 1;
        const candles = await this.intradayCandles(userId, instrument.instrumentKey, 5);
        historicalCandleCount += candles.length;
        historicalSuccess += 1;
        this.logger.log(`Historical success | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Historical response: ${candles.length} valid candles`);
        if (candles.length < 200) {
          indicatorsSkipped += 1;
          this.logger.warn(`Stage 4 indicator skipped | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Reason: only ${candles.length} intraday 5m candles returned; 200 are required for EMA200`);
          return;
        }
        candles[candles.length - 1].close = quote.price;
        const values = this.indicators.calculate(candles);
        if (!values.ema20 || !values.ema50 || !values.ema200 || !values.rsi || !values.macd || !values.atr || !values.adx || !values.vwap) {
          indicatorsSkipped += 1;
          this.logger.warn(`Stage 4 indicator skipped | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Reason: required intraday output missing | Indicator status: ${JSON.stringify({ ema20: values.ema20, ema50: values.ema50, ema200: values.ema200, rsi: values.rsi, macd: values.macd, adx: values.adx, atr: values.atr, vwap: values.vwap })}`);
          return;
        }
        indicatorsCalculated += 1;
        this.logger.log(`Stage 4 indicators calculated | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Indicator status: success`);
        const row = this.signals.generate(instrument.instrumentKey, () => this.score(instrument, quote, values, '5m', universeMeta.get(instrument.instrumentKey)!));
        if (!row) return;
        rows.push(row); aiScoreCount += 1; patternsDetected += row.patterns.length;
        if (row.signal === 'BUY') buyCount += 1; else if (row.signal === 'SELL') sellCount += 1; else holdCount += 1;
        this.logger.log(`Stage 5 AI analysis | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Quote response: ${JSON.stringify(quote)} | AI score: ${row.score} | Signal: ${row.signal} | Confidence: ${row.confidence}`);
      } catch (error) {
        historicalFailures += 1;
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Stage 3 historical failure | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Quote response: ${JSON.stringify(quote)} | Historical response/API error: ${this.errorDetails(error)} | Reason: ${reason} | Continuing scan`);
      }
    });
    this.logger.log(`Historical candle requests: ${historicalRequests}`);
    this.logger.log(`Historical success: ${historicalSuccess}`);
    this.logger.log(`Historical failures: ${historicalFailures}`);
    this.logger.log(`Historical Candle Count: ${historicalCandleCount}`);
    this.stage(4, 'Indicators');
    this.logger.log(`Indicators calculated: ${indicatorsCalculated}`);
    this.logger.log(`Indicators skipped: ${indicatorsSkipped}`);
    this.stage(5, 'AI analysis');
    this.logger.log(`AI Score Count: ${aiScoreCount}`);
    this.logger.log(`Candlestick patterns detected: ${patternsDetected}`);
    this.logger.log(`BUY count: ${buyCount}`);
    this.logger.log(`SELL count: ${sellCount}`);
    this.logger.log(`HOLD count: ${holdCount}`);
    this.stage(6, 'Final response');
    this.logger.log(`Total scanned: ${rows.length}`);
    const buy = this.ranking.top(rows, 'BUY');
    const sell = this.ranking.top(rows, 'SELL');
    this.logger.log(`Top Buy Count: ${buy.length}`);
    this.logger.log(`Top Sell Count: ${sell.length}`);
    this.logger.log(`Total BUY Signals: ${buyCount}`);
    this.logger.log(`Total SELL Signals: ${sellCount}`);
    this.logger.log(`Total scan time: ${Date.now() - startedAt}ms`);
    // An empty BUY or SELL side is a genuine market outcome, not a scanner
    // failure.  Only fail the scanner if no live-data rows were calculated.
    if (!rows.length) {
      const failedStage = !instruments.length ? 1 : !live.size ? 2 : !historicalSuccess ? 3 : !indicatorsCalculated ? 4 : 5;
      const summary = { failedStage, instruments: instruments.length, quotesRequested: quoteResult.requested, quotesReceived: live.size, quotesFailed: quoteResult.failed, historicalRequests, historicalSuccess, historicalFailures, indicatorsCalculated, indicatorsSkipped, patternsDetected, aiScoreCount, buyCount, sellCount, holdCount, totalScanned: rows.length, topBuy: buy.length, topSell: sell.length, totalScanTimeMs: Date.now() - startedAt };
      this.logger.error(`Scanner failure summary: ${JSON.stringify(summary)}`);
      const report = this.report([], instruments.length, quoteResult);
      this.reports.set(userId, report);
      this.logger.error(`Scanner Completed with partial data but no analyzable rows: ${JSON.stringify(summary)}`);
      return [];
    }
    const marketBreadth = rows.reduce((sum, row) => sum + Number(row.changePercent), 0) / rows.length;
    const sectorRows = new Map<string, ScanRow[]>();
    for (const row of rows) sectorRows.set(row.sector, [...(sectorRows.get(row.sector) ?? []), row]);
    for (const row of rows) {
      const peers = sectorRows.get(row.sector) ?? [row];
      const sectorChange = peers.reduce((sum, peer) => sum + Number(peer.changePercent), 0) / peers.length;
      const direction = row.signal === 'BUY' ? 1 : -1;
      row.indicators.marketBreadth = marketBreadth;
      row.indicators.marketTrendAligned = direction * marketBreadth > 0;
      row.indicators.sectorStrength = Math.max(0, Math.min(100, 50 + direction * sectorChange * 10));
    }
    if (persistSignals) {
      await this.signalHistory.recordScannerSignals(userId, rows);
      await this.tradeManagement.evaluateRows(userId, rows);
      await this.paperTrading.evaluateCandleRows(userId, rows);
    }
    await this.cache.set(cacheKey, rows, 60_000);
    const report = this.report(rows, instruments.length, quoteResult);
    this.reports.set(userId, report);
    this.logger.log(`Scanner Completed | ${report.coverage.message}`);
    return rows;
  }

  async scanReport(userId: string, force = false, persistSignals = true): Promise<ScanReport> {
    const rows = await this.scan(userId, force, persistSignals);
    return this.reports.get(userId) ?? {
      rows,
      coverage: {
        requested: rows.length,
        analyzed: rows.length,
        unavailable: 0,
        quotesReceived: rows.length,
        invalidKeys: 0,
        failedBatches: 0,
        totalBatches: 0,
        partial: false,
        message: `Scanning completed. ${rows.length}/${rows.length} stocks analyzed.`,
      },
    };
  }

  async filtered(userId: string, filter = 'all', force = false) {
    const rows = await this.scan(userId, force);
    const normalized = filter.toLowerCase();
    const predicates: Record<string, (row: ScanRow) => boolean> = {
      all: () => true, buy: (row) => row.signal === 'BUY', sell: (row) => row.signal === 'SELL',
      'high-volume': (row) => row.tags.includes('high-volume'), breakout: (row) => row.tags.includes('breakout'),
      oversold: (row) => (row.rsi ?? 50) <= 30, overbought: (row) => (row.rsi ?? 50) >= 70,
      'high-rsi': (row) => (row.rsi ?? 0) >= 60, 'low-rsi': (row) => (row.rsi ?? 100) <= 40,
      'near-support': (row) => row.tags.includes('near-support'), 'near-resistance': (row) => row.tags.includes('near-resistance'),
    };
    const selected = predicates[normalized];
    if (!selected) throw new BadGatewayException(`Unsupported scanner filter: ${filter}`);
    const decorated = await this.signalHistory.decorate(userId, rows);
    return decorated.filter(selected).sort((a, b) => b.aiScore - a.aiScore);
  }

  private async syncInstruments() {
    const downloaded = await this.upstox.nseEquityInstruments() as Instrument[];
    this.logger.log(`Stage 1 raw Upstox instrument records: ${downloaded.length}`);
    this.logger.log(`Stage 1 instrument sample: ${JSON.stringify(downloaded.slice(0, 3))}`);
    const rejected: Record<string, number> = {};
    const instruments = downloaded.flatMap((item) => {
      const reason = item.exchange !== 'NSE' ? `exchange=${item.exchange}` : item.instrument_type !== 'EQ' ? `instrument_type=${item.instrument_type}` : !item.instrument_key ? 'missing instrument_key' : !item.trading_symbol ? 'missing trading_symbol' : item.status === 'inactive' ? 'status=inactive' : '';
      if (reason) { rejected[reason] = (rejected[reason] ?? 0) + 1; return []; }
      return [{ instrumentKey: item.instrument_key!, symbol: item.trading_symbol!, exchange: item.exchange!, isin: item.isin || null, company: item.name || item.trading_symbol!, sector: item.sector || 'NSE Equity', token: String(item.exchange_token ?? item.instrument_token ?? ''), intradayMargin: Number.isFinite(Number(item.intraday_margin)) ? Number(item.intraday_margin) : null, intradayLeverage: Number.isFinite(Number(item.intraday_leverage)) ? Number(item.intraday_leverage) : null, active: true }];
    });
    this.logger.log(`Stage 1 rejected instrument reasons: ${JSON.stringify(rejected)}`);
    if (!instruments.length) throw new ServiceUnavailableException('The downloaded Upstox NSE instrument list contained no active EQ instruments.');
    await this.prisma.$transaction(instruments.map((item) => this.prisma.nseInstrument.upsert({ where: { instrumentKey: item.instrumentKey }, create: item, update: item })));
    return instruments;
  }

  private report(rows: ScanRow[], requested: number, quotes: QuoteBatchResult): ScanReport {
    const unavailable = Math.max(0, requested - quotes.received);
    const partial = unavailable > 0;
    const message = `Scanning completed. ${quotes.received}/${requested} stocks analyzed.${partial ? ` ${unavailable} stocks unavailable from data provider.` : ''}`;
    return {
      rows,
      coverage: {
        requested,
        analyzed: quotes.received,
        unavailable,
        quotesReceived: quotes.received,
        invalidKeys: quotes.invalidKeys.length,
        failedBatches: quotes.failedBatches,
        totalBatches: quotes.totalBatches,
        partial,
        message,
      },
    };
  }

  private async intradayCandles(userId: string, key: string, interval: 1 | 3 | 5 | 15 | 30) {
    const cacheKey = `candles:${userId}:${key}:minutes:${interval}:${this.tradingDate()}`;
    const cached = await this.cache.get<Candle[]>(cacheKey);
    if (cached?.length) { this.logger.log(`Intraday candle cache hit | Instrument key: ${key} | timeframe: ${interval}m | candles: ${cached.length}`); return cached; }
    this.logger.log(`Intraday candle cache miss | Instrument key: ${key} | timeframe: ${interval}m`);
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    this.logger.log(`Stage 3 intraday candles | Instrument key: ${key} | timeframe: ${interval}m | from_date: ${from} | to_date: ${to}`);
    const payload: any = await this.upstox.history(userId, key, 'minutes', interval, to, from);
    const rows = payload?.data?.candles ?? [];
    const candles = rows.slice(0, 400).map((row: unknown[]) => ({ time: String(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) })).reverse().filter((candle: Candle) => Number.isFinite(candle.open) && Number.isFinite(candle.high) && Number.isFinite(candle.low) && Number.isFinite(candle.close) && Number.isFinite(candle.volume));
    await this.cache.set(cacheKey, candles, interval * 60_000);
    return candles;
  }

  private tradingDate(at = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(at);
  }

  private score(instrument: { instrumentKey: string; symbol: string; company: string; sector?: string }, live: Live, indicators: any, timeframe: string, universe: { universeRank: number; selectionScore: number }): ScanRow | null {
    const n = (value: unknown, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
    const ema9 = n(indicators.ema9), ema20 = n(indicators.ema20), ema50 = n(indicators.ema50), vwap = n(indicators.vwap);
    const rsi = n(indicators.rsi, 50), macd = n(indicators.macd?.MACD), histogram = n(indicators.macd?.histogram);
    const atr = n(indicators.atr), volumeSma = n(indicators.volumeSma), candleVolume = n(indicators.volume, live.volume);
    const supertrendDirection = indicators.supertrend?.direction;
    const bullishTrend = live.price > ema9 && ema9 > ema20 && ema20 > ema50;
    const bearishTrend = live.price < ema9 && ema9 < ema20 && ema20 < ema50;
    const direction = bullishTrend ? 1 : bearishTrend ? -1 : histogram > 0 && rsi >= 55 ? 1 : histogram < 0 && rsi <= 45 ? -1 : 0;
    const patterns: string[] = Array.isArray(indicators.patterns) ? indicators.patterns : [];
    const patternBias = patterns.some((p) => /Bullish|Hammer|Morning|Piercing/i.test(p)) ? 1 : patterns.some((p) => /Bearish|Gravestone|Evening|Dark Cloud/i.test(p)) ? -1 : 0;
    const orbBreak = direction > 0 ? live.price > n(indicators.openingRangeHigh, Infinity) : direction < 0 ? live.price < n(indicators.openingRangeLow, -Infinity) : false;
    const previousDayBreak = direction > 0 ? live.price > n(indicators.previousDayHigh, Infinity) : direction < 0 ? live.price < n(indicators.previousDayLow, -Infinity) : false;
    const volumeRatio = volumeSma > 0 ? candleVolume / volumeSma : 0;
    const aligned = [direction * (live.price - vwap) > 0, direction > 0 ? rsi >= 52 : rsi <= 48, direction * histogram > 0, supertrendDirection === (direction > 0 ? 'bullish' : 'bearish')].filter(Boolean).length;
    const scoreBreakdown = {
      trend: direction ? (bullishTrend || bearishTrend ? 20 : 10) : 0,
      momentum: direction && direction * histogram > 0 && (direction > 0 ? rsi >= 52 : rsi <= 48) ? 18 : direction ? 8 : 0,
      volume: Math.min(16, Math.round(Math.max(0, volumeRatio - .7) * 20)),
      breakoutQuality: orbBreak || previousDayBreak ? Math.min(18, 10 + Math.round(Math.min(2, volumeRatio) * 4)) : 4,
      candlestickPatterns: patternBias === direction ? 12 : patterns.length ? 4 : 2,
      indicatorAlignment: aligned * 4,
    };
    const aiScore = Object.values(scoreBreakdown).reduce((sum, value) => sum + value, 0);
    const signal: ScanRow['signal'] = direction > 0 && aiScore >= 48 ? 'BUY' : direction < 0 && aiScore >= 48 ? 'SELL' : 'HOLD';
    const signedScore = signal === 'SELL' ? -aiScore : signal === 'BUY' ? aiScore : 0;
    let confidence = signal === 'HOLD' ? Math.min(60, aiScore) : Math.min(95, 45 + Math.round(aiScore / 2));
    const tradeDirection = signal === 'BUY' ? 1 : signal === 'SELL' ? -1 : 0;
    const aggressiveEntry = tradeDirection ? live.price : null;
    const breakoutLevel = tradeDirection > 0 ? Math.max(n(indicators.openingRangeHigh), n(indicators.previousDayHigh)) : Math.min(n(indicators.openingRangeLow, Infinity), n(indicators.previousDayLow, Infinity));
    const candidateSafe = Number.isFinite(breakoutLevel) && Math.abs(breakoutLevel - live.price) / live.price <= .02 ? breakoutLevel : live.price - tradeDirection * atr * .25;
    const safeEntry = tradeDirection ? candidateSafe : null;
    const entry = aggressiveEntry;
    const stopDistance = Math.max(atr * 1.25, live.price * .003);
    const stopLoss = entry === null ? null : entry - tradeDirection * stopDistance;
    const target1 = entry === null ? null : entry + tradeDirection * stopDistance * 1.5;
    const target2 = entry === null ? null : entry + tradeDirection * stopDistance * 2.25;
    const target3 = entry === null ? null : entry + tradeDirection * stopDistance * 3;
    const validationError = this.validateTrade(signal, live.price, entry, safeEntry, aggressiveEntry, stopLoss, target1, target2, target3, orbBreak || previousDayBreak);
    if (validationError) {
      this.logger.warn(`Rejected invalid intraday setup | ${instrument.symbol} | ${signal} | ${validationError} | ${JSON.stringify({ marketPrice: live.price, entry, safeEntry, aggressiveEntry, stopLoss, target1, target2, target3 })}`);
      return null;
    }
    const riskReward = entry && stopLoss && target3 ? Math.abs(target3 - entry) / Math.abs(entry - stopLoss) : null;
    const trendLabel: ScanRow['trend'] = direction > 0 ? 'BULLISH' : direction < 0 ? 'BEARISH' : 'NEUTRAL';
    const ema200 = n(indicators.ema200);
    const adx = n(indicators.adx);
    const structure = indicators.marketStructure ?? {};
    const candleAnalysis = indicators.candleAnalysis ?? {};
    const latestCandle = indicators.latestCandle ?? {};
    const previousCandle = indicators.previousCandle ?? {};
    const openingGapPercent = n(indicators.openingGapPercent);
    const resistance = n(indicators.resistance, Infinity);
    const support = n(indicators.support, -Infinity);
    const alreadyExtended = signal === 'BUY'
      ? openingGapPercent >= 8 && (rsi >= 70 || live.price >= resistance * .995)
      : signal === 'SELL' ? openingGapPercent <= -8 && (rsi <= 30 || live.price <= support * 1.005) : false;
    if (alreadyExtended) {
      this.logger.warn(`Late entry rejected | ${instrument.symbol} | Gap: ${openingGapPercent.toFixed(2)}% | RSI: ${rsi.toFixed(1)} | Reason: Already Extended; Late Entry; Poor Risk Reward`);
      return null;
    }
    const lateEntryRisk = signal === 'BUY' && (live.changePercent >= 6 || live.price >= resistance * .99);
    if (lateEntryRisk) confidence = Math.min(confidence, 69);
    const strongDirectionalCandle = direction > 0
      ? String(candleAnalysis.current).includes('Strong Bullish')
      : direction < 0 ? String(candleAnalysis.current).includes('Strong Bearish') : false;
    const volumeIncreased = volumeRatio >= 1.2 && candleVolume >= n(previousCandle.volume);
    const candleClosedBeyondEntry = direction > 0
      ? n(latestCandle.close, live.price) >= candidateSafe
      : direction < 0 ? n(latestCandle.close, live.price) <= candidateSafe : false;
    const breakoutConfirmed = (orbBreak || previousDayBreak) && candleClosedBeyondEntry;
    const immediateReverse = direction > 0
      ? n(latestCandle.close) < n(latestCandle.open)
      : direction < 0 ? n(latestCandle.close) > n(latestCandle.open) : false;
    const fakeBreakout = (orbBreak || previousDayBreak) && (!candleClosedBeyondEntry || immediateReverse);
    const nextCandleConfirmed = Boolean(indicators.nextCandleConfirmed);
    const entryValidation = { strongBreakoutCandle: strongDirectionalCandle, volumeIncreased, vwapConfirmed: direction * (live.price - vwap) > 0, emaConfirmed: direction > 0 ? ema20 > ema50 && ema50 > ema200 : ema20 < ema50 && ema50 < ema200, candleClosedBeyondEntry, nextCandleConfirmed, nextCandleRejected: Boolean(indicators.nextCandleRejected), supportBreak: direction < 0 && previousDayBreak, resistanceBreak: direction > 0 && previousDayBreak, immediateReverse, fakeBreakout, breakoutConfirmed, lateEntry: lateEntryRisk, poorRiskReward: Boolean(riskReward && riskReward < 1.5) };
    const qualityPoints = aligned * 12 + (volumeIncreased ? 14 : 0) + (strongDirectionalCandle ? 14 : 0) + (breakoutConfirmed ? 16 : 0) + (adx >= 25 ? 10 : 0) + ((direction > 0 && structure.higherHigh && structure.higherLow) || (direction < 0 && structure.lowerLow && structure.lowerHigh) ? 10 : 0) - (fakeBreakout ? 35 : 0);
    const entryQuality: ScanRow['entryQuality'] = fakeBreakout ? 'Fake Breakout' : qualityPoints >= 80 ? 'Excellent' : qualityPoints >= 64 ? 'Good' : qualityPoints >= 48 ? 'Average' : qualityPoints >= 32 ? 'Weak' : 'Poor';
    const clamp = (value: number) => Math.max(1, Math.min(99, Math.round(value)));
    const continuationEvidence = (aligned / 4) * 35 + Math.min(adx, 50) * .4 + Math.min(volumeRatio, 3) * 8 + (breakoutConfirmed ? 12 : 0) - (fakeBreakout ? 30 : 0);
    const trendContinuation = clamp(25 + continuationEvidence);
    const target1Probability = clamp(confidence * .55 + trendContinuation * .35 + (riskReward && riskReward >= 1.5 ? 8 : 0));
    const probabilities = {
      target1: target1Probability,
      target2: clamp(target1Probability - 10 - Math.max(0, 1.2 - volumeRatio) * 8),
      target3: clamp(target1Probability - 24 - Math.max(0, 25 - adx) * .35),
      stopLoss: clamp(100 - target1Probability + (fakeBreakout ? 20 : 0)),
      reversal: clamp(100 - trendContinuation + (immediateReverse ? 20 : 0)),
      trendContinuation,
    };
    const trendStrength = adx >= 35 ? `Strong ${trendLabel === 'BULLISH' ? 'Bullish' : trendLabel === 'BEARISH' ? 'Bearish' : 'Sideways'}` : adx >= 25 ? (trendLabel === 'NEUTRAL' ? 'Sideways' : trendLabel[0] + trendLabel.slice(1).toLowerCase()) : adx >= 18 ? 'Weak' : 'Sideways';
    const aiDecision = signal === 'BUY' ? (confidence >= 90 && entryQuality === 'Excellent' ? 'Strong BUY' : 'BUY') : signal === 'SELL' ? (confidence >= 90 && entryQuality === 'Excellent' ? 'Strong SELL' : 'SELL') : 'WAIT';
    const aiExplanation = [
      `${direction > 0 ? '✔' : direction < 0 ? '✔' : '•'} Price ${direction > 0 ? 'above' : 'below'} VWAP`,
      `✔ EMA20 ${ema20 > ema50 ? '>' : '<'} EMA50 ${ema50 > ema200 ? '>' : '<'} EMA200`,
      `${volumeIncreased ? '✔' : '•'} Volume ${volumeRatio.toFixed(2)}× average`,
      `${strongDirectionalCandle ? '✔' : '•'} ${String(candleAnalysis.current ?? 'Candle unavailable')}`,
      `✔ RSI ${rsi.toFixed(1)}`,
      `${direction * histogram > 0 ? '✔' : '•'} MACD ${direction * histogram > 0 ? 'aligned' : 'mixed'}`,
      `${adx >= 25 ? '✔' : '•'} ADX ${adx.toFixed(1)}`,
      `${breakoutConfirmed ? '✔' : '•'} ${direction > 0 ? 'Resistance breakout' : 'Support breakdown'} ${breakoutConfirmed ? 'confirmed' : 'not confirmed'}`,
      `✔ Risk Reward 1:${(riskReward ?? 0).toFixed(2)}`,
      ...(lateEntryRisk ? ['✕ Already Extended', '✕ Late Entry', '✕ Poor Risk Reward', '✕ Avoid Buying'] : []),
    ];
    const tags = [volumeRatio >= 1.2 ? 'high-volume' : '', orbBreak || previousDayBreak ? 'breakout' : ''].filter(Boolean);
    const reason = `${timeframe} ${trendLabel.toLowerCase()} setup; EMA 9/20/50, VWAP, RSI, MACD and Supertrend alignment ${aligned}/4${orbBreak ? '; opening-range breakout' : ''}${previousDayBreak ? '; previous-day level breakout' : ''}; volume ${volumeRatio.toFixed(1)}x average.`;
    return { symbol: instrument.symbol, company: instrument.company, sector: instrument.sector || 'NSE Equity', instrumentKey: instrument.instrumentKey, ...universe, price: live.price, change: live.change, changePercent: live.changePercent, volume: live.volume, rsi, macd, ema9, ema20, ema50, vwap, previousDayHigh: indicators.previousDayHigh ?? null, previousDayLow: indicators.previousDayLow ?? null, todayHigh: indicators.todayHigh ?? null, todayLow: indicators.todayLow ?? null, openingRangeHigh: indicators.openingRangeHigh ?? null, openingRangeLow: indicators.openingRangeLow ?? null, signal, confidence, score: signedScore, aiScore, buyProbability: signal === 'BUY' ? confidence : Math.max(5, 50 + signedScore), sellProbability: signal === 'SELL' ? confidence : Math.max(5, 50 - signedScore), holdProbability: signal === 'HOLD' ? 100 - aiScore : Math.max(0, 100 - confidence), tags, indicators: { ...indicators, volumeRatio, orbBreak, previousDayBreak, riskReward }, scoreBreakdown, trend: trendLabel, entry, buyLevel: signal === 'BUY' ? entry : null, sellLevel: signal === 'SELL' ? entry : null, safeEntry, aggressiveEntry, stopLoss, target1, target2, target3, riskReward, expectedProfitPercent: entry && target3 ? Math.abs(target3 - entry) / entry * 100 : null, expectedLossPercent: entry && stopLoss ? Math.abs(entry - stopLoss) / entry * 100 : null, riskLevel: atr / live.price < .008 ? 'LOW' : atr / live.price < .015 ? 'MEDIUM' : 'HIGH', intradayScore: aiScore, signalStrength: aiScore >= 75 ? `STRONG ${signal}` : signal, timeframe, lastUpdated: new Date().toISOString(), reason, patterns, entryQuality, entryValidation, probabilities, candleAnalysis, trendStrength, aiDecision, aiExplanation, openingGapPercent };
  }

  private validateTrade(signal: ScanRow['signal'], marketPrice: number, entry: number | null, safeEntry: number | null, aggressiveEntry: number | null, stopLoss: number | null, target1: number | null, target2: number | null, target3: number | null, breakout: boolean) {
    if (signal === 'HOLD') return null;
    const levels = { entry, safeEntry, aggressiveEntry, stopLoss, target1, target2, target3 };
    for (const [name, value] of Object.entries(levels)) if (!Number.isFinite(value) || Number(value) <= 0) return `${name} is missing or non-positive`;
    if (!breakout && [entry!, safeEntry!, aggressiveEntry!].some((value) => Math.abs(value - marketPrice) / marketPrice > .02)) return 'an entry level is more than 2% from current market price without a breakout justification';
    if (signal === 'BUY' && !(stopLoss! < entry! && target1! > entry! && target2! > target1! && target3! > target2!)) return 'BUY requires SL < Entry < T1 < T2 < T3';
    if (signal === 'SELL' && !(stopLoss! > entry! && target1! < entry! && target2! < target1! && target3! < target2!)) return 'SELL requires SL > Entry > T1 > T2 > T3';
    return null;
  }

  private async pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) { let next = 0; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (next < items.length) { const item = items[next++]; await worker(item); } })); }
  private stage(number: number, name: string) { this.logger.log('------------------------------------------------'); this.logger.log(`Stage ${number}`); this.logger.log('------------------------------------------------'); this.logger.log(name); }
  private errorDetails(error: unknown) { if (error && typeof error === 'object' && 'getResponse' in error && typeof (error as { getResponse?: unknown }).getResponse === 'function') return JSON.stringify((error as { getResponse: () => unknown }).getResponse()); return error instanceof Error ? error.stack ?? error.message : String(error); }
}
