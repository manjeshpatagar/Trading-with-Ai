import { BadRequestException, Controller, Get, Headers, Param, Query } from '@nestjs/common';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma.service';
import { ChartDto, HistoryDto, OhlcDto, SearchDto } from './dto';
import { Candle, IndicatorService } from './indicator.service';
import { MarketGateway } from './market.gateway';
import { UpstoxService } from './upstox.service';
import { ScannerService } from './scanner.service';

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
  constructor(
    private readonly auth: AuthService,
    private readonly upstox: UpstoxService,
    private readonly indicators: IndicatorService,
    private readonly market: MarketGateway,
    private readonly prisma: PrismaService,
    private readonly scanner: ScannerService,
  ) {}

  private user(header: string | undefined) { return this.auth.userFromSession(header?.replace(/^Bearer\s+/i, '')); }
  private dates(dto: HistoryDto) {
    const to = dto.toDate ?? new Date().toISOString().slice(0, 10);
    const from = dto.fromDate ?? new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    return { to, from };
  }
  private normalizeCandles(payload: any): Candle[] {
    const rows = payload?.data?.candles ?? payload?.candles ?? [];
    if (!Array.isArray(rows)) return [];
    return rows.slice(-500).map((row: unknown[]) => ({
      time: String(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]),
    })).filter((candle: Candle) => Object.values(candle).every((value) => typeof value === 'string' || Number.isFinite(value))).reverse();
  }
  private async candles(userId: string, instrumentKey: string, dto: HistoryDto) {
    const { to, from } = this.dates(dto);
    return this.normalizeCandles(await this.upstox.history(userId, instrumentKey, dto.unit, dto.interval, to, from));
  }

  @Get('stocks/search') search(@Headers('authorization') header: string, @Query() query: SearchDto) { return this.upstox.search(this.user(header), query.q); }
  @Get('stocks/:instrumentKey/chart') async chart(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: ChartDto) {
    const userId = this.user(header);
    const intraday: Record<string, number> = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30 };
    const interval = intraday[dto.timeframe];
    if (!interval) throw new BadRequestException('Only 1m, 3m, 5m, 15m and 30m intraday timeframes are supported.');
    console.log('[UPSTOX CHART REQUEST]', JSON.stringify({ instrument_key: key, timeframe: dto.timeframe, unit: 'minutes', interval }));
    const payload = await this.upstox.intraday(userId, key, 'minutes', interval);
    const candles = this.normalizeCandles(payload); await this.market.subscribe(userId, key); return { candles, timeframe: dto.timeframe };
  }
  @Get('market/indices') async indices(@Headers('authorization') header: string) {
    const userId = this.user(header);
    const instrumentKeys = DASHBOARD_INDICES.map((index) => index.instrumentKey);
    const quote = await this.upstox.quote(userId, instrumentKeys.join(','));
    await Promise.all(instrumentKeys.map((instrumentKey) => this.market.subscribe(userId, instrumentKey)));
    return { indices: DASHBOARD_INDICES, quote };
  }
  @Get('stocks/:instrumentKey/history') async history(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: HistoryDto) {
    const userId = this.user(header); const candles = await this.candles(userId, key, dto); await this.market.subscribe(userId, key); return { candles };
  }
  @Get('stocks/:instrumentKey/intraday') async intraday(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: HistoryDto) {
    const userId = this.user(header); const payload = await this.upstox.intraday(userId, key, dto.unit, dto.interval); await this.market.subscribe(userId, key); return { candles: this.normalizeCandles(payload) };
  }
  @Get('stocks/:instrumentKey/quote') quote(@Headers('authorization') header: string, @Param('instrumentKey') key: string) { return this.upstox.quote(this.user(header), key); }
  @Get('stocks/:instrumentKey/ltp') ltp(@Headers('authorization') header: string, @Param('instrumentKey') key: string) { return this.upstox.ltp(this.user(header), key); }
  @Get('stocks/:instrumentKey/ohlc') ohlc(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: OhlcDto) { return this.upstox.ohlc(this.user(header), key, dto.interval); }
  @Get('stocks/:instrumentKey/analysis') async analysis(@Headers('authorization') header: string, @Param('instrumentKey') key: string, @Query() dto: HistoryDto) {
    const userId = this.user(header); const candles = await this.candles(userId, key, dto); const indicators = this.indicators.calculate(candles); await this.market.subscribe(userId, key); return { candles, indicators, analysis: this.signal(candles, indicators) };
  }
  @Get('scanner') scannerResults(@Headers('authorization') header: string, @Query('filter') filter?: string) { return this.scanner.filtered(this.user(header), filter); }
  @Get('scanner/top-buy') scannerBuy(@Headers('authorization') header: string) { return this.top(this.user(header), 'BUY'); }
  @Get('scanner/top-sell') scannerSell(@Headers('authorization') header: string) { return this.top(this.user(header), 'SELL'); }
  @Get('top-buy') topBuy(@Headers('authorization') header: string) { return this.top(this.user(header), 'BUY'); }
  @Get('top-sell') topSell(@Headers('authorization') header: string) { return this.top(this.user(header), 'SELL'); }
  @Get('analysis') async rankedAnalysis(@Headers('authorization') header: string) { const rows = await this.scanner.scan(this.user(header)); return rows.filter((row) => row.signal !== 'HOLD').sort((a, b) => Math.abs(b.score) - Math.abs(a.score)).slice(0, 20); }
  @Get('dashboard') async dashboard(@Headers('authorization') header: string) { const rows = await this.scanner.scan(this.user(header)); return { topBuy: this.rank(rows, 'BUY'), topSell: this.rank(rows, 'SELL'), scannerCount: rows.length }; }
  @Get('watchlist') async watchlist(@Headers('authorization') header: string) {
    const userId = this.user(header); const items = await this.prisma.watchlistItem.findMany({ where: { userId } });
    return Promise.all(items.map(async (item: WatchlistItem) => ({ ...item, quote: await this.upstox.quote(userId, item.instrumentKey) })));
  }
  private async top(userId: string, side: 'BUY' | 'SELL') { return this.rank(await this.scanner.scan(userId), side); }
  private rank(rows: any[], side: 'BUY' | 'SELL') { const ranked = rows.filter((row) => row.signal === side).sort((a, b) => Number(b.aiScore ?? 0) - Number(a.aiScore ?? 0)).slice(0, 10); if (!ranked.length) throw new BadRequestException(`Live scanner has no ranked ${side} signals.`); return ranked; }
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
}
