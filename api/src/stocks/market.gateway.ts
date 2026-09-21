import { MarketPricesService } from './market-prices.service';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import WebSocket = require('ws');
import * as protobuf from 'protobufjs';
import { AuthService } from '../auth/auth.service';
import { UpstoxService } from './upstox.service';
import { SignalHistoryService } from './signal-history.service';
import { PaperTradingService } from './paper-trading.service';

const V3_FEED_PROTO = `syntax = "proto3";
package com.upstox.marketdatafeederv3udapi.rpc.proto;
message LTPC { double ltp = 1; int64 ltt = 2; int64 ltq = 3; double cp = 4; }
message Quote { int64 bidQ = 1; double bidP = 2; int64 askQ = 3; double askP = 4; }
message MarketLevel { repeated Quote bidAskQuote = 1; }
message OHLC { string interval = 1; double open = 2; double high = 3; double low = 4; double close = 5; int64 vol = 6; int64 ts = 7; }
message MarketOHLC { repeated OHLC ohlc = 1; }
message OptionGreeks { double delta = 1; double theta = 2; double gamma = 3; double vega = 4; double rho = 5; }
message MarketFullFeed { LTPC ltpc = 1; MarketLevel marketLevel = 2; OptionGreeks optionGreeks = 3; MarketOHLC marketOHLC = 4; double atp = 5; int64 vtt = 6; double oi = 7; double iv = 8; double tbq = 9; double tsq = 10; }
message IndexFullFeed { LTPC ltpc = 1; MarketOHLC marketOHLC = 2; }
message FullFeed { oneof FullFeedUnion { MarketFullFeed marketFF = 1; IndexFullFeed indexFF = 2; } }
message FirstLevelWithGreeks { LTPC ltpc = 1; Quote firstDepth = 2; OptionGreeks optionGreeks = 3; int64 vtt = 4; double oi = 5; double iv = 6; }
enum RequestMode { ltpc = 0; full_d5 = 1; option_greeks = 2; full_d30 = 3; }
message Feed { oneof FeedUnion { LTPC ltpc = 1; FullFeed fullFeed = 2; FirstLevelWithGreeks firstLevelWithGreeks = 3; } RequestMode requestMode = 4; }
enum Type { initial_feed = 0; live_feed = 1; market_info = 2; }
enum MarketStatus { PRE_OPEN_START = 0; PRE_OPEN_END = 1; NORMAL_OPEN = 2; NORMAL_CLOSE = 3; CLOSING_START = 4; CLOSING_END = 5; }
message MarketInfo { map<string, MarketStatus> segmentStatus = 1; }
message FeedResponse { Type type = 1; map<string, Feed> feeds = 2; int64 currentTs = 3; MarketInfo marketInfo = 4; }`;
const FEED_RESPONSE = protobuf.parse(V3_FEED_PROTO).root.lookupType('com.upstox.marketdatafeederv3udapi.rpc.proto.FeedResponse');

export function normalizeMarketTimestamp(value: unknown, receivedAt = Date.now()) {
  let timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return receivedAt;
  while (timestamp > 10_000_000_000_000) timestamp /= 1_000;
  if (timestamp < 10_000_000_000) timestamp *= 1_000;
  return Math.round(timestamp);
}

