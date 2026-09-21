import { marketClock } from './market-clock';
import { protectOpeningSignal } from './opening-protection';
import { BadRequestException, Body, Controller, Get, Headers, HttpException, InternalServerErrorException, Logger, Param, Patch, Post, Query, ServiceUnavailableException } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma.service';
import { ChartDto, HistoryDto, OhlcDto, SearchDto } from './dto';
import { Candle, IndicatorService } from './indicator.service';
import { MarketGateway } from './market.gateway';
import { UpstoxService } from './upstox.service';
import { ScannerService } from './scanner.service';
import { SignalHistoryService } from './signal-history.service';
import { PaperTradingService } from './paper-trading.service';
import { RealTradingService } from './real-trading.service';
import { MarketScannerWorkerService } from './market-scanner-worker.service';

type WatchlistItem = { instrumentKey: string; [key: string]: unknown };
const DASHBOARD_INDICES = [
  { name: 'NIFTY 50', instrumentKey: 'NSE_INDEX|Nifty 50' },
  { name: 'BANK NIFTY', instrumentKey: 'NSE_INDEX|Nifty Bank' },
  { name: 'FINNIFTY', instrumentKey: 'NSE_INDEX|Nifty Fin Service' },
  { name: 'MIDCAP 100', instrumentKey: 'NSE_INDEX|NIFTY MIDCAP 100' },
  { name: 'SENSEX', instrumentKey: 'BSE_INDEX|SENSEX' },
];

@Controller()
export class StocksController {
  private readonly logger = new Logger(StocksController.name);
  constructor(
    private readonly auth: AuthService,
    private readonly upstox: UpstoxService,
    private readonly indicators: IndicatorService,
    private readonly market: MarketGateway,
    private readonly prisma: PrismaService,
    private readonly scanner: ScannerService,
    private readonly signalHistory: SignalHistoryService,
    private readonly paperTrading: PaperTradingService,
    private readonly realTrading: RealTradingService,
    private readonly scannerWorker: MarketScannerWorkerService,
  ) {}

