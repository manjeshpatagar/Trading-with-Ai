import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server } from 'socket.io';
import WebSocket from 'ws';
import * as protobuf from 'protobufjs';
import { AuthService } from '../auth/auth.service';
import { UpstoxService } from './upstox.service';

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

@WebSocketGateway({ cors: { origin: process.env.WEB_ORIGIN } })
@Injectable()
export class MarketGateway implements OnModuleDestroy {
  @WebSocketServer() server!: Server;
  private readonly sockets = new Map<string, WebSocket>();
  private readonly keys = new Map<string, Set<string>>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly heartbeatTimers = new Map<string, NodeJS.Timeout>();
  private readonly latestTicks = new Map<string, unknown>();
  private readonly ltpFallbacks = new Set<string>();
  private readonly log = new Logger(MarketGateway.name);

  constructor(private readonly upstox: UpstoxService, private readonly auth: AuthService) {}

  async subscribe(userId: string, instrumentKey: string) {
    const keys = this.keys.get(userId) ?? new Set<string>();
    keys.add(instrumentKey); this.keys.set(userId, keys);
    if (!this.sockets.has(userId)) await this.connect(userId); else this.sendSubscription(userId, 'sub');
  }

  async subscribeMany(userId: string, instrumentKeys: string[]) {
    const keys = this.keys.get(userId) ?? new Set<string>();
    for (const instrumentKey of instrumentKeys) keys.add(instrumentKey);
    this.keys.set(userId, keys);
    if (!this.sockets.has(userId)) await this.connect(userId); else this.sendSubscription(userId, 'sub');
  }

  latestPrice(instrumentKey: string) {
    const feed: any = this.latestTicks.get(instrumentKey);
    const value = feed?.ltpc?.ltp ?? feed?.fullFeed?.marketFF?.ltpc?.ltp ?? feed?.fullFeed?.indexFF?.ltpc?.ltp;
    return Number.isFinite(Number(value)) ? Number(value) : null;
  }

