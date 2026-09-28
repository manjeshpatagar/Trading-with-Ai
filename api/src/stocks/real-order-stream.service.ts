import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import WebSocket = require('ws');
import { PrismaService } from '../prisma.service';
import { UpstoxService } from './upstox.service';
import { RealExecutionService } from './real-execution.service';
import { MarketGateway } from './market.gateway';

type StreamState = { status: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'INACTIVE'; lastMessageAt: string | null; connectedAt: string | null; reconnects: number; pollingFallback: boolean };
@Injectable()
export class RealOrderStreamService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RealOrderStreamService.name);
  private readonly sockets = new Map<string, WebSocket>();
  private readonly connecting = new Set<string>();
  private readonly wanted = new Set<string>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly heartbeats = new Map<string, NodeJS.Timeout>();
  private readonly lastSeen = new Map<string, number>();
  private readonly states = new Map<string, StreamState>();
  private readonly queues = new Map<string, Promise<void>>();
  private syncing = false;
  private stopped = false;
  constructor(private readonly prisma: PrismaService, private readonly broker: UpstoxService,
    private readonly execution: RealExecutionService, private readonly market: MarketGateway) {}
  onModuleInit() { setImmediate(() => void this.sync()); }
  onModuleDestroy() {
    this.stopped = true;
    for (const userId of this.wanted) this.disconnect(userId);
    this.wanted.clear();
  }
  status(userId: string): StreamState {
    return this.states.get(userId) ?? { status: 'INACTIVE', lastMessageAt: null, connectedAt: null, reconnects: 0, pollingFallback: true };
  }
  @Cron('*/5 * * * * *')
  async sync() {
    if (this.syncing || this.stopped) return;
    this.syncing = true;
    try {
      const controls = await this.prisma.realTradingControl.findMany({ where: { OR: [
        { activeTradeId: { not: null } }, { strategyEnabledAt: { not: null } }, { historyEnabledAt: { not: null } },
      ] } });
      const desired = new Set(controls.map(row => row.userId));
      for (const userId of this.wanted) if (!desired.has(userId)) { this.wanted.delete(userId); this.disconnect(userId); }
      for (const userId of desired) {
        this.wanted.add(userId);
        if (!this.sockets.has(userId) && !this.retries.has(userId)) void this.connect(userId);
      }
    } catch { this.logger.warn('Unable to refresh real-order subscriptions; polling remains active'); }
    finally { this.syncing = false; }
  }
  private openSocket(url: string) { return new WebSocket(url, { handshakeTimeout: 8_000, maxPayload: 1_048_576 }); }
  private async connect(userId: string) {
    if (this.stopped || !this.wanted.has(userId) || this.connecting.has(userId) || this.sockets.has(userId)) return;
    this.connecting.add(userId);
    this.states.set(userId, { ...this.status(userId), status: 'CONNECTING', pollingFallback: true });
    this.notify(userId);
    try {
      const url = await this.broker.portfolioStreamUrl(userId);
      if (this.stopped || !this.wanted.has(userId)) return;
      const socket = this.openSocket(url);
      this.sockets.set(userId, socket);
      socket.on('open', () => {
        if (this.sockets.get(userId) !== socket) return;
        this.lastSeen.set(userId, Date.now());
        this.states.set(userId, { ...this.status(userId), status: 'CONNECTED', connectedAt: new Date().toISOString(), pollingFallback: false });
        const heartbeat = setInterval(() => {
          if (Date.now() - (this.lastSeen.get(userId) ?? 0) > 45_000) socket.terminate();
          else if (socket.readyState === WebSocket.OPEN) socket.ping();
        }, 15_000);
        this.heartbeats.set(userId, heartbeat);
        // Catch up order state, never replay entry signals after reconnect.
        void this.execution.drive(userId).then(() => this.notify(userId)).catch(() => this.notify(userId));
        this.notify(userId);
      });
      socket.on('pong', () => this.lastSeen.set(userId, Date.now()));
      socket.on('ping', () => this.lastSeen.set(userId, Date.now()));
      socket.on('message', raw => {
        if (this.sockets.get(userId) !== socket) return;
        this.lastSeen.set(userId, Date.now());
        const receivedAt = new Date();
        const previous = this.queues.get(userId) ?? Promise.resolve();
        const pending = previous.catch(() => undefined).then(() => this.receive(userId, raw.toString(), receivedAt))
          .catch(() => this.logger.warn('Broker order update could not be applied; polling will reconcile it'))
          .finally(() => { if (this.queues.get(userId) === pending) this.queues.delete(userId); });
        this.queues.set(userId, pending);
      });
      socket.on('error', () => { socket.terminate(); });
      socket.on('close', () => {
        if (this.sockets.get(userId) !== socket) return;
        this.clearSocket(userId);
        this.retry(userId);
      });
    } catch {
      // The one-use URL contains credentials. Never log the URL or raw errors.
      this.retry(userId);
    } finally { this.connecting.delete(userId); }
  }
  private async receive(userId: string, raw: string, receivedAt: Date) {
    let update: any;
    try { update = JSON.parse(raw); } catch { return; }
    if (!update || !['order', 'position'].includes(update.update_type)) return;
    this.states.set(userId, { ...this.status(userId), lastMessageAt: receivedAt.toISOString() });
    if (update.update_type === 'order') await this.execution.applyBrokerOrder(userId, update, 'STREAM', receivedAt);
    else await this.execution.drive(userId); // REST confirmation still governs shared-slot release.
    this.notify(userId);
  }
  private retry(userId: string) {
    if (this.stopped || !this.wanted.has(userId) || this.retries.has(userId)) return;
    const previous = this.status(userId);
    const reconnects = previous.reconnects + 1;
    this.states.set(userId, { ...previous, status: 'RECONNECTING', reconnects, pollingFallback: true });
    this.notify(userId);
    this.retries.set(userId, setTimeout(() => { this.retries.delete(userId); void this.connect(userId); }, Math.min(30_000, 1_000 * 2 ** Math.min(reconnects - 1, 5))));
  }
  private clearSocket(userId: string) {
    this.sockets.delete(userId);
    const heartbeat = this.heartbeats.get(userId);
    if (heartbeat) clearInterval(heartbeat);
    this.heartbeats.delete(userId);
    this.lastSeen.delete(userId);
  }
  private disconnect(userId: string) {
    const socket = this.sockets.get(userId);
    this.clearSocket(userId);
    socket?.terminate();
    const timer = this.retries.get(userId);
    if (timer) clearTimeout(timer);
    this.retries.delete(userId);
    this.states.set(userId, { ...this.status(userId), status: 'INACTIVE', pollingFallback: true });
    this.notify(userId);
  }
  private notify(userId: string) { this.market.server?.to(`user:${userId}`).emit('real-trading-updated', { stream: this.status(userId) }); }
}