  private user(header: string | undefined) { return this.auth.userFromSession(header?.replace(/^Bearer\s+/i, '')); }
  private tradingDate(at = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
  }
  private marketIsOpen(at = new Date()) {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
    const value = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
    const weekday = value('weekday');
    const minutes = Number(value('hour')) * 60 + Number(value('minute'));
    return !['Sat', 'Sun'].includes(weekday) && minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
  }
  private dates(dto: HistoryDto) {
    const to = dto.toDate ?? this.tradingDate();
    const from = dto.fromDate ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 10 * 86_400_000));
    return { to, from };
  }
  private normalizeCandles(payload: any): Candle[] {
    const rows = payload?.data?.candles ?? payload?.candles ?? [];
    if (!Array.isArray(rows)) return [];
    return rows.map((row: unknown[]) => ({
      time: String(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
    })).filter((candle: Candle) => Number.isFinite(new Date(candle.time).getTime()) && [candle.open, candle.high, candle.low, candle.close, candle.volume].every(Number.isFinite))
      .sort((left: Candle, right: Candle) => new Date(left.time).getTime() - new Date(right.time).getTime())
      .slice(-500);
  }
  private async candles(userId: string, instrumentKey: string, dto: HistoryDto) {
    const { to, from } = this.dates(dto);
    const currentTradingDate = this.tradingDate();
    this.logger.log(`Historical candle request | ${JSON.stringify({ fromDate: this.marketIsOpen() ? currentTradingDate : from, toDate: to, symbol: instrumentKey, interval: dto.interval })}`);
    const payload = this.marketIsOpen()
      ? await this.upstox.intraday(userId, instrumentKey, dto.unit, dto.interval)
      : await this.upstox.history(userId, instrumentKey, dto.unit, dto.interval, to, from);
    const candles = this.normalizeCandles(payload);
    const snapshot = this.market.latestSnapshot(instrumentKey);
    const first = candles.at(0) ?? null;
    const last = candles.at(-1) ?? null;
    const differencePercent = snapshot?.ltp && last?.close ? Math.abs(snapshot.ltp - last.close) / snapshot.ltp * 100 : null;
    this.logger.log(`Historical candle response | ${JSON.stringify({ firstCandle: first, lastCandle: last, currentLTP: snapshot?.ltp ?? null, differencePercent, historyDate: last?.time?.slice(0, 10) ?? null, currentTradingDate })}`);
    return candles;
  }

  @Get('stocks/search') search(@Headers('authorization') header: string, @Query() query: SearchDto) { return this.upstox.search(this.user(header), query.q); }
  @Get('stocks/:instrumentKey/chart') async chart(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: ChartDto) {
    const userId = this.user(header);
    const intraday: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30 };
    const interval = intraday[dto.timeframe];
    if (!interval) throw new BadRequestException('Only 1m, 3m, 5m, 15m and 30m intraday timeframes are supported.');
    console.log('[UPSTOX CHART REQUEST]', JSON.stringify({ instrument_key: key, timeframe: dto.timeframe, unit: 'minutes', interval }));
    const payload = await this.upstox.intraday(userId, key, 'minutes', interval);
    const candles = this.normalizeCandles(payload); await this.market.subscribe(userId, key); return candles.length ? { candles, timeframe: dto.timeframe } : { status: 'no_candle_data', candles: [], timeframe: dto.timeframe };
  }
  @Get('market/indices') async indices(@Headers('authorization') header: string) {
    const userId = this.user(header);
    const instrumentKeys = DASHBOARD_INDICES.map((index) => index.instrumentKey);
    const quote = await this.upstox.quote(userId, instrumentKeys.join(','));
    await Promise.all(instrumentKeys.map((instrumentKey) => this.market.subscribe(userId, instrumentKey)));
    return { indices: DASHBOARD_INDICES, quote };
  }
  @Get('stocks/:instrumentKey/history') async history(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: HistoryDto) {
    const userId = this.user(header); const candles = await this.candles(userId, key, dto); await this.market.subscribe(userId, key); return candles.length ? { candles } : { status: 'no_candle_data', candles: [] };
  }
  @Get('stocks/:instrumentKey/intraday') async intraday(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: HistoryDto) {
    const userId = this.user(header); const tradingDate = this.tradingDate();
    this.logger.log(`Historical candle request | ${JSON.stringify({ fromDate: tradingDate, toDate: tradingDate, symbol: key, interval: dto.interval })}`);
    const payload = await this.upstox.intraday(userId, key, dto.unit, dto.interval); const candles = this.normalizeCandles(payload); const snapshot = this.market.latestSnapshot(key);
    this.logger.log(`Historical candle response | ${JSON.stringify({ firstCandle: candles.at(0) ?? null, lastCandle: candles.at(-1) ?? null, currentLTP: snapshot?.ltp ?? null, historyDate: candles.at(-1)?.time?.slice(0, 10) ?? null, currentTradingDate: tradingDate })}`);
    await this.market.subscribe(userId, key); return candles.length ? { candles } : { status: 'no_candle_data', candles: [] };
  }
  @Get('stocks/:instrumentKey/quote') quote(@Headers('authorization') header: string, @Param('instrumentKey') key: string) { return this.upstox.quote(this.user(header), key); }
  @Get('stocks/:instrumentKey/ltp') ltp(@Headers('authorization') header: string, @Param('instrumentKey') key: string) { return this.upstox.ltp(this.user(header), key); }
  @Get('stocks/:instrumentKey/ohlc') ohlc(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: OhlcDto) { return this.upstox.ohlc(this.user(header), key, dto.interval); }
  @Get('stocks/:instrumentKey/analysis') async analysis(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: HistoryDto) {
    const userId = this.user(header);
    const timeframe = `${dto.interval}m`;
    const candles = [3, 5].includes(dto.interval)
      ? await this.completedTradeAnalysisCandles(userId, key, timeframe, dto.interval, dto.interval === 5 ? 250 : 200)
      : await this.candles(userId, key, dto);
    if (!candles.length) {
      this.logger.warn(`Historical candle response contained no candles | ${JSON.stringify({ instrumentKey: key, interval: dto.interval })}`);
      return { status: 'no_candle_data', candles: [] };
    }
    const indicators = this.indicators.calculate(candles);
    if (dto.interval === 5) {
      this.logger.log(`5m candles loaded | ${JSON.stringify({ instrumentKey: key, count: candles.length })}`);
      this.logger.log(`5m indicators calculated | ${JSON.stringify({ rsi: indicators.rsi, ema: { ema20: indicators.ema20, ema50: indicators.ema50, ema200: indicators.ema200 }, macd: indicators.macd, vwap: indicators.vwap, atr: indicators.atr, adx: indicators.adx, support: indicators.support, resistance: indicators.resistance })}`);
      this.logInvalidIndicators('5m', indicators);
      this.logger.log(`5m response sent | ${JSON.stringify({ instrumentKey: key, candleCount: candles.length })}`);
    }
    await this.market.subscribe(userId, key);
    return { candles, indicators, analysis: protectOpeningSignal(this.signal(candles, indicators)) };
  }
  @Get('api/trade-analysis/:symbol/:timeframe') async tradeAnalysis(
    @Headers('authorization') header: string,
    @Param('symbol') symbol: string,
    @Param('timeframe') timeframe: string,
  ) {
    if (!['3m', '5m'].includes(timeframe)) throw new BadRequestException('Timeframe must be 3m or 5m');
    const instrument = await this.prisma.nseInstrument.findFirst({ where: { symbol: symbol.toUpperCase(), active: true } });
    if (!instrument) throw new BadRequestException(`Unknown NSE symbol: ${symbol}`);
    const userId = this.user(header);
    const candles3m = await this.completedTradeAnalysisCandles(userId, instrument.instrumentKey, '3m', 3, 200);
    const candles5m = await this.completedTradeAnalysisCandles(userId, instrument.instrumentKey, '5m', 5, 250);
    this.logger.log(`5m candles loaded | ${JSON.stringify({ symbol: instrument.symbol, count: candles5m.length })}`);
    const analysis3m = this.indicators.tradeAnalysis(candles3m);
    const analysis5m = this.indicators.tradeAnalysis(candles5m);
    this.logger.log(`5m indicators calculated | ${JSON.stringify(this.indicatorDebugValues(analysis5m))}`);
    this.logInvalidIndicators('5m', analysis5m);
    this.logger.log(`5m response sent | ${JSON.stringify({ symbol: instrument.symbol, status: analysis5m.status })}`);
    return { analysis3m: { symbol: instrument.symbol, timeframe: '3m', ...analysis3m }, analysis5m: { symbol: instrument.symbol, timeframe: '5m', ...analysis5m } };
  }
  @Get('scanner') async scannerResults(@Headers('authorization') header: string, @Query('filter') filter?: string, @Query('refresh') refresh?: string) {
    const normalized = (filter ?? 'all').toLowerCase();
    const location = normalized === 'buy' ? 'TopBuyService.getTopBuy' : normalized === 'sell' ? 'TopSellService.getTopSell' : 'ScannerService.filtered';
    return this.diagnosed(location, 'GET', () => this.scanner.filtered(this.user(header), filter, refresh === 'true'));
  }
  @Get('signal-history') async getSignalHistory(@Headers('authorization') header: string, @Query('status') status?: string) {
    const userId = this.user(header);
    const history = await this.signalHistory.history(userId, status);
    const instrumentKeys = [...new Set(history.signals.map(signal => signal.instrumentKey))];
    if (instrumentKeys.length) void this.market.subscribeMany(userId, instrumentKeys);
    return history;
  }
  @Get('signal-history/:id') signalHistoryOne(@Headers('authorization') header: string, @Param('id') id: string) { return this.signalHistory.one(this.user(header), id); }
  @Post('signal-history/:id/generate') async generateTrade(@Headers('authorization') header: string, @Param('id') id: string) {
    const userId = this.user(header);
    if (marketClock().beforeTradingStart) return this.noSetup('TRADING_NOT_STARTED', 'Signal generation and trade entries start at 9:20 AM IST.', '5m');
    const previous = await this.signalHistory.one(userId, id);
    if (!previous) return this.noSetup('TRADE_NOT_FOUND', 'Trade not found.', '5m');
    if (!['COMPLETED', 'STOPLOSS_HIT'].includes(previous.status)) { this.logger.warn(JSON.stringify({ event: 'new-trade.skipped', tradeId: id, symbol: previous.symbol, reason: 'Previous trade still active' })); return this.noSetup('PREVIOUS_TRADE_ACTIVE', 'The previous trade is still active. A new setup cannot be created yet.', previous.timeframe); }
    const active = await this.signalHistory.activeFor(userId, previous.instrumentKey, previous.timeframe);
    if (active) { this.logger.warn(JSON.stringify({ event: 'new-trade.skipped', tradeId: id, symbol: previous.symbol, reason: 'Active trade already exists' })); return this.noSetup('ACTIVE_TRADE_EXISTS', 'An active trade already exists for this stock and timeframe.', previous.timeframe); }
    const nextScanAt = this.nextCandleClose(previous.completedAt ?? previous.signalTime, previous.timeframe);
    if (Date.now() < nextScanAt.getTime()) { this.logger.log(JSON.stringify({ event: 'new-trade.skipped', tradeId: id, symbol: previous.symbol, reason: 'No new candle has closed', nextScanAt })); return this.noSetup('WAITING_FOR_CANDLE_CLOSE', 'The AI is waiting for a new candle to close before validating another setup.', previous.timeframe, nextScanAt); }
    const rows = await this.scanner.scan(userId, true, false);
    const candidate = rows.find((row) => row.instrumentKey === previous.instrumentKey && row.timeframe === previous.timeframe);
    const rejection = this.setupRejection(candidate, previous);
    if (rejection) { this.logger.log(JSON.stringify({ event: 'new-trade.skipped', tradeId: id, symbol: previous.symbol, reason: rejection.logReason })); return this.noSetup('NO_NEW_SETUP', 'The previous trade has completed. The AI is monitoring this stock and will generate a new trade only after a fresh technical setup appears.', previous.timeframe, this.nextCandleClose(new Date(), previous.timeframe), rejection.logReason); }
    await this.signalHistory.recordScannerSignals(userId, [candidate!]);
    const generated = await this.signalHistory.activeFor(userId, previous.instrumentKey, previous.timeframe);
    if (!generated) { this.logger.log(JSON.stringify({ event: 'new-trade.skipped', tradeId: id, symbol: previous.symbol, reason: 'Duplicate setup' })); return this.noSetup('NO_NEW_SETUP', 'The previous trade has completed. The AI is monitoring this stock and will generate a new trade only after a fresh technical setup appears.', previous.timeframe, this.nextCandleClose(new Date(), previous.timeframe), 'Duplicate setup'); }
    return { success: true, trade: generated };
  }
  @Get('scanner/top-buy') scannerBuy(@Headers('authorization') header: string) { return this.diagnosed('TopBuyService.getTopBuy', 'GET', () => this.top(this.user(header), 'BUY')); }
  @Get('scanner/top-sell') scannerSell(@Headers('authorization') header: string) { return this.diagnosed('TopSellService.getTopSell', 'GET', () => this.top(this.user(header), 'SELL')); }
  @Get('top-buy') topBuy(@Headers('authorization') header: string) { return this.diagnosed('TopBuyService.getTopBuy', 'GET', () => this.top(this.user(header), 'BUY')); }
  @Get('top-sell') topSell(@Headers('authorization') header: string) { return this.diagnosed('TopSellService.getTopSell', 'GET', () => this.top(this.user(header), 'SELL')); }
  @Get('analysis') async rankedAnalysis(@Headers('authorization') header: string) { const rows = await this.scanner.scan(this.user(header)); return rows.filter((row) => row.signal !== 'HOLD').sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 20); }
  @Get('scanner/status') scannerStatus(@Headers('authorization') header: string) {
    return this.scannerWorker.status(this.user(header));
  }

  @Get('dashboard') async dashboard(@Headers('authorization') header: string) {
    const userId = this.user(header);
    const report = await this.scanner.scanReport(userId);
    const lists = await this.signalHistory.publishStrategyList(userId, report.rows);
    await this.paperTrading.reconcileTriggeredDemoSignals(userId, new Date(), 'STRATEGY');
    const executedSignals = await this.signalHistory.executedStrategySignals(userId);
    return { ...lists, executedSignals, scannerCount: report.rows.length, coverage: report.coverage, scanCompletedAt: report.completedAt };
  }
  @Get('strategy-weekly') strategyWeekly(@Headers('authorization') header: string) { return this.signalHistory.strategyWeekly(this.user(header)); }
  @Get('strategy-target-one-analysis') targetOneAnalysis(@Headers('authorization') header: string) { return this.signalHistory.targetOneAnalysis(this.user(header)); }
  @Get('paper-trading') async paperTradingDashboard(@Headers('authorization') header: string) {
    const userId = this.user(header);
    const openOrders = await this.prisma.paperOrder.findMany({ where: { userId, status: 'OPEN' }, select: { instrumentKey: true } });
    const openKeys = [...new Set(openOrders.map((order) => order.instrumentKey))];
    if (openKeys.length) {
      this.logger.log(JSON.stringify({ event: 'paper.dashboard.live-refresh', userId, instrumentKeys: openKeys }));
      await this.market.refreshPrices(userId, openKeys);
    }
    return this.paperTrading.dashboard(userId);
  }
  @Get('signal-history-demo/report') signalHistoryDemoReport(@Headers('authorization') header: string) { return this.paperTrading.signalHistoryWeeklyReport(this.user(header)); }
  @Get('signal-history-demo') async signalHistoryDemoDashboard(@Headers('authorization') header: string) {
    const userId = this.user(header);
    const openOrders = await this.prisma.paperOrder.findMany({ where: { userId, portfolio: 'SIGNAL_HISTORY', status: 'OPEN' }, select: { instrumentKey: true } });
    const openKeys = [...new Set(openOrders.map((order) => order.instrumentKey))];
    if (openKeys.length) await this.market.refreshPrices(userId, openKeys);
    return this.paperTrading.dashboard(userId, 'SIGNAL_HISTORY');
  }
  @Get('real-trading') realTradingDashboard(@Headers('authorization') header: string) { return this.realTrading.dashboard(this.user(header)); }
  @Patch('real-trading/automation') realTradingAutomation(@Headers('authorization') header: string, @Body() body: { source: 'STRATEGY' | 'SIGNAL_HISTORY'; enabled: boolean }) {
    return this.realTrading.setEnabled(this.user(header), body.source, body.enabled);
  }
  @Post('real-trading/positions/exit') realTradingExit(@Headers('authorization') header: string, @Body() body: { instrumentKey?: string; product?: string }) {
    if (!body.instrumentKey || !body.product) throw new BadRequestException('instrumentKey and product are required');
    return this.realTrading.manualExit(this.user(header), body.instrumentKey, body.product);
  }
  @Post('paper-trading/orders') async paperTradingCreate(@Headers('authorization') header: string, @Body() body: { instrumentKey?: string }) {
    const userId = this.user(header);
    const rows = await this.scanner.scan(userId);
    const candidate = rows.find((row) => row.instrumentKey === body.instrumentKey);
    await this.paperTrading.createTrade(userId, candidate);
    return this.paperTrading.dashboard(userId);
  }
  @Patch('paper-trading/settings') paperTradingSettings(@Headers('authorization') header: string, @Body() body: Record<string, unknown>) { return this.paperTrading.updateSettings(this.user(header), body); }
  @Post('paper-trading/orders/:orderId/exit') async paperTradingExit(@Headers('authorization') header: string, @Param('orderId') orderId: string) { await this.exitDemo(this.user(header), orderId, 'STRATEGY'); return this.paperTrading.dashboard(this.user(header)); }
  @Post('signal-history-demo/orders/:orderId/exit') async signalHistoryDemoExit(@Headers('authorization') header: string, @Param('orderId') orderId: string) { await this.exitDemo(this.user(header), orderId, 'SIGNAL_HISTORY'); this.market.notifyPaperTradingUpdated(this.user(header)); return this.paperTrading.dashboard(this.user(header), 'SIGNAL_HISTORY'); }
  private async exitDemo(userId: string, orderId: string, portfolio: 'STRATEGY' | 'SIGNAL_HISTORY') {
    const order = await this.prisma.paperOrder.findFirst({ where: { id: orderId, userId, portfolio, status: 'OPEN' } });
    if (!order) return;
    await this.market.refreshPrices(userId, [order.instrumentKey]);
    // The refresh may already have closed the position at a target or stop.
    const stillOpen = await this.prisma.paperOrder.findFirst({ where: { id: orderId, userId, status: 'OPEN' } });
    if (stillOpen && !await this.paperTrading.manualExit(userId, orderId, portfolio))
      throw new ServiceUnavailableException('A fresh market price is unavailable. Reconnecting; please retry the exit.');
  }
  @Get('watchlist') async watchlist(@Headers('authorization') header: string) {
    const userId = this.user(header); const items = await this.prisma.watchlistItem.findMany({ where: { userId } });
    return Promise.all(items.map(async (item: WatchlistItem) => ({ ...item, quote: await this.upstox.quote(userId, item.instrumentKey) })));
  }
  private async top(userId: string, side: 'BUY' | 'SELL') { return this.rank(await this.scanner.scan(userId), side); }
  private rank(rows: any[], side: 'BUY' | 'SELL') {
    const target1Time = (row: any) => {
      if (!row.target1At) return null;
      const timestamp = String(row.target1At).split('|')[0];
      const value = new Date(timestamp).getTime();
      return Number.isFinite(value) ? value : null;
    };
    return rows.filter((row) => row.signal === side).sort((a, b) => {
      const aTime = target1Time(a), bTime = target1Time(b);
      if (aTime !== null && bTime !== null) return bTime - aTime;
      if (aTime !== null) return -1;
      if (bTime !== null) return 1;
      return Number(b.aiScore ?? 0) - Number(a.aiScore ?? 0);
    }).slice(0, 10);
  }
  private signal(candles: Candle[], indicators: any) {
    if (!candles.length) return { signal: 'HOLD', confidence: 0, reason: 'No candle data', entryPrice: null, stopLoss: null, target1: null, target2: null, target3: null };
    const price = candles.at(-1)!.close; const atr = indicators.atr || price * 0.01;
    const bullish = price > (indicators.ema20 || price) && indicators.ema20 > (indicators.ema50 || 0) && indicators.rsi > 50 && indicators.macd?.histogram > 0;
    const bearish = price < (indicators.ema20 || price) && indicators.ema20 < (indicators.ema50 || Infinity) && indicators.rsi < 50 && indicators.macd?.histogram < 0;
    const signal = bullish ? 'BUY' : bearish ? 'SELL' : 'HOLD'; const direction = signal === 'SELL' ? -1 : 1;
    const entry = signal === 'HOLD' ? null : price, stopLoss = entry === null ? null : entry - direction * atr * 1.5;
    const target1 = entry === null ? null : entry + direction * atr * 1.5, target2 = entry === null ? null : entry + direction * atr * 3, target3 = entry === null ? null : entry + direction * atr * 4.5;
    return { signal, confidence: signal === 'HOLD' ? 45 : Math.min(90, 60 + Math.round(Math.abs((indicators.rsi || 50) - 50))), entry, entryPrice: entry, safeEntry: entry, aggressiveEntry: entry, stopLoss, target1, target2, target3, riskReward: entry && stopLoss && target3 ? Math.abs(target3 - entry) / Math.abs(entry - stopLoss) : null, reason: signal === 'HOLD' ? 'EMA, RSI, and MACD do not agree on a directional setup.' : `Intraday EMA trend, RSI ${indicators.rsi?.toFixed?.(1) ?? 'n/a'}, and MACD support ${signal.toLowerCase()} momentum.` };
  }
  private async completedTradeAnalysisCandles(userId: string, instrumentKey: string, timeframe: string, interval: number, requiredCandles = 200) {
    const cutoff = Math.floor(Date.now() / (interval * 60_000)) * interval * 60_000;
    const stored = await this.prisma.historicalCandle.findMany({
      where: { instrumentKey, timeframe, candleTime: { lt: new Date(cutoff) } },
      orderBy: { candleTime: 'desc' },
      take: 500,
    });
    let candles: Candle[] = stored.reverse().map((candle) => ({
      time: candle.candleTime.toISOString(),
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    }));
    if (candles.length >= requiredCandles) return candles;

    const to = this.tradingDate();
    // Upstox V3 permits at most one month for 1–15 minute historical requests.
    const from = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() - 28 * 86_400_000));
    this.logger.log(`Trade analysis history backfill | ${JSON.stringify({ instrumentKey, timeframe, interval, fromDate: from, toDate: to, storedCandles: candles.length })}`);
    const [historicalPayload, intradayPayload] = await Promise.all([
      this.upstox.history(userId, instrumentKey, 'minutes', interval, to, from),
      this.upstox.intraday(userId, instrumentKey, 'minutes', interval),
    ]);
    const downloaded = [...this.normalizeCandles(historicalPayload), ...this.normalizeCandles(intradayPayload)]
      .filter((candle) => new Date(candle.time).getTime() < cutoff);
    const merged = new Map<number, Candle>();
    for (const candle of [...candles, ...downloaded]) merged.set(new Date(candle.time).getTime(), candle);
    candles = [...merged.values()].sort((left, right) => new Date(left.time).getTime() - new Date(right.time).getTime()).slice(-500);
    if (candles.length) {
      for (let offset = 0; offset < candles.length; offset += 100) {
        await this.prisma.$transaction(candles.slice(offset, offset + 100).map((candle) => {
          const candleTime = new Date(candle.time);
          const values = { instrumentKey, timeframe, candleTime, open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume };
          return this.prisma.historicalCandle.upsert({
            where: { instrumentKey_timeframe_candleTime: { instrumentKey, timeframe, candleTime } },
            create: values,
            update: { open: candle.open, high: candle.high, low: candle.low, close: candle.close, volume: candle.volume },
          });
        }));
      }
    }
    this.logger.log(`Trade analysis candles ready | ${JSON.stringify({ instrumentKey, timeframe, completedCandles: candles.length })}`);
    return candles;
  }
  private indicatorDebugValues(indicators: any) {
    return {
      rsi: indicators?.rsi,
      ema: indicators?.ema ?? { ema20: indicators?.ema20, ema50: indicators?.ema50, ema200: indicators?.ema200 },
      macd: indicators?.macd,
      vwap: indicators?.vwap,
      atr: indicators?.atr,
      adx: indicators?.adx,
      support: indicators?.support,
      resistance: indicators?.resistance,
    };
  }
  private logInvalidIndicators(timeframe: string, indicators: any) {
    for (const [name, value] of Object.entries(this.indicatorDebugValues(indicators))) {
      const values = value && typeof value === 'object' ? Object.values(value) : [value];
      if (values.some((item) => item === undefined || item === null || (typeof item === 'number' && !Number.isFinite(item)))) {
        this.logger.warn(`${timeframe} indicator unavailable | ${JSON.stringify({ indicator: name, reason: indicators?.reason ?? `Calculation returned ${String(value)}`, value })}`);
      }
    }
  }
  private async diagnosed<T>(location: string, method: string, operation: () => Promise<T>) {
    try {
      this.logger.log(JSON.stringify({ event: 'endpoint.start', endpoint: location, method }));
      return await operation();
    } catch (error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      this.logger.error(JSON.stringify({ event: 'endpoint.error', endpoint: location, method, exceptionName: exception.name, message: exception.message, tradeId: this.context(error, 'tradeId') ?? this.context(error, 'id'), symbol: this.context(error, 'symbol'), stack: exception.stack }), exception.stack);
      if (error instanceof HttpException) throw error;
      throw new InternalServerErrorException('The request could not be completed. Please retry shortly.');
    }
  }
  private context(error: unknown, key: string) { return error && typeof error === 'object' && key in error ? String((error as Record<string, unknown>)[key] ?? '') || undefined : undefined; }
  private timeframeMinutes(timeframe: string) { const value = Number.parseInt(timeframe, 10); return [1, 3, 5, 15, 30].includes(value) ? value : 5; }
  private nextCandleClose(from: Date, timeframe: string) { const interval = this.timeframeMinutes(timeframe) * 60_000; return new Date(Math.floor(from.getTime() / interval) * interval + interval); }
  private noSetup(reason: string, message: string, timeframe: string, nextScanAt = this.nextCandleClose(new Date(), timeframe), detail?: string) { return { success: false, reason, message, detail, nextEligibleScanAt: nextScanAt.toISOString(), nextEligibleScanMessage: `Next scan after the next ${this.timeframeMinutes(timeframe)}-minute candle closes.` }; }
  private setupRejection(candidate: any, previous: any) {
    if (!candidate) return { logReason: 'No EMA crossover or analyzable candle data' };
    if (candidate.signal === 'HOLD') return { logReason: 'No EMA crossover' };
    if (Number(candidate.indicators?.volumeRatio ?? 0) < 1) return { logReason: 'Low volume' };
    if (Number(candidate.aiScore ?? 0) < 48) return { logReason: 'AI score below threshold' };
    if (Number(candidate.riskReward ?? 0) < 1.5) return { logReason: 'Risk/reward below threshold' };
    const same = candidate.signal === previous.side && Number(candidate.entry).toFixed(2) === Number(previous.entryPrice).toFixed(2) && Number(candidate.stopLoss).toFixed(2) === Number(previous.stopLoss).toFixed(2) && Number(candidate.target3).toFixed(2) === Number(previous.target3).toFixed(2) && candidate.aiScore === previous.aiScore;
    return same ? { logReason: 'Duplicate setup' } : null;
  }
}