  private async connect(userId: string) {
    if (this.sockets.has(userId) || !this.keys.get(userId)?.size) return;
    try {
      const authorization = await this.upstox.feedUrl(userId);
      const url = authorization?.data?.authorized_redirect_uri ?? authorization?.authorized_redirect_uri;
      if (!url || typeof url !== 'string') throw new Error(`Upstox V3 feed authorization did not return authorized_redirect_uri: ${JSON.stringify(authorization)}`);
      const accessToken = await this.auth.accessToken(userId);
      const socket = new WebSocket(url, { followRedirects: true, headers: { Authorization: `Bearer ${accessToken}`, Accept: '*/*' } });
      this.sockets.set(userId, socket);
      socket.on('open', () => { this.log.log(`Upstox V3 feed connected for ${userId}`); this.sendSubscription(userId, 'sub'); this.startHeartbeat(userId); });
      socket.on('message', (data) => this.handle(userId, data));
      socket.on('pong', () => this.log.debug(`Upstox V3 feed pong for ${userId}`));
      socket.on('error', (error) => this.log.error(`Upstox V3 feed error for ${userId}: ${error.message}`, error.stack));
      socket.on('close', (code, reason) => { this.log.warn(`Upstox V3 feed closed for ${userId}: ${code} ${reason.toString()}`); this.cleanupSocket(userId); void this.fallbackToLtp(userId, 'feed closed'); this.scheduleReconnect(userId); });
    } catch (error) {
      this.log.error(`Upstox V3 feed connection failed for ${userId}: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
      void this.fallbackToLtp(userId, 'feed connection failed');
      this.scheduleReconnect(userId);
    }
  }

  /** Emit only actual LTP data while the V3 stream reconnects. */
  private async fallbackToLtp(userId: string, reason: string) {
    const instrumentKeys = [...(this.keys.get(userId) ?? [])];
    if (!instrumentKeys.length || this.ltpFallbacks.has(userId)) return;
    this.ltpFallbacks.add(userId);
    this.log.warn(`Upstox V3 feed fallback to LTP | User ID: ${userId} | Reason: ${reason} | Requested keys: ${instrumentKeys.join(',')}`);
    try {
      const response: any = await this.upstox.ltp(userId, instrumentKeys.join(','));
      const data = response?.data ?? response ?? {};
      const feeds: Record<string, { ltpc: { ltp: number; cp: number } }> = {};
      for (const instrumentKey of instrumentKeys) {
        const value = data[instrumentKey] ?? data[instrumentKey.replace('|', ':')];
        const ltp = Number(value?.last_price ?? value?.ltp);
        const cp = Number(value?.cp ?? value?.ohlc?.close ?? ltp);
        if (Number.isFinite(ltp)) {
          feeds[instrumentKey] = { ltpc: { ltp, cp: Number.isFinite(cp) ? cp : ltp } };
          this.latestTicks.set(instrumentKey, feeds[instrumentKey]);
        }
      }
      const returned = Object.keys(feeds);
      const missing = instrumentKeys.filter((key) => !feeds[key]);
      this.log.log(`Upstox LTP fallback result | User ID: ${userId} | Returned keys: ${returned.join(',')} | Missing keys: ${missing.join(',') || 'none'}`);
      if (returned.length) this.server.to(`user:${userId}`).emit('market-tick', { feeds });
    } catch (error) {
      this.log.error(`Upstox LTP fallback failed | User ID: ${userId} | Reason: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.ltpFallbacks.delete(userId);
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
    this.heartbeatTimers.set(userId, setInterval(() => {
      const socket = this.sockets.get(userId);
      if (socket?.readyState === WebSocket.OPEN) socket.ping();
    }, 30_000));
  }
  private stopHeartbeat(userId: string) { const timer = this.heartbeatTimers.get(userId); if (timer) clearInterval(timer); this.heartbeatTimers.delete(userId); }
  private cleanupSocket(userId: string) { this.stopHeartbeat(userId); this.sockets.delete(userId); }
  private scheduleReconnect(userId: string) {
    if (this.reconnectTimers.has(userId) || !this.keys.get(userId)?.size) return;
    this.reconnectTimers.set(userId, setTimeout(() => { this.reconnectTimers.delete(userId); void this.connect(userId); }, 3_000));
  }
  private handle(userId: string, raw: WebSocket.RawData) {
    try {
      const buffer = Buffer.isBuffer(raw) ? raw : Buffer.concat(raw as Buffer[]);
      const decoded = FEED_RESPONSE.decode(buffer);
      const tick = FEED_RESPONSE.toObject(decoded, { longs: String, enums: String, defaults: false });
      const feeds = (tick as { feeds?: Record<string, unknown> }).feeds ?? {};
      for (const [instrumentKey, receivedTick] of Object.entries(feeds)) {
        const previousPrice = this.latestTicks.get(instrumentKey);
        this.latestTicks.set(instrumentKey, receivedTick);
        console.log('[UPSTOX V3 MARKET TICK]', JSON.stringify({ instrumentKey, receivedTick, previousPrice, updatedPrice: receivedTick }));
      }
      this.log.debug(`Upstox V3 market tick received for ${userId}`);
      console.log('[SOCKET.IO MARKET TICK BROADCAST]', JSON.stringify({ userId, tick }));
      this.server.to(`user:${userId}`).emit('market-tick', tick);
    } catch (error) {
      this.log.error(`Unable to decode Upstox V3 protobuf tick for ${userId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  handleConnection(client: any) { try { client.join(`user:${this.auth.userFromSession(client.handshake.auth?.token)}`); } catch { client.disconnect(true); } }
  onModuleDestroy() { for (const timer of this.reconnectTimers.values()) clearTimeout(timer); for (const socket of this.sockets.values()) socket.close(); for (const userId of this.heartbeatTimers.keys()) this.stopHeartbeat(userId); }
}
