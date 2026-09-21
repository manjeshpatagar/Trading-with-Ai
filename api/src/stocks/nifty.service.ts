import { niftyDataHealth } from './nifty-data-health';
import { rankOptions } from './nifty-option-engine';
import { NiftyDemoService } from './nifty-demo.service';
import { EMA } from 'technicalindicators';
import { Worker } from 'node:worker_threads';
import type { Outcome, simulate } from './nifty-backtest';
import { BadRequestException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { UpstoxService } from './upstox.service';
import { MarketGateway } from './market.gateway';
import type { Candle } from './indicator.service';
import { aggregate, bucket, defaults, evaluate, evaluateAll, exchangeDate, exchangeTime, indicators, keyLevels, lifecycle, NIFTY_KEY, optionLiquidityPass, positionSize, sessionFilters, Settings, strategies } from './nifty-engine';
type Evaluation = ReturnType<typeof evaluate>;
type OptionContract = {
  instrumentKey: string;
  symbol: string;
  expiry: string;
  strike: number;
  type: string;
  lotSize: number;
  ltp: number;
  bid: number;
  ask: number;
  spreadPercent: number;
  volume: number;
  oi: number | null;
  iv: number | null;
  delta: number | null;
  timestamp: number;
  quantity: number;
  maximumRisk: number;
};
type State = {
  candles: Candle[];
  evaluations: Evaluation[];
  loadedAt: number;
  lastEvaluation: number;
  open: number | null;
  close: number | null;
  sessionError: string | null;
  option: OptionContract | null;
  optionDataDelayed: boolean;
  optionAt: number;
  optionSide: string | null;
  error: string | null;
  settings: Settings;
  lastTick: number;
  lastVolume: number | null;
  lastVolumeDate: string | null;
  lastOptionTick: number;
  busy: boolean;
};
const terminal = ['TARGET_3_HIT', 'STOP_LOSS', 'AUTO_EXIT', 'BREAKEVEN', 'CANCELLED', 'EXPIRED'];
@Injectable()
export class NiftyService implements OnModuleDestroy, OnModuleInit {
  private readonly log = new Logger(NiftyService.name);
  private readonly states = new Map<string, State>();
  private readonly recordedOpportunities = new Map<string, Set<string>>();
  private readonly loading = new Map<string, Promise<State>>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly activeCache = new Map<string, {
    at: number;
    rows: Awaited<ReturnType<NiftyService['activeSignals']>>;
  }>();
  private readonly historicalCache = new Map<string, {
    at: number;
    rows: Array<{
      side?: string;
      regime?: string;
      strategy: string;
      sampleSize: number;
      sufficient: boolean;
      expectancyR: number | null;
      winRate: number | null;
    }>;
  }>();
  private readonly performanceCache = new Map<string, {
    at: number;
    value: Awaited<ReturnType<NiftyService['performance']>>;
  }>();
  private readonly riskCache = new Map<string, {
    at: number;
    value: Awaited<ReturnType<NiftyService['risk']>>;
  }>();
  private activeSignals(userId: string) { return this.prisma.aiSignal.findMany({ where: { userId, instrumentKey: NIFTY_KEY, niftyContext: { isNot: null }, status: { notIn: terminal } }, include: { niftyContext: true } }); }
  private invalidate(userId: string) { this.activeCache.delete(userId); this.riskCache.delete(userId); this.performanceCache.delete(userId); this.historicalCache.delete(userId); }
  private readonly unsubscribe: () => void;
  constructor(private readonly prisma: PrismaService, private readonly upstox: UpstoxService, private readonly market: MarketGateway, private readonly demo: NiftyDemoService) { this.unsubscribe = this.market.onPrice((userId, key, price, timestamp, volume) => { const state = this.states.get(userId); if (!state)
    return; if (key !== NIFTY_KEY && key !== state.option?.instrumentKey)
    return; const next = (this.queues.get(userId) ?? Promise.resolve()).catch(() => undefined).then(() => this.tick(userId, key, price, timestamp, volume)).catch(error => { this.log.error(String(error)); state.error = 'Live strategy update failed; new trades disabled'; }); this.queues.set(userId, next); void next.finally(() => { if (this.queues.get(userId) === next)
    this.queues.delete(userId); }); }); }
  async onModuleInit() { const rows = await this.prisma.aiSignal.findMany({ where: { niftyContext: { isNot: null }, status: { notIn: terminal } }, select: { userId: true }, distinct: ['userId'] }); for (const row of rows)
    await this.load(row.userId); }
  onModuleDestroy() { this.unsubscribe(); }
  async settings(userId: string): Promise<Settings> { const record = await this.prisma.niftyRiskConfiguration.findUnique({ where: { userId } }); return { ...defaults, ...(record ? JSON.parse(record.settings) as Partial<Settings> : {}) }; }
  async saveSettings(userId: string, body: Record<string, unknown>) {
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new BadRequestException('Settings must be an object');
    const current = await this.settings(userId);
    for (const [key, value] of Object.entries(body)) {
      if (!Object.prototype.hasOwnProperty.call(defaults, key))
        throw new BadRequestException(`Unknown setting: ${key}`);
      const original = defaults[key as keyof Settings];
      if (typeof original === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || (value < 0 && key !== 'strikeOffset')))
        throw new BadRequestException(`Invalid ${key}`);
      if (typeof original === 'boolean' && typeof value !== 'boolean')
        throw new BadRequestException(`Invalid ${key}`);
      if (typeof original === 'string' && (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)))
        throw new BadRequestException(`Invalid ${key}`);
    }
    const s = { ...current, ...body } as Settings;
    if (s.primaryTimeframe !== 15 || s.setupTimeframe !== 5 || s.confirmationTimeframe !== 3)
      throw new BadRequestException('Direction/setup/confirmation must use 15M/5M/3M');
    if (s.optionStopPercent <= 0 || s.optionStopPercent >= 100 || s.optionTargetR < 3 || s.optionTargetR < s.minimumRR || s.optionTargetR > 10 || !Number.isInteger(s.expiryMinimumDays) || s.expiryMinimumDays > 30 || s.minimumScore > 100 || s.riskPercent <= 0 || s.riskPercent > 5 || s.dailyLossPercent <= 0 || s.dailyLossPercent > 100 || s.capital <= 0 || s.minimumRR < 1 || s.staleMs < 1000 || s.minimumSamples < 30 || s.squareOff <= s.cutoff || s.squareOff >= '15:30' || s.cutoff <= '09:30' || s.openingRangeMinutes < 15 || s.openingRangeMinutes > 60 || s.minimumVolumeRatio < 1 || s.safetyBuffer <= 0 || s.minimumLevelDistance <= 0 || s.maximumSpreadPercent <= 0 || s.minimumOptionVolume <= 0 || s.maxTrades < 1 || s.maxConsecutiveLosses < 1 || !Number.isInteger(s.maxTrades) || !Number.isInteger(s.maxConsecutiveLosses) || !Number.isInteger(s.openingRangeMinutes) || !Number.isInteger(s.strikeOffset) || Math.abs(s.strikeOffset) > 5)
      throw new BadRequestException('Invalid Nifty risk/session configuration');
    if (!Array.isArray(s.enabledStrategies) || s.enabledStrategies.some(v => !strategies.includes(v)))
      throw new BadRequestException('Invalid strategies');
    if (!Array.isArray(s.windows) || s.windows.length > 8 || s.windows.some(w => !Array.isArray(w) || w.length !== 2 || w.some(t => typeof t !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(t)) || w[0] >= w[1]))
      throw new BadRequestException('Invalid trading windows');
    await this.prisma.niftyRiskConfiguration.upsert({ where: { userId }, create: { userId, settings: JSON.stringify(s) }, update: { settings: JSON.stringify(s) } });
    const state = this.states.get(userId);
    this.invalidate(userId);
    if (state) {
      state.settings = s;
      state.lastEvaluation = 0;
      state.optionAt = 0;
    }
    return s;
  }
  normalize(payload: {
    data?: {
      candles?: unknown[][];
    };
  }): Candle[] { const rows = payload.data?.candles; if (!Array.isArray(rows))
    return []; return rows.flatMap(r => { if (!Array.isArray(r))
    return []; const timestamp = Date.parse(String(r[0])); if (!Number.isFinite(timestamp))
    return []; const c = { time: new Date(timestamp).toISOString(), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5]) }; return [c.open, c.high, c.low, c.close, c.volume].every(Number.isFinite) && c.open > 0 && c.low > 0 && c.volume >= 0 && c.high >= Math.max(c.open, c.close, c.low) && c.low <= Math.min(c.open, c.close, c.high) ? [c] : []; }).sort((a, b) => Date.parse(a.time) - Date.parse(b.time)); }
  async load(userId: string): Promise<State> { const pending = this.loading.get(userId); if (pending)
    return pending; const old = this.states.get(userId); if (old)
    return old; const task = this.initialize(userId); this.loading.set(userId, task); try {
    return await task;
  }
  finally {
    this.loading.delete(userId);
  } }
  private async initialize(userId: string) { const settings = await this.settings(userId); const state: State = { candles: [], evaluations: [], loadedAt: 0, lastEvaluation: 0, open: null, close: null, sessionError: null, option: null, optionDataDelayed: true, optionAt: 0, optionSide: null, error: null, settings, lastTick: 0, lastVolume: null, lastVolumeDate: null, lastOptionTick: 0, busy: false }; this.states.set(userId, state); try {
    await this.refreshData(userId, state);
  }
  catch (error) {
    state.error = error instanceof Error ? error.message : 'Market data unavailable';
  } void this.market.subscribe(userId, NIFTY_KEY).catch(error => { state.error = String(error); }); return state; }
  private async refreshData(userId: string, state: State) {
    const previousLoadedAt = state.loadedAt;
    const now = new Date();
    const to = exchangeDate(now), from = exchangeDate(new Date(now.getTime() - 10 * 86400000));
    const results = await Promise.allSettled([this.upstox.history(userId, NIFTY_KEY, 'minutes', 1, to, from), this.upstox.intraday(userId, NIFTY_KEY, 'minutes', 1), this.upstox.marketTimings(userId, to)]);
    const rows: Candle[] = [];
    for (const result of results.slice(0, 2))
      if (result.status === 'fulfilled')
        rows.push(...this.normalize(result.value));
    if (!rows.length)
      throw new Error('Nifty candles unavailable. Reconnect Upstox or check market-data access.');
    const unique = new Map(rows.map(c => [c.time, c]));
    for (const c of state.candles)
      if (Date.parse(c.time) >= now.getTime() - 120000 && (!unique.has(c.time) || Date.parse(c.time) >= bucket(now.getTime(), 1)))
        unique.set(c.time, { ...c, volume: Math.max(c.volume, unique.get(c.time)?.volume ?? 0) });
    state.candles = [...unique.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time)).slice(-5000);
    state.loadedAt = Date.now();
    state.lastEvaluation = 0;
    state.error = results[0].status === 'rejected' ? 'Historical candle request failed; direction may lack sufficient history' : null;
    const timing = results[2];
    state.open = null;
    state.close = null;
    state.sessionError = null;
    if (timing.status === 'fulfilled') {
      const row = (timing.value.data as Array<{
        exchange: string;
        start_time: number;
        end_time: number;
      }> | undefined)?.find(r => r.exchange === 'NSE');
      if (row) {
        state.open = Number(row.start_time);
        state.close = Number(row.end_time);
      }
      else
        state.sessionError = 'Exchange reports no NSE session today';
    }
    else
      state.sessionError = 'Exchange session configuration unavailable';
    // Shared historical cache; no parallel duplicate candle service/model.
    await this.prisma.$transaction(state.candles.filter(c => previousLoadedAt === 0 || Date.parse(c.time) >= previousLoadedAt - 120000).map(c => this.prisma.historicalCandle.upsert({ where: { instrumentKey_timeframe_candleTime: { instrumentKey: NIFTY_KEY, timeframe: '1m', candleTime: new Date(c.time) } }, create: { instrumentKey: NIFTY_KEY, timeframe: '1m', candleTime: new Date(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }, update: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume } })));
  }
  async history(userId: string, query: {
    from?: string;
    to?: string;
    strategy?: string;
    side?: string;
    regime?: string;
    window?: string;
  } = {}) { const where = { userId, instrumentKey: NIFTY_KEY, niftyContext: { isNot: null }, ...(query.strategy ? { strategy: query.strategy } : {}), ...(query.side ? { side: query.side } : {}), ...((query.from || query.to) ? { signalTime: { ...(query.from ? { gte: new Date(`${query.from}T00:00:00+05:30`) } : {}), ...(query.to ? { lte: new Date(`${query.to}T23:59:59+05:30`) } : {}) } } : {}) }; const rows = await this.prisma.aiSignal.findMany({ where, include: { niftyContext: true, events: { orderBy: { eventTime: 'asc' } } }, orderBy: { signalTime: 'desc' }, take: 1000 }); return rows.filter(r => { const inputs = JSON.parse(r.niftyContext!.inputs) as {
    regime: string;
  }; return (!query.regime || inputs.regime === query.regime) && (!query.window || (query.window === 'MORNING' ? exchangeTime(r.signalTime) < '11:30' : exchangeTime(r.signalTime) >= '13:30')); }).map(row => { const quote = this.market.latestUserSnapshot(userId, NIFTY_KEY); return !row.completedAt && quote ? { ...row, currentPrice: quote.ltp, marketTimestamp: quote.timestamp } : { ...row, marketTimestamp: null }; }); }
  async risk(userId: string, s: Settings) {
    const account = await this.prisma.paperTradingAccount.findUnique({where:{userId_portfolio:{userId,portfolio:'NIFTY'}}});
    const rows = await this.prisma.paperOrder.findMany({where:{userId,portfolio:'NIFTY'},orderBy:{entryTime:'desc'}});
    const today = rows.filter(r => r.entryTime && exchangeDate(r.entryTime) === exchangeDate(new Date()));
    const closed = today.filter(r=>r.status === 'CLOSED');
    let consecutive = 0;
    for (const row of rows.filter(r=>r.status === 'CLOSED')) { if(row.pnl >= 0) break; consecutive++; }
    const losses = Math.max(0,-closed.reduce((t,r)=>t+r.pnl,0));
    const reserved = rows.filter(r=>r.status === 'OPEN').reduce((t,r)=>t+(r.niftyDemo ? JSON.parse(r.niftyDemo).risk : 0),0);
    const capital = (account?.startingBalance ?? 10000)+(account?.realizedPnl ?? 0);
    const reasons: string[] = [];
    if(today.length >= s.maxTrades) reasons.push('Daily trade limit reached');
    if(consecutive >= s.maxConsecutiveLosses) reasons.push('Consecutive loss limit reached');
    const remaining = Math.max(0,(account?.startingBalance ?? 10000)*s.dailyLossPercent/100-losses-reserved);
    if(!remaining) reasons.push('Daily loss/risk reservation limit reached');
    if(rows.some(r=>r.status === 'OPEN') || (await this.activeSignals(userId)).length) reasons.push('An existing Nifty setup/position is active');
    return {trades:today.length,consecutiveLosses:consecutive,losses,reserved,remaining,maximumRisk:capital*s.riskPercent/100,reasons};
  }
  private async selectOption(userId: string, state: State, e: Evaluation) {
    const now = Date.now();
    if (now - state.optionAt < 10000 && state.optionSide === e.side)
      return state.option;
    state.optionAt = now;
    state.optionSide = e.side;
    state.option = null;
    state.optionDataDelayed = false;
    const snapshot = this.market.latestUserSnapshot(userId, NIFTY_KEY);
    if (!snapshot)
      return null;
    const contracts = await this.upstox.optionContracts(userId, NIFTY_KEY) as {
      data: Array<{
        instrument_key: string;
        trading_symbol: string;
        expiry: string;
        strike_price: number;
        instrument_type: string;
        lot_size: number;
      }>;
    };
    const dates = [...new Set((contracts.data ?? []).map(c => c.expiry))].filter(d => d >= exchangeDate(new Date(Date.now() + state.settings.expiryMinimumDays * 86400000))).sort();
    const expiry = dates[0];
    if (!expiry)
      return null;
    const chain = await this.upstox.optionChain(userId, NIFTY_KEY, expiry) as {
      data: Array<{
        strike_price: number;
        call_options: ChainOption;
        put_options: ChainOption;
      }>;
    };
    const type = e.side === 'BUY' ? 'CE' : 'PE';
    const eligible = (contracts.data ?? []).filter(c => c.expiry === expiry && c.instrument_type === type).sort((a, b) => a.strike_price - b.strike_price);
    const atm = eligible.reduce((best, c, i) => Math.abs(c.strike_price - snapshot.ltp) < Math.abs(eligible[best].strike_price - snapshot.ltp) ? i : best, 0);
    const nearby = eligible.filter((_, i) => Math.abs(i - atm) <= 2);
    const candidates: OptionContract[] = [];
    const account = await this.prisma.paperTradingAccount.findUnique({where:{userId_portfolio:{userId,portfolio:'NIFTY'}}});
    const capital = (account?.startingBalance ?? 10000)+(account?.realizedPnl ?? 0);
    for (const contract of nearby) {
      const row = chain.data?.find(r => r.strike_price === contract.strike_price);
      const option = type === 'CE' ? row?.call_options : row?.put_options;
      if (!option || option.instrument_key !== contract.instrument_key) continue;
      await this.market.subscribe(userId, contract.instrument_key);
      const book = this.market.latestOptionBook(userId, contract.instrument_key);
      const tick = this.market.latestUserSnapshot(userId, contract.instrument_key);
      if (!book || !tick || !tick.timestampTrusted || now-tick.timestamp > state.settings.staleMs) state.optionDataDelayed = true;
      if (!book || !tick || !optionLiquidityPass({ltp: book.ltp, bid: book.bid, ask: book.ask, volume: book.volume, lotSize: contract.lot_size, timestamp: tick.timestamp, timestampTrusted: tick.timestampTrusted}, state.settings, Date.now())) continue;
      const riskPerUnit = book.ask * state.settings.optionStopPercent / 100;
      const quantity = positionSize(capital, state.settings.riskPercent, book.ask, riskPerUnit, contract.lot_size);
      if (!quantity) continue;
      candidates.push({ instrumentKey: contract.instrument_key, symbol: contract.trading_symbol, expiry, strike: contract.strike_price, type, lotSize: contract.lot_size, ltp: tick.ltp, bid: book.bid, ask: book.ask, spreadPercent: (book.ask-book.bid)/book.ltp*100, volume: book.volume, oi: book.oi, iv: book.iv, delta: book.delta, timestamp: tick.timestamp, quantity, maximumRisk: quantity * riskPerUnit });
    }
    state.option = rankOptions(candidates,snapshot.ltp)[0] ?? null;
    if (state.option) state.optionDataDelayed = false;
    return state.option;
  }
  async view(userId: string) { const state = await this.load(userId); await this.recalculate(userId, state); return this.response(userId, state); }
  private async recalculate(userId: string, state: State) { const now = new Date(); if (state.busy)
    return; state.busy = true; try {
    const evaluationKey = Math.floor(now.getTime() / 60000);
    const evaluationChanged = state.lastEvaluation !== evaluationKey || !state.evaluations.length;
    if (evaluationChanged) {
      state.lastEvaluation = evaluationKey;
      state.evaluations = evaluateAll(state.candles, now, state.settings);
    }
    const running = await this.prisma.paperOrder.findFirst({where:{userId,portfolio:'NIFTY',status:'OPEN'}});
    if (running) {
      const canonical = await this.prisma.aiSignal.findUnique({where:{id:running.signalId!}});
      const closed15 = aggregate(state.candles,15).filter(c=>Date.parse(c.time)+900000 <= now.getTime());
      const closed3 = aggregate(state.candles,3).filter(c=>Date.parse(c.time)+180000 <= now.getTime());
      const direction = indicators(closed15).direction;
      const vwap = indicators(aggregate(state.candles,5)).vwap;
      const confirmation = closed3.at(-1);
      if (canonical && confirmation && now.getTime()-Date.parse(confirmation.time) <= 360000) {
        const long = canonical.side === 'BUY';
        if (direction === (long ? 'BEARISH' : 'BULLISH')) await this.demo.invalidateSetup(userId,'15M REGIME INVALIDATION');
        else if (vwap !== null && (long ? confirmation.close < vwap && confirmation.close < confirmation.open : confirmation.close > vwap && confirmation.close > confirmation.open)) await this.demo.invalidateSetup(userId,'VWAP INVALIDATION');
      }
    }
    const liveHealth = niftyDataHealth(state.candles,this.market.latestUserSnapshot(userId,NIFTY_KEY),now.getTime(),state.settings.staleMs,state.open!==null&&state.close!==null&&now.getTime()>=state.open&&now.getTime()<state.close,this.market.websocketStatus(userId));
    if (liveHealth.newTradesEnabled && !state.error && sessionFilters(now,state.settings,state.open,state.close).length===0) {
      const recorded=this.recordedOpportunities.get(userId) ?? new Set<string>();
      this.recordedOpportunities.set(userId,recorded);
      for(const e of state.evaluations.filter(e=>e.valid&&e.score>=state.settings.minimumScore&&!recorded.has(e.setupId))) {
        await this.prisma.niftyOpportunity.upsert({where:{userId_setupId:{userId,setupId:e.setupId}},create:{userId,setupId:e.setupId,strategy:e.strategy,side:e.side,score:e.score,detectedAt:now},update:{}});
        recorded.add(e.setupId);
      }
    }
    const candidate = [...state.evaluations].sort((a, b) => Number(b.valid) - Number(a.valid) || b.score - a.score)[0];
    try {
      await this.selectOption(userId, state, candidate);
    }
    catch (error) {
      state.option = null;
      this.log.warn(`Nifty option selection unavailable: ${String(error)}`);
    }
    const response = await this.response(userId, state);
    if (evaluationChanged)
      for (const e of state.evaluations)
        this.log.debug(JSON.stringify({ event: 'nifty.strategy.evaluated', strategy: e.strategy, checks: e.checks, accepted: e.valid && response.noTradeReasons.length === 0 }));
    if (candidate.valid && response.noTradeReasons.length === 0 && state.option && candidate.trade)
      await this.createSignal(userId, state, candidate, state.option, response.historicalObservation?.sufficient && response.historicalObservation.expectancyR! > 0 ? 5 : 0, response.historicalObservation);
    this.market.emitToUser(userId, 'nifty.regime', { regime: candidate.regime });
  }
  finally {
    state.busy = false;
  } }
  private async response(userId: string, state: State) {
    const quote = this.market.latestUserSnapshot(userId, NIFTY_KEY);
    const now = Date.now();
    const best = [...state.evaluations].sort((a, b) => Number(b.valid) - Number(a.valid) || b.score - a.score)[0] ?? null;
    let cachedRisk = this.riskCache.get(userId);
    if (!cachedRisk || now - cachedRisk.at > 5000) {
      cachedRisk = { at: now, value: await this.risk(userId, state.settings) };
      this.riskCache.set(userId, cachedRisk);
    }
    const risk = cachedRisk.value;
    let cachedPerformance = this.performanceCache.get(userId);
    if (!cachedPerformance || now - cachedPerformance.at > 60000) {
      cachedPerformance = { at: now, value: await this.performance(userId) };
      this.performanceCache.set(userId, cachedPerformance);
    }
    const performance = cachedPerformance.value;
    let historical = this.historicalCache.get(userId);
    if (!historical || now - historical.at > 60000) {
      const latest = await this.prisma.niftyBacktestResult.findFirst({ where: { userId }, orderBy: { createdAt: 'desc' } });
      historical = { at: now, rows: latest && latest.settings === JSON.stringify(state.settings) ? (JSON.parse(latest.results).observations ?? []) : [] };
      this.historicalCache.set(userId, historical);
    }
    const observation = historical.rows.find(r => r.strategy === best?.strategy && r.side === best?.side && r.regime === best?.regime) ?? null;
    const exchange = this.market.latestExchangeStatus(userId);
    const exchangeStatus = exchange && exchangeDate(new Date(exchange.receivedAt)) === exchangeDate(new Date()) ? exchange.status : null;
    const inSession = state.open !== null && state.close !== null && now >= state.open && now < state.close;
    const noTradeReasons = [...sessionFilters(new Date(), state.settings, state.open, state.close), ...risk.reasons];
    if (best?.valid && await this.prisma.niftySignalContext.findUnique({where:{setupId:`${userId}:${best.setupId}`}})) noTradeReasons.push('This setup has already been signalled; wait for a new setup');
    if (inSession && exchangeStatus && exchangeStatus !== 'NORMAL_OPEN')
      noTradeReasons.push(`Exchange session paused: ${exchangeStatus}`);
    if (state.error)
      noTradeReasons.push(state.error);
    if (state.sessionError)
      noTradeReasons.push(state.sessionError);
    const dataHealth = niftyDataHealth(state.candles, quote, now, state.settings.staleMs, inSession, this.market.websocketStatus(userId));
    const recent = state.candles.at(-1);
    if (!recent || now - Date.parse(recent.time) > 120000)
      noTradeReasons.push('Latest candle is missing or delayed');
    if (!keyLevels(state.candles, new Date(), state.settings).openingRangeComplete)
      noTradeReasons.push('Opening range is incomplete');
    if (inSession && dataHealth.stale) noTradeReasons.push('DATA DELAYED: NEW TRADES DISABLED');
    if (!quote || !quote.timestampTrusted || now - quote.timestamp > state.settings.staleMs || quote.timestamp > now + 1000)
      noTradeReasons.push('Market data stale or unavailable');
    if (!state.option || now - state.option.timestamp > state.settings.staleMs)
      noTradeReasons.push('No fresh eligible option contract passed liquidity/lot/risk filters');
    if (state.option && state.option.maximumRisk > risk.remaining)
      noTradeReasons.push('Contract risk exceeds remaining daily risk');
    if (!best?.valid)
      noTradeReasons.push(...(best?.missing.length ? best.missing : [best && !state.settings.enabledStrategies.includes(best.strategy) ? 'Strategy disabled in Nifty settings' : 'Required closed-candle history is insufficient']));
    if ((best?.score ?? 0) < state.settings.minimumScore)
      noTradeReasons.push(`Setup score ${best?.score ?? 0}/100; configured minimum ${state.settings.minimumScore}`);
    if (state.settings.requireHistoricalPerformance && (!observation?.sufficient || observation.expectancyR! <= 0))
      noTradeReasons.push('Historical performance insufficient or expectancy is not positive');
    const today = await this.prisma.niftyOpportunity.count({where:{userId,detectedAt:{gte:new Date(`${exchangeDate(new Date(now))}T00:00:00+05:30`)}}});
    const waitFor = [best?.levels.openingRangeHigh ? `Break and retest above ${best.levels.openingRangeHigh.toFixed(2)}` : null,best?.levels.openingRangeLow ? `Break and retest below ${best.levels.openingRangeLow.toFixed(2)}` : null,...(best?.missing ?? [])].filter((x):x is string=>x!==null);
    return { dataHealth, today:{opportunities:today,target:3,remaining:Math.max(0,3-today),trades:risk.trades,maxTrades:state.settings.maxTrades}, waitFor, serverTime: new Date().toISOString(), market: quote, session: { status: state.open === null ? 'CLOSED' : now < state.open ? 'PRE-MARKET' : inSession ? (exchangeStatus && exchangeStatus !== 'NORMAL_OPEN' ? 'PAUSED' : 'OPEN') : 'CLOSED', open: state.open, close: state.close, timezone: 'Asia/Kolkata', cutoff: state.settings.cutoff, squareOff: state.settings.squareOff }, stale: dataHealth.stale, settings: state.settings, historicalObservation: observation, regime: best?.regime ?? 'NO TRADE', timeframes: best?.timeframes ?? null, levels: keyLevels(state.candles, new Date(), state.settings), strategies: state.evaluations, setup: best, option: state.option, optionDataDelayed: state.optionDataDelayed, risk, noTradeReasons: [...new Set(noTradeReasons)], performance };
  }
  private async createSignal(userId: string, state: State, e: Evaluation, option: OptionContract, historicalScore: number, historicalObservation: { sufficient: boolean; sampleSize: number; winRate: number | null; expectancyR: number | null } | null) { const t = e.trade!; const now = new Date(); const setupId = `${userId}:${e.setupId}`; const existing = await this.prisma.niftySignalContext.findUnique({ where: { setupId } }); if (existing)
    return; const risk = await this.risk(userId, state.settings); if (risk.reasons.length || option.maximumRisk > risk.remaining)
    return; const reasons = [...e.reasons, ...e.checks.filter(k=>k.available===false).map(k=>`${k.name}: ${k.reason}`), `Risk validation: option risk ₹${option.maximumRisk.toFixed(2)}; daily risk remaining ₹${risk.remaining.toFixed(2)}; trade risk budget ₹${risk.maximumRisk.toFixed(2)}`, `Option ${option.symbol}: spread ${option.spreadPercent.toFixed(2)}%, volume ${option.volume}, lot ${option.lotSize}`, 'All configured no-trade and risk filters passed']; const signal = await this.prisma.aiSignal.create({ data: { userId, signalKey: setupId, instrumentKey: NIFTY_KEY, stockName: 'NIFTY 50', symbol: 'NIFTY', sector: 'NSE Index', strategy: e.strategy, timeframe: '15m/5m/3m', side: e.side, signalTime: now, signalGeneratedAt: now, currentPrice: this.market.latestUserSnapshot(userId, NIFTY_KEY)!.ltp, entryPrice: t.entry, stopLoss: t.stopLoss, target1: t.target1, target2: t.target2, target3: t.target3, confidence: 0, aiScore: e.score, riskReward: t.riskReward, volume: aggregate(state.candles, 5).filter(c => Date.parse(c.time) + 300000 <= now.getTime()).at(-1)?.volume ?? 0, setupFingerprint: setupId, status: 'WAITING', niftyContext: { create: { setupId, inputs: JSON.stringify({ ...e, historicalObservation, settings: state.settings, candles: { '15m': aggregate(state.candles, 15).slice(-60), '5m': aggregate(state.candles, 5).slice(-60), '3m': aggregate(state.candles, 3).slice(-60) }, market: this.market.latestUserSnapshot(userId, NIFTY_KEY) }), optionContract: JSON.stringify(option), reasons: JSON.stringify(reasons), invalidations: JSON.stringify(e.invalidations), setupDetectedAt: now } } } }); this.log.log(JSON.stringify({ event: 'nifty.signal.confirmed', signalId: signal.id, strategy: e.strategy, reasons })); this.invalidate(userId); this.market.emitToUser(userId, 'nifty.signal', signal); }
  private async tick(userId: string, key: string, price: number, timestamp: number, volume?: number) {
    const state = this.states.get(userId);
    if (!state)
      return;
    if (key !== NIFTY_KEY) {
      state.lastOptionTick = timestamp;
      if (state.option) {
        const book = this.market.latestOptionBook(userId, key);
        const quote = this.market.latestUserSnapshot(userId, key);
        const lotSize = state.option.lotSize;
        if (!book || !quote || !optionLiquidityPass({ltp: book.ltp, bid: book.bid, ask: book.ask, volume: book.volume, lotSize, timestamp, timestampTrusted: quote.timestampTrusted}, state.settings, Date.now())) {
          state.option = null;
        } else {
          state.option = {...state.option, ltp: price, bid: book.bid, ask: book.ask, spreadPercent: (book.ask-book.bid)/book.ltp*100, volume: book.volume, oi: book.oi, iv: book.iv, delta: book.delta, timestamp};
        }
      }
      return;
    }
    if (!Number.isFinite(price) || price <= 0 || !this.market.latestUserSnapshot(userId, NIFTY_KEY)?.timestampTrusted || timestamp > Date.now()+1000 || Date.now()-timestamp > state.settings.staleMs || timestamp <= state.lastTick)
      return;
    state.lastTick = timestamp;
    const at = new Date(timestamp);
    const sessionActive = state.open !== null && state.close !== null && timestamp >= state.open && timestamp < state.close;
    if (sessionActive) {
      const t = bucket(timestamp, 1);
      const last = state.candles.at(-1);
      const day = exchangeDate(at);
      if (state.lastVolumeDate !== day) {
        state.lastVolume = null;
        state.lastVolumeDate = day;
      }
      let added = 0;
      if (volume !== undefined && volume > 0) {
        if (state.lastVolume !== null)
          added = Math.max(0, volume - state.lastVolume);
        state.lastVolume = volume;
      }
      if (last && Date.parse(last.time) === t) {
        last.high = Math.max(last.high, price);
        last.low = Math.min(last.low, price);
        last.close = price;
        last.volume += added;
      }
      else if (!last || Date.parse(last.time) < t)
        state.candles.push({ time: new Date(t).toISOString(), open: price, high: price, low: price, close: price, volume: added });
      state.candles = state.candles.slice(-5000);
    }
    this.market.emitToUser(userId, 'nifty.price', { ltp: price, timestamp, timestampTrusted: this.market.latestUserSnapshot(userId, NIFTY_KEY)?.timestampTrusted ?? false });
    this.market.emitToUser(userId, 'nifty.candle', { candle: state.candles.at(-1) });
    if (this.market.latestUserSnapshot(userId, NIFTY_KEY)?.timestampTrusted && Date.now() - timestamp <= state.settings.staleMs && timestamp <= Date.now() + 1000)
      await this.progress(userId, state, price, at);
    if (sessionActive)
      await this.recalculate(userId, state);
    this.market.emitToUser(userId, 'nifty.signal.update', { timestamp });
  }
  private async progress(userId: string, state: State, price: number, at: Date, timerOnly = false) {
    let cache = this.activeCache.get(userId);
    if (!cache || Date.now() - cache.at > 5000) {
      cache = { at: Date.now(), rows: await this.activeSignals(userId) };
      this.activeCache.set(userId, cache);
    }
    const rows = cache.rows;
    for (const row of rows) {
      if (await this.prisma.paperOrder.findFirst({where:{id:row.id,portfolio:'NIFTY',status:'OPEN'}})) continue;
      const s = JSON.parse(row.niftyContext!.inputs).settings as Settings;
      let stop = row.stopLoss;
      if (s.moveToBreakeven && row.target1At)
        stop = row.entryExecutedPrice ?? row.entryPrice;
      if (s.trailAfterT2 && row.target2At)
        stop = row.target1;
      const square = exchangeDate(at) > exchangeDate(row.signalTime) || exchangeTime(at) >= s.squareOff;
      let events = lifecycle(price, row.side, row.entryExecutedPrice ?? row.entryPrice, stop, [row.target1, row.target2, row.target3], row.status, square);
      if (row.status === 'WAITING' && at.getTime() - row.signalGeneratedAt.getTime() > 15 * 60000)
        events = ['EXPIRED'];
      if (timerOnly && !square && events[0] !== 'EXPIRED')
        continue;
      if (row.status === 'WAITING' && events.includes('ENTRY_TRIGGERED')) {
        const filters = sessionFilters(at, state.settings, state.open, state.close);
        const option = state.option;
        const generatedOption = JSON.parse(row.niftyContext!.optionContract) as OptionContract;
        const context = JSON.parse(row.niftyContext!.inputs) as Evaluation;
        const freshOption = option?.instrumentKey === generatedOption.instrumentKey && Date.now() - option.timestamp <= state.settings.staleMs && Date.now() - state.optionAt <= 10000;
        const current = evaluate(context.strategy, state.candles, at, state.settings);
        if (!this.market.latestUserSnapshot(userId, NIFTY_KEY)?.timestampTrusted)
          filters.push('Market timestamp unavailable');
        if (this.market.latestExchangeStatus(userId)?.status && this.market.latestExchangeStatus(userId)!.status !== 'NORMAL_OPEN')
          filters.push('Exchange paused');
        if(option&&generatedOption.quantity*option.ask*state.settings.optionStopPercent/100>(await this.risk(userId,state.settings)).maximumRisk)filters.push('Option premium exceeds signal risk budget');const health = niftyDataHealth(state.candles, this.market.latestUserSnapshot(userId,NIFTY_KEY), Date.now(), state.settings.staleMs, state.open !== null && state.close !== null && at.getTime() >= state.open && at.getTime() < state.close, this.market.websocketStatus(userId));
        if (!health.newTradesEnabled || current.score < state.settings.minimumScore || filters.length || Date.now() - at.getTime() > state.settings.staleMs || !freshOption || state.error || !current.valid || current.setupId !== context.setupId || current.regime !== context.regime || Math.abs(price - row.entryPrice) > Math.abs(row.entryPrice - row.stopLoss) * .25)
          events = !freshOption ? [] : ['CANCELLED'];
        if (events.includes('ENTRY_TRIGGERED')) {
          await this.demo.enter(userId, row.id, generatedOption, state.settings, true);
          if (!await this.prisma.paperOrder.findUnique({where:{id:row.id}})) events = [];
        }
      }
      for (const type of events) {
        const eventTime = new Date();
        const sign = row.side === 'BUY' ? 1 : -1;
        const pnl = row.entryExecutedPrice !== null ? (price - row.entryExecutedPrice) * sign / row.entryExecutedPrice * 100 : 0;
        const completed = terminal.includes(type);
        await this.prisma.$transaction(async (tx) => { const canonical = await tx.aiSignal.findUnique({where:{id:row.id}}); if (!canonical || canonical.completedAt) return; const exists = await tx.aiTradeEvent.findUnique({ where: { tradeId_type: { tradeId: row.id, type } } }); if (exists)
          return; await tx.aiTradeEvent.create({ data: { tradeId: row.id, type, triggerPrice: price, executedPrice: price, eventTime, profitPercent: pnl, holdingMinutes: row.entryTriggeredAt ? Math.floor((eventTime.getTime() - row.entryTriggeredAt.getTime()) / 60000) : 0 } }); await tx.aiSignal.update({ where: { id: row.id }, data: { status: type, currentPrice: price, ...(type === 'ENTRY_TRIGGERED' ? { entryTriggeredAt: eventTime, entryExecutedPrice: price } : {}), ...(type === 'RUNNING' ? { runningAt: eventTime } : {}), ...(type === 'TARGET_1_HIT' ? { target1At: eventTime, target1HitAt: eventTime, target1ExecutedPrice: price } : {}), ...(type === 'TARGET_2_HIT' ? { target2At: eventTime, target2HitAt: eventTime, target2ExecutedPrice: price } : {}), ...(type === 'TARGET_3_HIT' ? { target3At: eventTime, target3HitAt: eventTime, target3ExecutedPrice: price } : {}), ...(type === 'STOP_LOSS' ? { stopLossAt: eventTime, stopLossHitAt: eventTime } : {}), ...(completed ? { completedAt: eventTime, exitPrice: price, profitPercent: Math.max(0, pnl), lossPercent: Math.max(0, -pnl) } : {}) } }); });
        this.invalidate(userId);
        this.market.emitToUser(userId, 'nifty.trade-progress', { signalId: row.id, type, price, eventTime });
      }
    }
  }
  @Interval(5000)
  async heartbeat() { for (const [userId, state] of this.states) {
    const previous = this.queues.get(userId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(async () => { try {
      const quote = this.market.latestUserSnapshot(userId, NIFTY_KEY);
      if (quote)
        await this.progress(userId, state, quote.ltp, new Date(), true);
      if (Date.now() - state.loadedAt > 60000 && !state.busy) {
        await this.refreshData(userId, state);
      }
      await this.recalculate(userId, state);
      this.market.emitToUser(userId, 'nifty.signal.update', { serverTime: new Date().toISOString() });
    }
    catch (error) {
      state.error = error instanceof Error ? error.message : 'Nifty data update unavailable';
      this.log.warn(state.error);
    } });
    this.queues.set(userId, queued);
    await queued;
    if (this.queues.get(userId) === queued)
      this.queues.delete(userId);
  } }
  async candles(userId: string, timeframe: number) { if (![1, 3, 5, 15].includes(timeframe))
    throw new BadRequestException('Use 1, 3, 5 or 15 minutes'); const state = await this.load(userId); const candles = aggregate(state.candles, timeframe); return { candles, indicators: indicators(candles), overlays: overlay(candles) }; }
  async performance(userId: string, query: Parameters<NiftyService['history']>[1] = {}) { const s = await this.settings(userId); const rows = await this.history(userId, query); return { label: 'Observed underlying signal performance; excludes option P&L and transaction costs', strategies: strategies.map(strategy => statistics(rows.filter(r => r.strategy === strategy && r.completedAt && r.entryExecutedPrice !== null).reverse().map(r => ({ r: (r.exitPrice! - r.entryExecutedPrice!) * (r.side === 'BUY' ? 1 : -1) / Math.abs(r.entryPrice - r.stopLoss), holding: r.entryTriggeredAt ? (r.completedAt!.getTime() - r.entryTriggeredAt.getTime()) / 60000 : 0, t1: !!r.target1At, t2: !!r.target2At, t3: !!r.target3At, sl: !!r.stopLossAt })), s.minimumSamples, strategy)) }; }
  async backtest(userId: string, from: string, to: string, filters: {strategy?:string;window?:string;regime?:string} = {}) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to || Date.parse(to) - Date.parse(from) > 31 * 86400000)
      throw new BadRequestException('Use a valid date range of up to 31 days');
    const s = await this.settings(userId);
    const warmupFrom=exchangeDate(new Date(Date.parse(`${from}T00:00:00+05:30`)-10*86400000));
    const warmupTo=exchangeDate(new Date(Date.parse(`${from}T00:00:00+05:30`)-86400000));
    const requests=await Promise.allSettled([this.upstox.history(userId,NIFTY_KEY,'minutes',1,to,from),this.upstox.history(userId,NIFTY_KEY,'minutes',1,warmupTo,warmupFrom)]);
    if(requests[0].status==='rejected') throw requests[0].reason;
    const source=[...(requests[1].status==='fulfilled'?this.normalize(requests[1].value):[]),...this.normalize(requests[0].value)];
    const candles=[...new Map(source.map(c=>[c.time,c])).values()].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time));
    const warmupWarning=requests[1].status==='rejected'?'Warmup history unavailable; early setups may lack required candle history':null;
    const replayed = await replay(candles, s, from);
    const matches = (r:{strategy?:string;window?:string;regime?:string}) => (!filters.strategy || r.strategy===filters.strategy) && (!filters.window || r.window===filters.window) && (!filters.regime || r.regime===filters.regime);
    const outcomes = new Map([...replayed.outcomes].map(([strategy,rows])=>[strategy,rows.filter(r=>matches({...r,strategy}))]));
    const frequency = strategies.map(strategy=> {
      const rows=replayed.frequency.filter(r=>r.strategy===strategy&&matches(r));
      return {strategy,sessionDays:replayed.days.length,validSetups:rows.length,trades:rows.filter(r=>r.entered).length,averageSetupsPerDay:replayed.days.length?rows.length/replayed.days.length:0,averageTradesPerDay:replayed.days.length?rows.filter(r=>r.entered).length/replayed.days.length:0};
    });
    const result = { frequency, filters, warmupWarning, label: 'Underlying candle simulation; not option returns. No historical liquidity/option chain validation. Conservative stop-first handling when a bar hits both stop and target. No fees/slippage model.', from, to, availableCandles: candles.filter(c=>exchangeDate(new Date(c.time))>=from).length, observations: strategies.flatMap(strategy => ['BUY', 'SELL'].flatMap(side => ['RANGE', 'BULLISH', 'STRONG BULLISH', 'BEARISH', 'STRONG BEARISH'].map(regime => ({ ...statistics(outcomes.get(strategy)!.filter(r => r.side === side && r.regime === regime), s.minimumSamples, strategy), side, regime })))), strategies: strategies.map(k => statistics(outcomes.get(k)!, s.minimumSamples, k)) };
    await this.prisma.niftyBacktestResult.create({ data: { userId, fromDate: from, toDate: to, settings: JSON.stringify(s), results: JSON.stringify(result) } });
    this.invalidate(userId);
    return result;
  }
}
type ChainOption = {
  instrument_key: string;
  market_data: {
    ltp: number;
    bid_price: number;
    ask_price: number;
    volume: number;
    oi?: number;
  };
  option_greeks?: {
    delta?: number;
  };
};
function statistics(rows: Outcome[], minimum: number, strategy: string) { const n = rows.length, sufficient = n >= minimum; const wins = rows.filter(r => r.r > 0), losses = rows.filter(r => r.r < 0); const sum = (r: Outcome[]) => r.reduce((s, x) => s + x.r, 0); let equity = 0, peak = 0, drawdown = 0; for (const r of rows) {
  equity += r.r;
  peak = Math.max(peak, equity);
  drawdown = Math.max(drawdown, peak - equity);
} return { strategy, sampleSize: n, sufficient, minimumSamples: minimum, winRate: sufficient ? wins.length / n * 100 : null, winningTrades: sufficient ? wins.length : null, losingTrades: sufficient ? losses.length : null, breakeven: sufficient ? n - wins.length - losses.length : null, averageWinR: sufficient && wins.length ? sum(wins) / wins.length : null, averageLossR: sufficient && losses.length ? sum(losses) / losses.length : null, profitFactor: sufficient && losses.length ? sum(wins) / -sum(losses) : null, expectancyR: sufficient ? sum(rows) / n : null, averageR: sufficient ? sum(rows) / n : null, maximumDrawdownR: sufficient ? drawdown : null, largestWinR: sufficient ? Math.max(0, ...rows.map(r => r.r)) : null, largestLossR: sufficient ? Math.min(0, ...rows.map(r => r.r)) : null, target1HitPercent: sufficient ? rows.filter(r => r.t1).length / n * 100 : null, target2HitPercent: sufficient ? rows.filter(r => r.t2).length / n * 100 : null, target3HitPercent: sufficient ? rows.filter(r => r.t3).length / n * 100 : null, stopLossPercent: sufficient ? rows.filter(r => r.sl).length / n * 100 : null, averageHoldingMinutes: sufficient ? rows.reduce((t, r) => t + r.holding, 0) / n : null }; }
function overlay(candles: Candle[]) { const close = candles.map(c => c.close); const ema = (period: number) => EMAValues(close, period).map((value, i) => ({ time: candles[i + period - 1].time, value })); let day = '', v = 0, pv = 0; const vwap = candles.flatMap(c => { const d = exchangeDate(new Date(c.time)); if (d !== day) {
  day = d;
  v = 0;
  pv = 0;
} v += c.volume; pv += (c.high + c.low + c.close) / 3 * c.volume; return v > 0 ? [{ time: c.time, value: pv / v }] : []; }); return { ema20: ema(20), ema50: ema(50), vwap }; }
const EMAValues = (values: number[], period: number) => EMA.calculate({ values, period });
// Historical replay cannot block the live market tick/event loop.
function replay(candles: Candle[], settings: Settings, from?: string): Promise<ReturnType<typeof simulate>> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(require.resolve('./nifty-backtest'), { workerData: { candles, settings, from }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new BadRequestException('Backtest timed out. Use a shorter date range.')); }, 300000);
    worker.once('message', (result: Omit<ReturnType<typeof simulate>,'outcomes'> & {outcomes:Array<[string,Outcome[]]>}) => { clearTimeout(timeout); resolve({...result,outcomes:new Map(result.outcomes)}); });
    worker.once('error', error => { clearTimeout(timeout); reject(error); });
    worker.once('exit', code => { clearTimeout(timeout); if (code !== 0)
      reject(new Error('Historical replay worker failed')); });
  });
}