@WebSocketGateway({ cors: { origin: process.env.WEB_ORIGIN } })
@Injectable()
export class MarketGateway implements OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly keys = new Map<string, Set<string>>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly lastFeedAt = new Map<string, number>();
  private readonly latestTicks = new Map<string, unknown>();
  private readonly marketSnapshots = new Map<string, { ltp: number; open: number | null; high: number | null; low: number | null; close: number | null; volume: number; timestamp: number }>();
  private readonly ltpFallbacks = new Set<string>();
  private readonly tradingTickQueues = new Map<string, Promise<void>>();
  private readonly log = new Logger(MarketGateway.name);
  private shuttingDown = false;
  private readonly connecting = new Set<string>();

  constructor(private readonly upstox: UpstoxService, private readonly auth: AuthService, private readonly signalHistory: SignalHistoryService, private readonly paperTrading: PaperTradingService, private readonly prices: MarketPricesService = new MarketPricesService()) {}

  private readonly previousCloseTrust = new Map<string, boolean>();
  private readonly dailyOhlcTrust = new Map<string, boolean>();
  private readonly timestampTrust = new Map<string, boolean>();
  private readonly exchangeStatuses = new Map<string, { status: string; receivedAt: number }>();
  websocketStatus(userId: string) { return this.sockets.get(userId)?.readyState === WebSocket.OPEN ? 'CONNECTED' : this.connecting.has(userId) ? 'CONNECTING' : 'DISCONNECTED'; }
  latestExchangeStatus(userId: string) { return this.exchangeStatuses.get(userId) ?? null; }
  private readonly priceListeners = new Set<(userId: string, key: string, price: number, timestamp: number, volume?: number) => void>();
  onPrice(listener: (userId: string, key: string, price: number, timestamp: number, volume?: number) => void) { this.priceListeners.add(listener); return () => { this.priceListeners.delete(listener); }; }
  emitToUser(userId: string, event: string, payload: unknown) { this.server?.to(`user:${userId}`).emit(event, payload); }
  private notifyPrice(userId: string, key: string, price: number, timestamp: number) { for (const listener of this.priceListeners) { try { listener(userId, key, price, timestamp, this.marketSnapshots.get(key)?.volume); } catch (error) { this.log.warn(String(error)); } } }

  async subscribe(userId: string, instrumentKey: string) {
    if (this.shuttingDown) return;
    const keys = this.keys.get(userId) ?? new Set<string>();
    const added = !keys.has(instrumentKey);
    keys.add(instrumentKey); this.keys.set(userId, keys);
    if (!this.sockets.has(userId)) await this.connect(userId); else if (added) this.sendSubscription(userId, 'sub');
  }

  async subscribeMany(userId: string, instrumentKeys: string[]) {
    if (this.shuttingDown) return;
    const keys = this.keys.get(userId) ?? new Set<string>();
    const added = instrumentKeys.some(key => !keys.has(key));
    for (const instrumentKey of instrumentKeys) keys.add(instrumentKey);
    this.keys.set(userId, keys);
    if (!this.sockets.has(userId)) await this.connect(userId); else if (added) this.sendSubscription(userId, 'sub');
  }

  async refreshPrices(userId: string, instrumentKeys: string[]) {
    const keys = [...new Set(instrumentKeys)].filter(Boolean);
    if (!keys.length) return;
    void this.subscribeMany(userId, keys);
    await this.fallbackToLtp(userId, 'scheduled open demo position refresh', keys);
  }

  latestPrice(instrumentKey: string) {
    const feed: any = this.latestTicks.get(instrumentKey);
    const value = feed?.ltpc?.ltp ?? feed?.fullFeed?.marketFF?.ltpc?.ltp ?? feed?.fullFeed?.indexFF?.ltpc?.ltp ?? feed?.firstLevelWithGreeks?.ltpc?.ltp;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }
  latestOptionBook(userId: string, instrumentKey: string) {
    const quote = this.prices.get(userId, instrumentKey);
    const feed: any = this.latestTicks.get(instrumentKey);
    const full = feed?.fullFeed?.marketFF ?? feed?.firstLevelWithGreeks;
    const depth = full?.marketLevel?.bidAskQuote?.[0] ?? full?.firstDepth;
    if (!quote || !depth) return null;
    const optional = (value: unknown) => value != null && Number.isFinite(Number(value)) ? Number(value) : null;
    return { ...quote, bid: Number(depth.bidP), ask: Number(depth.askP), volume: Number(full.vtt), oi: optional(full.oi), iv: optional(full.iv), delta: optional(full.optionGreeks?.delta) };
  }
  latestUserSnapshot(userId: string, instrumentKey: string) { const quote = this.prices.get(userId, instrumentKey); const snapshot = this.marketSnapshots.get(instrumentKey); return quote ? { timestampTrusted: this.timestampTrust.get(`${userId}:${instrumentKey}`) === true, open: this.dailyOhlcTrust.get(`${userId}:${instrumentKey}`) ? snapshot?.open ?? null : null, high: this.dailyOhlcTrust.get(`${userId}:${instrumentKey}`) ? snapshot?.high ?? null : null, low: this.dailyOhlcTrust.get(`${userId}:${instrumentKey}`) ? snapshot?.low ?? null : null, close: this.previousCloseTrust.get(`${userId}:${instrumentKey}`) ? snapshot?.close ?? null : null, volume: snapshot?.volume ?? 0, ...quote } : null; }
  latestSnapshot(instrumentKey: string) { return this.marketSnapshots.get(instrumentKey) ?? null; }

  private async connect(userId: string) {
    if (this.shuttingDown || this.sockets.has(userId) || this.connecting.has(userId) || !this.keys.get(userId)?.size) return;
    this.connecting.add(userId);
    if (!this.heartbeatTimers.has(userId)) this.startHeartbeat(userId);
    try {
      const authorization = await this.upstox.feedUrl(userId);
      const url = authorization?.data?.authorized_redirect_uri ?? authorization?.authorized_redirect_uri;
      if (!url || typeof url !== 'string') throw new Error(`Upstox V3 feed authorization did not return authorized_redirect_uri: ${JSON.stringify(authorization)}`);
      const accessToken = await this.auth.accessToken(userId);
      const socket = new WebSocket(url, { followRedirects: true, headers: { Authorization: `Bearer ${accessToken}`, Accept: '*/*' } });
      this.sockets.set(userId, socket);
      socket.on('open', () => { this.log.log(`Upstox V3 feed connected for ${userId}`); this.lastFeedAt.set(userId, Date.now()); this.sendSubscription(userId, 'sub'); this.startHeartbeat(userId); });
      socket.on('message', (data) => this.handle(userId, data));
      socket.on('pong', () => this.log.debug(`Upstox V3 feed pong for ${userId}`));
      socket.on('error', (error) => { if (!this.shuttingDown) this.log.error(`Upstox V3 feed error for ${userId}: ${error.message}`, error.stack); });
      socket.on('close', (code, reason) => {
        this.cleanupSocket(userId);
        if (this.shuttingDown) return;
        this.log.warn(`Upstox V3 feed closed for ${userId}: ${code} ${reason.toString()}`);
        void this.fallbackToLtp(userId, 'feed closed');
        this.scheduleReconnect(userId);
      });
    } catch (error) {
      if (this.shuttingDown) return;
      this.log.error(`Upstox V3 feed connection failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      void this.fallbackToLtp(userId, 'feed connection failed');
      this.scheduleReconnect(userId);
    } finally { this.connecting.delete(userId); }
  }

  /** Emit only actual LTP data while the V3 stream reconnects. */
  private async fallbackToLtp(userId: string, reason: string, requestedKeys?: string[]) {
    const instrumentKeys = requestedKeys ?? [...(this.keys.get(userId) ?? [])];
    const fallbackKey = `${userId}:${[...instrumentKeys].sort().join(',')}`;
    if (this.shuttingDown || !instrumentKeys.length || this.ltpFallbacks.has(fallbackKey)) return;
    this.ltpFallbacks.add(fallbackKey);
    const requestedAt = Date.now();
    const revisions = new Map(instrumentKeys.map(key => [key, this.prices.get(userId, key)?.sequence ?? 0]));
    this.log.warn(`Upstox V3 feed fallback to LTP | User ID: ${userId} | Reason: ${reason} | Requested keys: ${instrumentKeys.join(',')}`);
    try {
      const data: Record<string, any> = {};
      // Keep requests below provider URL/instrument limits as subscriptions
      // grow throughout the session.
      for (let offset = 0; offset < instrumentKeys.length; offset += 100) {
        const batch = instrumentKeys.slice(offset, offset + 100);
        const response: any = await this.upstox.ltp(userId, batch.join(','));
        Object.assign(data, response?.data ?? response ?? {});
      }
      if (this.shuttingDown) return;
      const feeds: Record<string, { ltpc: { ltp: number; cp: number } }> = {};
      const processing: Promise<void>[] = [];
      const quoteByInstrument = new Map<string, any>();
      for (const value of Object.values<any>(data)) if (typeof value?.instrument_token === 'string') quoteByInstrument.set(value.instrument_token, value);
      for (const instrumentKey of instrumentKeys) {
        const value = quoteByInstrument.get(instrumentKey) ?? data[instrumentKey] ?? data[instrumentKey.replace('|', ':')];
        const ltp = Number(value?.last_price ?? value?.ltp);
        const cp = Number(value?.cp ?? value?.ohlc?.close ?? ltp);
        if (value?.instrument_token && value.instrument_token !== instrumentKey) continue;
        const quote = this.prices.accept(userId, instrumentKey, ltp,
          normalizeMarketTimestamp(value?.last_trade_time ?? value?.timestamp, requestedAt), Date.now(), revisions.get(instrumentKey));
        if (quote) {
          this.previousCloseTrust.set(`${userId}:${instrumentKey}`, Number(value?.cp ?? value?.ohlc?.close) > 0);
          this.dailyOhlcTrust.set(`${userId}:${instrumentKey}`, [value?.ohlc?.open, value?.ohlc?.high, value?.ohlc?.low].every(v => Number(v) > 0));
          this.timestampTrust.set(`${userId}:${instrumentKey}`, Number(value?.last_trade_time ?? value?.timestamp) > 0);
          feeds[instrumentKey] = { ltpc: { ltp, cp: Number.isFinite(cp) ? cp : ltp } };
          this.latestTicks.set(instrumentKey, feeds[instrumentKey]);
          this.marketSnapshots.set(instrumentKey, { open: Number.isFinite(Number(value?.ohlc?.open)) ? Number(value.ohlc.open) : null, high: Number.isFinite(Number(value?.ohlc?.high)) ? Number(value.ohlc.high) : null, low: Number.isFinite(Number(value?.ohlc?.low)) ? Number(value.ohlc.low) : null, close: Number.isFinite(cp) ? cp : null, volume: Number(value?.volume ?? 0), ...quote });
          this.server.to(`user:${userId}`).emit('market-price-updated', { instrumentKey, ...this.marketSnapshots.get(instrumentKey) });
          processing.push(this.queueTradingTick(userId, instrumentKey, ltp, this.marketSnapshots.get(instrumentKey)!.timestamp, 'ltp-fallback'));
        }
      }
      if (Object.keys(feeds).length) this.server.to(`user:${userId}`).emit('market-tick', { feeds });
      await Promise.all(processing);
      const returned = Object.keys(feeds);
      const missing = instrumentKeys.filter((key) => !feeds[key]);
      this.log.log(`Upstox LTP fallback result | User ID: ${userId} | Returned keys: ${returned.join(',')} | Missing keys: ${missing.join(',') || 'none'}`);
    } catch (error) {
      if (this.shuttingDown) return;
      this.log.error(`Upstox LTP fallback failed | User ID: ${userId} | Reason: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ltpFallbacks.delete(fallbackKey);
    }
  }

  private sendSubscription(userId: string, method: 'sub' | 'change_mode') {
    const socket = this.sockets.get(userId); const instrumentKeys = [...(this.keys.get(userId) ?? [])];
    if (!socket || socket.readyState !== WebSocket.OPEN || !instrumentKeys.length) return;
    // V3 requires binary websocket request frames.
    const payload = Buffer.from(JSON.stringify({ guid: crypto.randomUUID(), method, data: { mode: 'full', instrumentKeys } }));
    socket.send(payload, (error) => { if (error) this.log.error(`Upstox V3 subscription failed for ${userId}: ${error.message}`, error.stack); });
  }

  private startHeartbeat(userId: string) {
    this.stopHeartbeat(userId);
    let checks = 0;
    this.heartbeatTimers.set(userId, setInterval(() => {
      const socket = this.sockets.get(userId);
      checks += 1;
      if (socket?.readyState === WebSocket.OPEN && checks % 6 === 0) socket.ping();
      const silentForMs = Date.now() - (this.lastFeedAt.get(userId) ?? 0);
      if (socket?.readyState !== WebSocket.OPEN || silentForMs >= 5_000) {
        this.log.warn(JSON.stringify({ event: 'market.feed.stale', userId, silentForMs, action: 'broker LTP fallback' }));
        void this.fallbackToLtp(userId, `websocket silent for ${silentForMs}ms`);
      }
    }, 5_000));
  }
  private stopHeartbeat(userId: string) { const timer = this.heartbeatTimers.get(userId); if (timer) clearInterval(timer); this.heartbeatTimers.delete(userId); }
  private cleanupSocket(userId: string) { this.sockets.delete(userId); }
  private scheduleReconnect(userId: string) {
    if (this.shuttingDown || this.reconnectTimers.has(userId) || !this.keys.get(userId)?.size) return;
    this.reconnectTimers.set(userId, setTimeout(() => { this.reconnectTimers.delete(userId); void this.connect(userId); }, 3_000));
  }
  private queueTradingTick(userId: string, instrumentKey: string, price: number, timestamp: number, source: 'websocket' | 'ltp-fallback') {
    const queueKey = `${userId}:${instrumentKey}`;
    const previous = this.tradingTickQueues.get(queueKey) ?? Promise.resolve();
    const queued = previous.catch(() => undefined)
      .then(() => this.processTradingTick(userId, instrumentKey, price, timestamp, source))
      .finally(() => {
        if (this.tradingTickQueues.get(queueKey) === queued) this.tradingTickQueues.delete(queueKey);
      });
    this.tradingTickQueues.set(queueKey, queued);
    return queued;
  }

  notifyPaperTradingUpdated(userId: string) {
    this.server?.to(`user:${userId}`).emit('paper-trading-updated', { portfolio: 'SIGNAL_HISTORY' });
  }

  private async processTradingTick(userId: string, instrumentKey: string, price: number, timestamp: number, source: string) {
    this.notifyPrice(userId, instrumentKey, price, timestamp);
    try {
      this.log.log(JSON.stringify({ event: 'demo.live.tick.processing', userId, instrumentKey, price, timestamp, source }));
      const marketTime = new Date(timestamp);
      const earlyExit = await this.paperTrading.processTick(userId, instrumentKey, price, marketTime);
      const trades = await this.signalHistory.processTick(userId, instrumentKey, price, marketTime);
      if (trades.length) this.server.to(`user:${userId}`).emit('signal-history-updated', { instrumentKey, price, trades });
      const demoChanged = trades.length ? await this.paperTrading.captureTriggeredDemoSignals(userId, trades, marketTime) : false;
      // Only a new fill needs another pass on this same tick (including a
      // price jump through T1 and T3). Ordinary ticks already updated/exited
      // positions above; repeating that work adds database pressure.
      const portfolioChanged = demoChanged ? await this.paperTrading.processTick(userId, instrumentKey, price, marketTime) : false;
      if (earlyExit || demoChanged || portfolioChanged) this.server.to(`user:${userId}`).emit('paper-trading-updated', { instrumentKey, price });
    } catch (error) {
      this.log.warn(`Trading tick processing failed for ${instrumentKey}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private handle(userId: string, raw: WebSocket.RawData) {
    try {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
      const decoded = FEED_RESPONSE.decode(buffer);
      const tick = FEED_RESPONSE.toObject(decoded, { longs: String, enums: String, defaults: false });
      const segments = (tick as { marketInfo?: { segmentStatus?: Record<string, string> } }).marketInfo?.segmentStatus;
      const exchangeStatus = segments?.NSE_INDEX ?? segments?.NSE_EQ;
      if (exchangeStatus) this.exchangeStatuses.set(userId, { status: exchangeStatus, receivedAt: Date.now() });
      const feeds = (tick as { feeds?: Record<string, unknown> }).feeds ?? {};
      if (Object.keys(feeds).length) this.lastFeedAt.set(userId, Date.now());
      const acceptedFeeds: Record<string, unknown> = {};
      for (const [instrumentKey, receivedTick] of Object.entries(feeds)) {
        const feed: any = receivedTick; const price = Number(feed?.ltpc?.ltp ?? feed?.fullFeed?.marketFF?.ltpc?.ltp ?? feed?.fullFeed?.indexFF?.ltpc?.ltp ?? feed?.firstLevelWithGreeks?.ltpc?.ltp);
        const marketFeed = feed?.fullFeed?.marketFF; const ohlcRows: any[] = marketFeed?.marketOHLC?.ohlc ?? feed?.fullFeed?.indexFF?.marketOHLC?.ohlc ?? []; const daily = ohlcRows.find((item) => item.interval === '1d') ; const close = Number(feed?.ltpc?.cp ?? marketFeed?.ltpc?.cp ?? feed?.fullFeed?.indexFF?.ltpc?.cp);
        const providerTimestamp = [feed?.ltpc?.ltt, marketFeed?.ltpc?.ltt, feed?.fullFeed?.indexFF?.ltpc?.ltt, feed?.firstLevelWithGreeks?.ltpc?.ltt, (tick as any).currentTs].find(value=>Number.isFinite(Number(value)) && Number(value)>0);
        const quote = this.prices.accept(userId, instrumentKey, price, normalizeMarketTimestamp(providerTimestamp));
        if (!quote) continue;
        this.previousCloseTrust.set(`${userId}:${instrumentKey}`, close > 0);
        this.dailyOhlcTrust.set(`${userId}:${instrumentKey}`, ohlcRows.some(row => row.interval === '1d'));
        this.timestampTrust.set(`${userId}:${instrumentKey}`, Number(providerTimestamp) > 0);
        acceptedFeeds[instrumentKey] = receivedTick;
        this.latestTicks.set(instrumentKey, receivedTick);
        if (Number.isFinite(price)) this.marketSnapshots.set(instrumentKey, { open: Number.isFinite(Number(daily?.open)) ? Number(daily.open) : null, high: Number.isFinite(Number(daily?.high)) ? Number(daily.high) : null, low: Number.isFinite(Number(daily?.low)) ? Number(daily.low) : null, close: Number.isFinite(close) ? close : null, volume: Number(marketFeed?.vtt ?? daily?.vol ?? 0), ...quote });
        if (Number.isFinite(price)) this.queueTradingTick(userId, instrumentKey, price, this.marketSnapshots.get(instrumentKey)!.timestamp, 'websocket');
        if (Number.isFinite(price)) this.server.to(`user:${userId}`).emit('market-price-updated', { instrumentKey, ...this.marketSnapshots.get(instrumentKey) });
        this.log.debug(JSON.stringify({ event: 'market.tick.received', instrument: instrumentKey, ltp: price, tickTimestamp: this.marketSnapshots.get(instrumentKey)?.timestamp, socketIoClientsNotified: this.server.sockets.adapter.rooms.get(`user:${userId}`)?.size ?? 0 }));
      }
      this.log.debug(`Upstox V3 market tick received for ${userId}`);
      this.server.to(`user:${userId}`).emit('market-tick', { ...tick, feeds: acceptedFeeds });
    } catch (error) {
      this.log.error(`Unable to decode Upstox V3 protobuf tick for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  handleConnection(client: any) {
    try {
      const userId = this.auth.userFromSession(client.handshake.auth?.token);
      client.join(`user:${userId}`);
      for (const key of this.keys.get(userId) ?? []) {
        const quote = this.prices.get(userId, key);
        if (quote) client.emit('market-price-updated', quote);
      }
    } catch { client.disconnect(true); }
  }
  onModuleDestroy() {
    this.shuttingDown = true;
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    this.reconnectTimers.clear();
    for (const userId of this.heartbeatTimers.keys()) this.stopHeartbeat(userId);
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    this.keys.clear();
    this.lastFeedAt.clear();
    this.tradingTickQueues.clear();
  }
}
