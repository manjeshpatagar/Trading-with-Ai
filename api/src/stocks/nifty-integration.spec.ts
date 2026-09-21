import { after, before, test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { Server } from 'socket.io';
import { io, type Socket } from 'socket.io-client';
import { NiftyDemoService } from './nifty-demo.service';
import { NiftyService } from './nifty.service';
import { NiftyController } from './nifty.controller';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from '../prisma.service';
import { UpstoxService } from './upstox.service';
import { MarketGateway } from './market.gateway';
import { defaults, evaluate, NIFTY_KEY } from './nifty-engine';
import type { Candle } from './indicator.service';
const directory = mkdtempSync(join(tmpdir(), 'nifty-integration-'));
const url = `file:${join(directory, 'test.db')}`;
const db = new PrismaClient({ datasources: { db: { url } } });
let createService: () => NiftyService;
let app: INestApplication, server: Server, socket: Socket, endpoint: string, service: NiftyService, userId: string;
let listener: ((userId: string, key: string, price: number, timestamp: number, volume?: number) => void) | null = null;
let market = { timestampTrusted: true, ltp: 1000, open: 995, high: 1005, low: 990, close: 990, volume: 0, timestamp: Date.now() };
const received: Array<{
  event: string;
  payload: unknown;
}> = [];
const candles: Candle[] = Array.from({ length: 800 }, (_, i) => ({ time: new Date(Date.UTC(2026, 8, 15, 3, 45) + i * 60000).toISOString(), open: 1000 + i * .1, high: 1002 + i * .1, low: 999 + i * .1, close: 1001 + i * .1, volume: 0 }));
before(async () => {
  const sql = execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', join(__dirname, '../../prisma/schema.prisma'), '--script'], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url } });
  for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean))
    await db.$executeRawUnsafe(statement);
  userId = (await db.user.create({ data: { upstoxUserId: 'nifty-integration' } })).id;
  const feed = { websocketStatus: () => 'CONNECTED', onPrice: (callback: typeof listener) => { listener = callback; return () => { listener = null; }; }, subscribe: async () => { }, latestExchangeStatus: () => null, latestUserSnapshot: () => market, latestPrice: () => market.ltp, latestOptionBook: () => null, emitToUser: (_user: string, event: string, payload: unknown) => { received.push({ event, payload }); server?.emit(event, payload); } };
  const payload = { data: { candles: candles.map(c => [c.time, c.open, c.high, c.low, c.close, c.volume]) } };
  const upstox = { history: async () => payload, intraday: async () => payload, marketTimings: async () => ({ data: [] }), optionContracts: async () => ({ data: [] }) };
  createService = () => new NiftyService(db as PrismaService, upstox as unknown as UpstoxService, feed as unknown as MarketGateway, { enter: async () => undefined } as unknown as NiftyDemoService);
  service = createService();
  const module = await Test.createTestingModule({ controllers: [NiftyController], providers: [{provide: NiftyDemoService,useValue:{}}, { provide: NiftyService, useValue: service }, { provide: AuthService, useValue: { userFromSession: (token: string) => { if (token !== 'fixture-session')
            throw new UnauthorizedException(); return userId; } } }] }).compile();
  app = module.createNestApplication();
  await app.listen(0, '127.0.0.1');
  endpoint = await app.getUrl();
  server = new Server(app.getHttpServer());
  socket = io(endpoint, { transports: ['websocket'] });
  await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
});
after(async () => { socket?.disconnect(); server?.close(); await app?.close(); await db.$disconnect(); rmSync(directory, { recursive: true, force: true }); });
const get = (path: string) => fetch(endpoint + path, { headers: { Authorization: 'Bearer fixture-session' } });
test('authenticated broker candles → engine → HTTP response reports unavailable VWAP separately and blocks missing session', async () => { assert.equal((await fetch(endpoint + '/nifty/market')).status, 401); const response = await get('/nifty/market'); assert.equal(response.status, 200); const data = await response.json() as {
  regime: string;
  noTradeReasons: string[];
  strategies: Array<{
    valid: boolean;
  }>;
}; assert.ok(!data.noTradeReasons.some(r => r.includes('volume unavailable'))); assert.ok(data.noTradeReasons.some(r => r.includes('session'))); assert.ok(data.strategies.every(s => !s.valid)); for (const tf of [1, 3, 5, 15]) {
  assert.equal((await get(`/nifty/candles?timeframe=${tf}`)).status, 200);
} assert.equal((await get('/nifty/candles?timeframe=7')).status, 400); assert.equal(await db.aiSignal.count(), 0); });
test('settings validate mandatory timeframes and persist user configuration', async () => { const patch = (body: unknown) => fetch(endpoint + '/nifty/settings', { method: 'PATCH', headers: { Authorization: 'Bearer fixture-session', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal((await patch({ primaryTimeframe: 1 })).status, 400); assert.equal((await patch({ riskPercent: 1 })).status, 200); assert.equal((await service.settings(userId)).riskPercent, 1); assert.equal((await patch({ riskPercent: 0 })).status, 400); });
test('shared-feed live tick reaches websocket and duplicate ticks are rejected', { timeout: 15000 }, async () => { const timestamp = Date.now(); const arrival = new Promise<{
  timestampTrusted: boolean;
  ltp: number;
}>((resolve) => socket.once('nifty.price', resolve)); market = { ...market, ltp: 1002, timestamp }; listener!(userId, NIFTY_KEY, 1002, timestamp, 0); const liveTick=await arrival;assert.equal(liveTick.ltp, 1002);assert.equal(liveTick.timestampTrusted, true); await new Promise(resolve => setTimeout(resolve, 30)); const count = received.filter(e => e.event === 'nifty.price').length; listener!(userId, NIFTY_KEY, 1002, timestamp, 0); await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(received.filter(e => e.event === 'nifty.price').length, count); });
test('canonical signal context survives reload, duplicate setup IDs fail and square-off emits once', async () => { const evaluation = evaluate('TREND_PULLBACK', candles, new Date(), defaults); const now = new Date(); const signal = await db.aiSignal.create({ data: { userId, signalKey: 'canonical-nifty-fixture', instrumentKey: NIFTY_KEY, stockName: 'NIFTY 50', symbol: 'NIFTY', strategy: 'TREND_PULLBACK', timeframe: '15m/5m/3m', side: 'BUY', currentPrice: 1002, entryPrice: 1000, entryExecutedPrice: 1000, entryTriggeredAt: now, stopLoss: 990, target1: 1010, target2: 1020, target3: 1030, confidence: 0, aiScore: 80, riskReward: 2, status: 'RUNNING', signalTime: new Date(now.getTime() - 86400000), niftyContext: { create: { setupId: 'nifty-fixture-id', inputs: JSON.stringify({ ...evaluation, settings: defaults }), optionContract: JSON.stringify({ maximumRisk: 100 }), reasons: JSON.stringify(['Fixture facts']), invalidations: JSON.stringify(['Below 990']), setupDetectedAt: now } } } }); const rows = await service.history(userId); assert.equal(rows[0].id, signal.id); assert.equal(rows[0].entryPrice, 1000);assert.equal(rows[0].currentPrice,market.ltp);assert.equal(rows[0].marketTimestamp,market.timestamp); await assert.rejects(db.niftySignalContext.create({ data: { signalId: signal.id, setupId: 'nifty-fixture-id', inputs: '{}', optionContract: '{}', reasons: '[]', invalidations: '[]', setupDetectedAt: now } })); service.onModuleDestroy(); service = createService(); await service.onModuleInit(); await service.heartbeat(); await service.heartbeat(); const persisted = await db.aiSignal.findUniqueOrThrow({ where: { id: signal.id } }); assert.equal(persisted.status, 'AUTO_EXIT'); assert.equal(await db.aiTradeEvent.count({ where: { tradeId: signal.id, type: 'AUTO_EXIT' } }), 1); assert.ok(received.some(e => e.event === 'nifty.trade-progress')); });
test('historical replay runs off the event loop, persists statistics and withholds inadequate samples', { timeout: 60000 }, async () => { const data = await service.backtest(userId, '2026-09-15', '2026-09-16'); assert.equal(data.strategies.length, 4); assert.ok(data.strategies.every(s => !s.sufficient && s.winRate === null)); assert.equal(await db.niftyBacktestResult.count({ where: { userId } }), 1); });

test('stale observed ticks cannot generate stop/target lifecycle events',{timeout:60000},async()=>{
  const now=new Date();const earlier=new Date(`${now.toISOString().slice(0,10)}T10:00:00+05:30`);
  const evaluation=evaluate('TREND_PULLBACK',candles,now,defaults);
  const row=await db.aiSignal.create({data:{userId,signalKey:'stale-progress-fixture',instrumentKey:NIFTY_KEY,stockName:'NIFTY 50',symbol:'NIFTY',strategy:'TREND_PULLBACK',timeframe:'15m/5m/3m',side:'BUY',currentPrice:1000,entryPrice:1000,entryExecutedPrice:1000,entryTriggeredAt:earlier,stopLoss:990,target1:1010,target2:1020,target3:1030,confidence:0,aiScore:80,riskReward:2,status:'RUNNING',signalTime:earlier,niftyContext:{create:{setupId:'stale-progress-setup',inputs:JSON.stringify({...evaluation,settings:defaults}),optionContract:JSON.stringify({maximumRisk:100}),reasons:'[]',invalidations:'[]',setupDetectedAt:earlier}}}});
  service.onModuleDestroy();service=createService();await service.onModuleInit();
  market={...market,ltp:980,timestamp:earlier.getTime()};listener!(userId,NIFTY_KEY,980,earlier.getTime(),0);
  await (service as unknown as {queues:Map<string,Promise<void>>}).queues.get(userId);
  assert.equal((await db.aiSignal.findUniqueOrThrow({where:{id:row.id}})).status,'RUNNING');
  assert.equal(await db.aiTradeEvent.count({where:{tradeId:row.id}}),0);
});
