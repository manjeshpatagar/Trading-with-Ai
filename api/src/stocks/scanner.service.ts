import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadGatewayException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { Cache } from 'cache-manager';
import { PrismaService } from '../prisma.service';
import { Candle, IndicatorService } from './indicator.service';
import { UpstoxService } from './upstox.service';
import { MarketGateway } from './market.gateway';

type Instrument = { instrument_key?: string; trading_symbol?: string; exchange?: string; isin?: string; name?: string; instrument_token?: string; exchange_token?: string; instrument_type?: string; segment?: string; status?: string };
type Live = { price: number; change: number; changePercent: number; volume: number };
export type ScanRow = { symbol: string; company: string; instrumentKey: string; price: number; change: number; changePercent: number; volume: number; rsi: number | null; macd: number | null; ema9: number | null; ema20: number | null; ema50: number | null; vwap: number | null; previousDayHigh: number | null; previousDayLow: number | null; todayHigh: number | null; todayLow: number | null; openingRangeHigh: number | null; openingRangeLow: number | null; signal: 'BUY' | 'SELL' | 'HOLD'; confidence: number; score: number; aiScore: number; buyProbability: number; sellProbability: number; holdProbability: number; tags: string[]; indicators: Record<string, unknown>; scoreBreakdown: Record<'trend' | 'momentum' | 'volume' | 'breakoutQuality' | 'candlestickPatterns' | 'indicatorAlignment', number>; trend: 'BULLISH' | 'BEARISH' | 'NEUTRAL'; entry: number | null; buyLevel: number | null; sellLevel: number | null; safeEntry: number | null; aggressiveEntry: number | null; stopLoss: number | null; target1: number | null; target2: number | null; target3: number | null; riskReward: number | null; expectedProfitPercent: number | null; expectedLossPercent: number | null; riskLevel: 'LOW' | 'MEDIUM' | 'HIGH'; intradayScore: number; signalStrength: string; timeframe: string; lastUpdated: string; reason: string; patterns: string[] };

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);
  constructor(private readonly upstox: UpstoxService, private readonly indicators: IndicatorService, private readonly prisma: PrismaService, private readonly market: MarketGateway, @Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  async scan(userId: string) {
    const startedAt = Date.now();
    const cacheKey = `scanner:${userId}`;
    const cached = await this.cache.get<ScanRow[]>(cacheKey);
    if (cached?.length) return cached;
    this.stage(1, 'Instrument universe');
    const instruments = await this.syncInstruments();
    this.logger.log(`Loaded NSE instruments: ${instruments.length}`);
    if (!instruments.length) throw new ServiceUnavailableException('Scanner failed at Stage 1: zero active NSE EQ instruments were loaded. See ScannerService logs for the downloaded instrument fields and rejected-record reasons.');
    this.stage(2, 'Live quotes');
    const firstInstrument = instruments[0];
    this.logger.log(`[SCANNER FIRST INSTRUMENT — DATABASE] ${JSON.stringify({ instrumentKey: firstInstrument.instrumentKey, symbol: firstInstrument.symbol })}`);
    const quoteResult = await this.livePrices(userId, instruments.map((item) => item.instrumentKey), firstInstrument.instrumentKey);
    const live = quoteResult.prices;
    this.logger.log(`Quotes requested: ${quoteResult.requested}`);
    this.logger.log(`Quotes received: ${live.size}`);
    this.logger.log(`Quotes failed: ${quoteResult.failed}`);
    if (!live.size) throw new ServiceUnavailableException(`Scanner failed at Stage 2: quotes requested ${quoteResult.requested}, quotes received 0, quotes failed ${quoteResult.failed}. See ScannerService logs for each Upstox LTP request and response.`);
    const firstQuote = live.get(firstInstrument.instrumentKey);
    this.logger.log(`[SCANNER FIRST INSTRUMENT — LOOKUP] ${JSON.stringify({ instrumentKey: firstInstrument.instrumentKey, mapKeys: [...live.keys()], lookupResult: firstQuote ?? null })}`);
    this.logger.log(`[SCANNER FIRST INSTRUMENT — QUOTE] ${JSON.stringify({ quote: firstQuote ?? null, quotePrice: firstQuote?.price, quotePriceType: typeof firstQuote?.price })}`);
    if (firstQuote?.price === undefined) this.logger.warn(`[SCANNER FIRST INSTRUMENT] quote.price is undefined; continuing with other NSE equities as required.`);
    const universe = instruments.filter((instrument) => { const quote = live.get(instrument.instrumentKey); return quote && quote.price >= 50 && quote.price <= 600; }).sort((a, b) => (live.get(b.instrumentKey)?.volume ?? 0) - (live.get(a.instrumentKey)?.volume ?? 0)).slice(0, 100);
    this.logger.log(`Stage 2 liquidity universe | LTP ₹50–₹600 candidates: ${instruments.filter((instrument) => { const quote = live.get(instrument.instrumentKey); return quote && quote.price >= 50 && quote.price <= 600; }).length} | Selected Top 100 by live volume: ${universe.length}`);
    if (!universe.length) throw new ServiceUnavailableException('Scanner failed at Stage 2: no NSE EQ instruments with a valid LTP between ₹50 and ₹600.');
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
        if (candles.length < 50) {
          indicatorsSkipped += 1;
          this.logger.warn(`Stage 4 indicator skipped | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Reason: only ${candles.length} intraday 5m candles returned; 50 are required for EMA50`);
          return;
        }
        candles[candles.length - 1].close = quote.price;
        const values = this.indicators.calculate(candles);
        if (!values.ema50 || !values.rsi || !values.macd || !values.atr || !values.vwap) {
          indicatorsSkipped += 1;
          this.logger.warn(`Stage 4 indicator skipped | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Reason: required intraday output missing | Indicator status: ${JSON.stringify({ ema50: values.ema50, rsi: values.rsi, macd: values.macd, atr: values.atr, vwap: values.vwap })}`);
          return;
        }
        indicatorsCalculated += 1;
        this.logger.log(`Stage 4 indicators calculated | Instrument key: ${instrument.instrumentKey} | Trading symbol: ${instrument.symbol} | Indicator status: success`);
        const row = this.score(instrument, quote, values, '5m');
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
    const buy = rows.filter((row) => row.signal === 'BUY').sort((a, b) => b.aiScore - a.aiScore).slice(0, 10);
    const sell = rows.filter((row) => row.signal === 'SELL').sort((a, b) => b.aiScore - a.aiScore).slice(0, 10);
    this.logger.log(`Top Buy Count: ${buy.length}`);
    this.logger.log(`Top Sell Count: ${sell.length}`);
    this.logger.log(`Total scan time: ${Date.now() - startedAt}ms`);
    // An empty BUY or SELL side is a genuine market outcome, not a scanner
    // failure.  Only fail the scanner if no live-data rows were calculated.
    if (!rows.length) {
      const failedStage = !instruments.length ? 1 : !live.size ? 2 : !historicalSuccess ? 3 : !indicatorsCalculated ? 4 : 5;
      const summary = { failedStage, instruments: instruments.length, quotesRequested: quoteResult.requested, quotesReceived: live.size, quotesFailed: quoteResult.failed, historicalRequests, historicalSuccess, historicalFailures, indicatorsCalculated, indicatorsSkipped, patternsDetected, aiScoreCount, buyCount, sellCount, holdCount, totalScanned: rows.length, topBuy: buy.length, topSell: sell.length, totalScanTimeMs: Date.now() - startedAt };
      this.logger.error(`Scanner failure summary: ${JSON.stringify(summary)}`);
      throw new ServiceUnavailableException(`Scanner failed at Stage ${failedStage}. ${JSON.stringify(summary)}`);
    }
    await this.cache.set(cacheKey, rows, 60_000);
    return rows;
  }

  async filtered(userId: string, filter = 'all') {
    const rows = await this.scan(userId);
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
    const results = rows.filter(selected).sort((a, b) => b.aiScore - a.aiScore);
    return results;
  }

  private async syncInstruments() {
    const downloaded = await this.upstox.nseEquityInstruments() as Instrument[];
    this.logger.log(`Stage 1 raw Upstox instrument records: ${downloaded.length}`);
    this.logger.log(`Stage 1 instrument sample: ${JSON.stringify(downloaded.slice(0, 3))}`);
    const rejected: Record<string, number> = {};
    const instruments = downloaded.flatMap((item) => {
      const reason = item.exchange !== 'NSE' ? `exchange=${item.exchange}` : item.instrument_type !== 'EQ' ? `instrument_type=${item.instrument_type}` : !item.instrument_key ? 'missing instrument_key' : !item.trading_symbol ? 'missing trading_symbol' : item.status === 'inactive' ? 'status=inactive' : '';
      if (reason) { rejected[reason] = (rejected[reason] ?? 0) + 1; return []; }
      return [{ instrumentKey: item.instrument_key!, symbol: item.trading_symbol!, exchange: item.exchange!, isin: item.isin || null, company: item.name || item.trading_symbol!, token: String(item.exchange_token ?? item.instrument_token ?? ''), active: true }];
    });
    this.logger.log(`Stage 1 rejected instrument reasons: ${JSON.stringify(rejected)}`);
    if (!instruments.length) throw new ServiceUnavailableException('The downloaded Upstox NSE instrument list contained no active EQ instruments.');
    await this.prisma.$transaction(instruments.map((item) => this.prisma.nseInstrument.upsert({ where: { instrumentKey: item.instrumentKey }, create: item, update: item })));
    return instruments;
  }

  private async livePrices(userId: string, keys: string[], firstInstrumentKey: string) {
    const prices = new Map<string, Live>();
    let failed = 0;
    let firstResponseLogged = false;
    // Keep request URLs safely below proxy limits while still using batched LTP calls.
    await this.pool(this.chunks(keys, 100), 3, async (batch) => {
      try {
        // Market Data Feed is used by the gateway for subscribed UI symbols. The scanner's
        // reliable bulk fallback is this documented V3 LTP endpoint.
        const response: any = await this.upstox.ltp(userId, batch.join(','));
        const data = response?.data ?? response ?? {};
        if (!firstResponseLogged && batch.includes(firstInstrumentKey)) {
          firstResponseLogged = true;
          this.logger.log(`[SCANNER FIRST INSTRUMENT — LTP RAW JSON] ${JSON.stringify(response)}`);
        }
        this.logger.log(`Stage 2 quote response | Requested keys: ${batch.length} | Response: ${JSON.stringify(response)}`);
        for (const [key, value] of Object.entries<any>(data)) {
          // V3's object key is a display symbol (for example NSE_EQ:NHPC),
          // not the instrument_key used by the master and historical APIs.
          // instrument_token is the canonical NSE_EQ|ISIN key.
          const canonicalKey = typeof value?.instrument_token === 'string' ? value.instrument_token : undefined;
          const rawPrice = value?.last_price ?? value?.ltp ?? value?.lastPrice;
          const priceField = value?.last_price !== undefined ? 'last_price' : value?.ltp !== undefined ? 'ltp' : value?.lastPrice !== undefined ? 'lastPrice' : 'none';
          const price = Number(rawPrice);
          const close = Number(value.cp ?? value.ohlc?.close ?? price);
          if (canonicalKey && Number.isFinite(price)) {
            prices.set(canonicalKey, { price, change: price - close, changePercent: close ? (price - close) / close * 100 : 0, volume: Number(value.volume ?? value.oi ?? 0) });
            if (canonicalKey === firstInstrumentKey) this.logger.log(`[SCANNER FIRST INSTRUMENT — MAP KEY INSERTED] ${JSON.stringify({ responseObjectKey: key, instrumentToken: value.instrument_token, mapKey: canonicalKey, priceField, price })}`);
          } else {
            failed += 1;
            this.logger.warn(`Stage 2 invalid quote | Response object key: ${key} | Canonical instrument_token: ${canonicalKey ?? 'missing'} | Quote response: ${JSON.stringify(value)} | Reason: ${!canonicalKey ? 'missing instrument_token' : `no finite ${priceField} value`}`);
          }
        }
        for (const key of batch) if (!prices.has(key)) { failed += 1; this.logger.warn(`Stage 2 quote missing | Instrument key: ${key} | Reason: no LTP response entry had instrument_token exactly equal to the requested instrument_key`); }
      } catch (error) {
        failed += batch.length;
        const reason = error instanceof Error ? error.message : String(error);
        for (const key of batch) this.logger.warn(`Stage 2 quote failure | Instrument key: ${key} | API error/response: ${this.errorDetails(error)} | Reason: ${reason} | Continuing scan`);
      }
    });
    return { prices, requested: keys.length, failed };
  }

  private async intradayCandles(userId: string, key: string, interval: 1 | 3 | 5 | 15 | 30) {
    const cacheKey = `candles:${userId}:${key}:minutes:${interval}`;
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

  private score(instrument: { instrumentKey: string; symbol: string; company: string }, live: Live, indicators: any, timeframe: string): ScanRow | null {
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
    const confidence = signal === 'HOLD' ? Math.min(60, aiScore) : Math.min(95, 45 + Math.round(aiScore / 2));
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
    const tags = [volumeRatio >= 1.2 ? 'high-volume' : '', orbBreak || previousDayBreak ? 'breakout' : ''].filter(Boolean);
    const reason = `${timeframe} ${trendLabel.toLowerCase()} setup; EMA 9/20/50, VWAP, RSI, MACD and Supertrend alignment ${aligned}/4${orbBreak ? '; opening-range breakout' : ''}${previousDayBreak ? '; previous-day level breakout' : ''}; volume ${volumeRatio.toFixed(1)}x average.`;
    return { symbol: instrument.symbol, company: instrument.company, instrumentKey: instrument.instrumentKey, price: live.price, change: live.change, changePercent: live.changePercent, volume: live.volume, rsi, macd, ema9, ema20, ema50, vwap, previousDayHigh: indicators.previousDayHigh ?? null, previousDayLow: indicators.previousDayLow ?? null, todayHigh: indicators.todayHigh ?? null, todayLow: indicators.todayLow ?? null, openingRangeHigh: indicators.openingRangeHigh ?? null, openingRangeLow: indicators.openingRangeLow ?? null, signal, confidence, score: signedScore, aiScore, buyProbability: signal === 'BUY' ? confidence : Math.max(5, 50 + signedScore), sellProbability: signal === 'SELL' ? confidence : Math.max(5, 50 - signedScore), holdProbability: signal === 'HOLD' ? 100 - aiScore : Math.max(0, 100 - confidence), tags, indicators: { ...indicators, volumeRatio, orbBreak, previousDayBreak, riskReward }, scoreBreakdown, trend: trendLabel, entry, buyLevel: signal === 'BUY' ? entry : null, sellLevel: signal === 'SELL' ? entry : null, safeEntry, aggressiveEntry, stopLoss, target1, target2, target3, riskReward, expectedProfitPercent: entry && target3 ? Math.abs(target3 - entry) / entry * 100 : null, expectedLossPercent: entry && stopLoss ? Math.abs(entry - stopLoss) / entry * 100 : null, riskLevel: atr / live.price < .008 ? 'LOW' : atr / live.price < .015 ? 'MEDIUM' : 'HIGH', intradayScore: aiScore, signalStrength: aiScore >= 75 ? `STRONG ${signal}` : signal, timeframe, lastUpdated: new Date().toISOString(), reason, patterns };
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

  private chunks<T>(items: T[], size: number) { return Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size)); }
  private async pool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) { let next = 0; await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => { while (next < items.length) { const item = items[next++]; await worker(item); } })); }
  private stage(number: number, name: string) { this.logger.log('------------------------------------------------'); this.logger.log(`Stage ${number}`); this.logger.log('------------------------------------------------'); this.logger.log(name); }
  private errorDetails(error: unknown) { if (error && typeof error === 'object' && 'getResponse' in error && typeof (error as { getResponse?: unknown }).getResponse === 'function') return JSON.stringify((error as { getResponse: () => unknown }).getResponse()); return error instanceof Error ? error.stack ?? error.message : String(error); }
}
