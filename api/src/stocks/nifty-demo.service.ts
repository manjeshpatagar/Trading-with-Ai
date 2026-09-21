import { optionRiskLevels } from './nifty-option-engine';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { PrismaService } from '../prisma.service';
import { MarketGateway } from './market.gateway';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { exchangeDate, exchangeTime, NIFTY_KEY, optionLiquidityPass, positionSize, Settings } from './nifty-engine';
import type { PaperOrder } from '@prisma/client';
export type DemoMetadata = { contract: { instrumentKey: string; symbol: string; lotSize: number; expiry: string; strike: number; type: string }; settings: Settings; risk: number; targets: number[]; progress: string[]; mfe: number; mae: number; timestamp: number };
@Injectable()
export class NiftyDemoService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NiftyDemoService.name);
  private readonly unsubscribe: () => void;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly prisma: PrismaService, private readonly market: MarketGateway, private readonly execution: PaperOrderExecutionService) {
    this.unsubscribe = market.onPrice((userId, key) => { this.queue = this.queue.catch(() => undefined).then(() => this.update(userId, key)).catch(error => this.logger.error(String(error))); });
  }
  onModuleDestroy() { this.unsubscribe(); }
  async onModuleInit() { for (const row of await this.prisma.paperOrder.findMany({ where: { portfolio: 'NIFTY', status: 'OPEN' } })) { await this.market.subscribe(row.userId, row.instrumentKey); await this.market.subscribe(row.userId, NIFTY_KEY); } }
  private event(userId: string, signalId: string, type: string, details: unknown = {}) { this.logger.log(JSON.stringify({ event: `nifty.demo.${type}`, signalId, tradeId: signalId, details })); this.market.emitToUser(userId, 'nifty.demo.update', { signalId, tradeId: signalId, type, details }); }
  async enter(userId: string, signalId: string, contract: DemoMetadata['contract'], settings: Settings, entryConfirmed = false) {
    if (!entryConfirmed) return;
    this.event(userId, signalId, 'signal_detected');
    const quote = this.market.latestUserSnapshot(userId, contract.instrumentKey), book = this.market.latestOptionBook(userId, contract.instrumentKey);
    if (!quote || !book || !optionLiquidityPass({ ltp: quote.ltp, bid: book.bid, ask: book.ask, volume: book.volume, lotSize: contract.lotSize, timestamp: quote.timestamp, timestampTrusted: quote.timestampTrusted }, settings, Date.now())) return;
    this.event(userId, signalId, 'option_selected', contract);
    const created = await this.prisma.$transaction(async tx => {
      if (Date.now()-quote.timestamp > settings.staleMs) return;
      const signal = await tx.aiSignal.findFirst({ where: { id: signalId, userId }, include: { niftyContext: true } });
      if (!signal?.niftyContext || signal.status !== 'WAITING' || signal.completedAt || signal.aiScore < settings.minimumScore || await tx.paperOrder.findUnique({ where: { signalId_portfolio: { signalId, portfolio: 'NIFTY' } } })) return;
      const account = await tx.paperTradingAccount.upsert({ where: { userId_portfolio: { userId, portfolio: 'NIFTY' } }, create: { userId, portfolio: 'NIFTY', startingBalance: 10000, maxOpenTrades: 1 }, update: {} });
      const rows = await tx.paperOrder.findMany({ where: { userId, portfolio: 'NIFTY' }, orderBy: { entryTime: 'desc' } });
      const today = rows.filter(r => r.entryTime && exchangeDate(r.entryTime) === exchangeDate(new Date()));
      let consecutive = 0;
      for (const r of rows.filter(r => r.status === 'CLOSED')) { if (r.pnl >= 0) break; consecutive++; }
      const todayPnl = today.filter(r=>r.status==='CLOSED').reduce((sum,r) => sum+r.pnl,0);
      const available = account.startingBalance + account.realizedPnl;
      const levels = optionRiskLevels(book.ask,settings.optionStopPercent,settings.optionTargetR);
      const unitRisk = levels.riskPerUnit;
      const quantity = positionSize(available, settings.riskPercent, book.ask, unitRisk, contract.lotSize);
      const risk = quantity * unitRisk;
      if (rows.some(r => r.status === 'OPEN') || !quantity || today.length >= settings.maxTrades || consecutive >= settings.maxConsecutiveLosses || todayPnl-risk < -account.startingBalance*settings.dailyLossPercent/100 || exchangeTime(new Date()) >= settings.cutoff) return;
      const fill = await this.execution.fill({ price: book.ask, quantity, at: new Date() });
      const targets = levels.targets;
      const metadata: DemoMetadata = { contract, settings, risk, targets, progress: ['ENTRY','RUNNING'], mfe: 0, mae: 0, timestamp: quote.timestamp };
      this.event(userId,signalId,'risk_validated',{quantity,risk});
      await tx.paperOrder.create({ data: { id: signalId, userId, signalId, portfolio: 'NIFTY', instrumentKey: contract.instrumentKey, symbol: contract.symbol, side: 'BUY', confidence: signal.aiScore, status: 'OPEN', quantity, budget: fill.investment, plannedEntry: fill.entryPrice, currentPrice: fill.entryPrice, target: targets[2], stopLoss: fill.entryPrice-unitRisk, niftyDemo: JSON.stringify(metadata), ...fill } });
      await tx.aiTradeEvent.create({data:{tradeId:signalId,type:'DEMO_ENTRY_FILLED',triggerPrice:fill.entryPrice,executedPrice:fill.entryPrice,eventTime:fill.entryTime,profitPercent:0,holdingMinutes:0}});
      return true;
    });
    const order = await this.prisma.paperOrder.findUnique({where:{id:signalId}});
    if (created && order) { this.event(userId,signalId,'order_created'); this.event(userId,signalId,'entry_filled',{entry:order.entryPrice,quantity:order.quantity}); }
  }
  private async mark(row: PaperOrder, timer = false, forcedReason?: string) {
    if (!row.niftyDemo) return;
    const m = JSON.parse(row.niftyDemo) as DemoMetadata;
    const quote = this.market.latestUserSnapshot(row.userId,row.instrumentKey);
    const now = new Date();
    const square = exchangeTime(now) >= m.settings.squareOff || exchangeDate(now) > exchangeDate(row.entryTime!);
    const fresh = quote?.timestampTrusted && quote.ltp > 0 && Date.now()-quote.timestamp <= m.settings.staleMs && quote.timestamp <= Date.now()+1000;
    // A delayed feed cannot provide an honest exit fill. Keep the slot reserved until a fresh quote arrives.
    if (!fresh || (!square && timer)) return;
    if (!square && !forcedReason && quote.timestamp <= m.timestamp) return;
    const pnl = (quote.ltp-row.entryPrice!)*row.quantity;
    m.timestamp = quote.timestamp; m.mfe = Math.max(m.mfe,pnl); m.mae = Math.min(m.mae,pnl);
    let reason: string | null = square ? 'AUTO EXIT' : quote.ltp <= row.stopLoss ? 'STOP LOSS' : forcedReason ?? null;
    const underlying = this.market.latestUserSnapshot(row.userId,NIFTY_KEY);
    const signal = await this.prisma.aiSignal.findUnique({where:{id:row.signalId!}});
    if (!reason && signal && underlying?.timestampTrusted && Date.now()-underlying.timestamp <= m.settings.staleMs && (signal.side === 'BUY' ? underlying.ltp <= signal.stopLoss : underlying.ltp >= signal.stopLoss)) reason = 'STRUCTURAL INVALIDATION';
    const hits: string[] = [];
    if (!reason) m.targets.forEach((target,i) => { const stage = `T${i+1}`; if (quote.ltp >= target && !m.progress.includes(stage)) { m.progress.push(stage); hits.push(stage); } });
    if (!reason && quote.ltp >= m.targets[2]) reason = 'T3';
    if (reason) m.progress.push(...(reason === 'T3' ? ['CLOSED'] : [reason,'CLOSED']));
    const trailingStop = m.settings.trailAfterT2 && m.progress.includes('T2') ? m.targets[0] : m.settings.moveToBreakeven && m.progress.includes('T1') ? row.entryPrice! : row.stopLoss;
    const close = reason ? await this.execution.close({ price: quote.ltp, entryPrice: row.entryPrice!, quantity: row.quantity, side:'BUY', at:now, reason }) : null;
    const applied = await this.prisma.$transaction(async tx => {
      const changed = await tx.paperOrder.updateMany({where:{id:row.id,status:'OPEN',updatedAt:row.updatedAt},data:{ stopLoss:trailingStop,currentPrice:quote.ltp,pnl,pnlPercent:pnl/row.investment*100,niftyDemo:JSON.stringify(m), ...(close ? {status:'CLOSED',exitPrice:close.exitPrice,exitTime:now,exitReason:reason,durationMinutes:Math.floor((now.getTime()-row.entryTime!.getTime())/60000)} : {}) }});
      if (changed.count) for (const type of [...hits,...(reason ? [reason,'CLOSED'] : [])]) {
        await tx.aiTradeEvent.upsert({where:{tradeId_type:{tradeId:row.id,type:`DEMO_${type.replaceAll(' ','_')}`}},create:{tradeId:row.id,type:`DEMO_${type.replaceAll(' ','_')}`,triggerPrice:quote.ltp,executedPrice:quote.ltp,eventTime:now,profitPercent:pnl/row.investment*100,holdingMinutes:Math.floor((now.getTime()-row.entryTime!.getTime())/60000)},update:{}});
      }
      if (changed.count && close) {
        await tx.paperTradingAccount.update({where:{userId_portfolio:{userId:row.userId,portfolio:'NIFTY'}},data:{realizedPnl:{increment:close.pnl}}});
        await tx.aiSignal.update({where:{id:row.signalId!},data:{status:reason === 'T3' ? 'TARGET_3_HIT' : reason === 'STOP LOSS' ? 'STOP_LOSS' : 'AUTO_EXIT',completedAt:now,exitPrice:underlying?.ltp ?? signal?.currentPrice}});
      }
      return changed.count > 0;
    });
    if (!applied) return;
    for (const hit of hits) this.event(row.userId,row.id,`${hit}_hit`);
    this.event(row.userId,row.id,reason ?? 'price_update',{ltp:quote.ltp,pnl});
    if (close) this.event(row.userId,row.id,'trade_closed',close);
  }
  async invalidateSetup(userId: string, reason: string) {
    const row = await this.prisma.paperOrder.findFirst({where:{userId,portfolio:'NIFTY',status:'OPEN'}});
    if (row) await this.mark(row,false,reason);
  }
  private async update(userId: string, key: string) { const rows = await this.prisma.paperOrder.findMany({where:{userId,portfolio:'NIFTY',status:'OPEN',...(key === NIFTY_KEY ? {} : {instrumentKey:key})}}); for (const row of rows) await this.mark(row); }
  @Interval(5000)
  async heartbeat() { this.queue = this.queue.catch(() => undefined).then(async () => { for (const row of await this.prisma.paperOrder.findMany({where:{portfolio:'NIFTY',status:'OPEN'}})) await this.mark(row,true); }); await this.queue; }
  async view(userId: string) {
    const account = await this.prisma.paperTradingAccount.upsert({where:{userId_portfolio:{userId,portfolio:'NIFTY'}},create:{userId,portfolio:'NIFTY',startingBalance:10000,maxOpenTrades:1},update:{}});
    const orders = await this.prisma.paperOrder.findMany({where:{userId,portfolio:'NIFTY'},orderBy:{createdAt:'desc'}});
    const open = orders.find(r => r.status === 'OPEN') ?? null;
    const used = open?.investment ?? 0, unrealized = open?.pnl ?? 0;
    const signal = open ? await this.prisma.aiSignal.findUnique({where:{id:open.signalId!},include:{niftyContext:true}}) : null;
    return { signal, startingBalance:account.startingBalance, availableCapital:account.startingBalance+account.realizedPnl-used, usedCapital:used, realizedPnl:account.realizedPnl, unrealizedPnl:unrealized, todayPnl:orders.filter(r=>exchangeDate(r.exitTime ?? new Date())===exchangeDate(new Date())).reduce((t,r)=>t+r.pnl,0), tradeCount:orders.filter(r=>r.entryTime && exchangeDate(r.entryTime)===exchangeDate(new Date())).length, openPosition:open, trades:orders.slice(0,100) };
  }
}
