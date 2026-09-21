'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { api, base } from '../lib/api';
import type { NiftyView } from '../lib/nifty';
import { NiftySettings } from './nifty-workspace';
type Metadata = { contract: {expiry:string;strike:number;type:string;lotSize:number};risk:number;targets:number[];progress:string[];mfe:number;mae:number;timestamp:number };
type Order = {id:string;symbol:string;quantity:number;investment:number;entryPrice:number;currentPrice:number;stopLoss:number;pnl:number;status:string;entryTime:string;exitTime:string|null;exitReason:string|null;niftyDemo:string};
type View = {signal: {side:string;strategy:string;niftyContext:{reasons:string;invalidations:string}}|null;startingBalance:number;availableCapital:number;usedCapital:number;realizedPnl:number;unrealizedPnl:number;todayPnl:number;tradeCount:number;openPosition:Order|null;trades:Order[];analysis:NiftyView};
const money = (n: number|null|undefined) => n == null ? '—' : `₹${n.toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
function Facts({items}:{items:[string,string][]}) {return <div className="grid grid-cols-2 gap-5 md:grid-cols-4">{items.map(([label,value])=><div key={label}><p className="metric-label">{label}</p><p className="metric-value break-words">{value}</p></div>)}</div>;}
export function NiftyDemoAccount({session}:{session:string}) {
  const client=useQueryClient(), [now,setNow]=useState(Date.now()), [editing,setEditing]=useState(false);
  const exit=useMutation({mutationFn:()=>api('/nifty/demo/exit',{method:'POST'}),onSuccess:()=>void client.invalidateQueries({queryKey:['nifty']})});
  const q=useQuery({queryKey:['nifty','demo',session],queryFn:()=>api<View>('/nifty/demo'),enabled:!!session,refetchInterval:5000});
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);if(!session)return ()=>clearInterval(timer);const socket=io(base,{auth:{token:session}});socket.on('nifty.demo.update',()=>void client.invalidateQueries({queryKey:['nifty','demo',session]}));return()=>{clearInterval(timer);socket.disconnect();};},[session,client]);
  if(!session)return <p>Connect Upstox to view the demo account.</p>;
  if(!q.data)return <p role="status">{q.error?.message ?? 'Loading demo account…'}</p>;
  const v=q.data,a=v.analysis,o=v.openPosition ?? v.trades[0],m=o?JSON.parse(o.niftyDemo) as Metadata:null;
  const delayed = !!v.openPosition && (!m || now-m.timestamp>a.settings.staleMs);
  const setup=a.setup, option=a.option;
  const reasons=v.signal?JSON.parse(v.signal.niftyContext.reasons) as string[]:setup?.reasons ?? [];
  const invalidations=v.signal?JSON.parse(v.signal.niftyContext.invalidations) as string[]:setup?.invalidations ?? [];
  return <div className="space-y-5"><section className="glass-card p-5"><div className="mb-5 flex justify-between"><div><h1 className="text-lg font-semibold">DEMO ACCOUNT</h1><p className="mt-2 text-3xl">{money(v.startingBalance)}</p></div><button className="primary-button" onClick={()=>setEditing(!editing)}>Risk settings</button></div><Facts items={[
    ['Available Capital',money(v.availableCapital)],['Used Capital',money(v.usedCapital)],['Realized P&L',money(v.realizedPnl)],['Unrealized P&L',money(v.unrealizedPnl)], ["Today's P&L",money(v.todayPnl)],['Trade Count',String(v.tradeCount)],['Open Position',v.openPosition?.symbol ?? 'None']
  ]}/></section>{editing && <NiftySettings settings={a.settings} onSaved={()=>{setEditing(false);void client.invalidateQueries({queryKey:['nifty']});}}/>}
  {(q.error || exit.error) && <p role="alert">{(q.error ?? exit.error)?.message}</p>}{v.openPosition && <button className="primary-button" disabled={exit.isPending || delayed} onClick={()=>exit.mutate()}>Close demo position</button>}
  <section className="glass-card p-5"><h2 className="mb-4 font-semibold">CURRENT SIGNAL</h2><p className="mb-4 text-amber-300">{delayed || a.optionDataDelayed ? 'OPTION DATA DELAYED · WAITING FOR LIVE PRICE' : !option && !v.openPosition ? 'NO TRADE · NO SUITABLE OPTION CONTRACT · WAITING FOR LIVE PRICE' : !v.openPosition ? a.noTradeReasons.join(' · ') : 'TRADE RUNNING'}</p><Facts items={[
    ['Direction',v.openPosition?m?.contract.type==='CE'?'CALL':'PUT':setup?.side==='BUY'?'CALL':'PUT'],['Strategy',(v.signal?.strategy ?? setup?.strategy)?.replaceAll('_',' ') ?? 'Waiting'],['Nifty Price',money(a.market?.ltp)],['Selected Option',v.openPosition?.symbol ?? option?.symbol ?? 'None'],['Option LTP',money(v.openPosition?.currentPrice ?? option?.ltp)],['Entry',money(v.openPosition?.entryPrice)],['SL',money(v.openPosition?.stopLoss)],['T1',money(v.openPosition?m?.targets[0]:null)],['T2',money(v.openPosition?m?.targets[1]:null)],['T3',money(v.openPosition?m?.targets[2]:null)],['R:R',`1:${a.settings.optionTargetR}`]
  ]}/></section><section className="glass-card p-5"><h2 className="mb-4 font-semibold">WHY THIS TRADE?</h2>{reasons.map(r=><p key={r} className="mb-2 text-sm text-slate-300">✓ {r}</p>)}<h2 className="mb-3 mt-5 font-semibold">INVALIDATION</h2>{invalidations.map(r=><p key={r} className="mb-2 text-sm text-slate-400">{r}</p>)}<p className="text-sm text-slate-400">Option stop loss, underlying structural invalidation, or square-off at {a.settings.squareOff} IST.</p></section>
  {o && m && <section className="glass-card p-5"><h2 className="mb-4 font-semibold">{o.status==='OPEN'?'TRADE RUNNING':'TRADE CLOSED'}</h2><p className="mb-4 font-mono text-xs text-cyan-300">Signal / Trade {o.id}</p><Facts items={[
    ['Exact Contract',o.symbol],['Expiry',m.contract.expiry],['Lot size',String(m.contract.lotSize)],['Quantity',String(o.quantity)],['Capital Used',money(o.investment)],['Risk Amount',money(m.risk)],['Entry',money(o.entryPrice)],['Option LTP',money(o.currentPrice)],['Current P&L',money(o.pnl)],['SL',money(o.stopLoss)],['T1',money(m.targets[0])],['T2',money(m.targets[1])],['T3',money(m.targets[2])],['Max Favorable Excursion',money(m.mfe)],['Max Adverse Excursion',money(m.mae)],['Duration',`${Math.max(0,Math.floor(((o.exitTime?Date.parse(o.exitTime):now)-Date.parse(o.entryTime))/1000))} sec`],['Status',o.status],['Exit reason',o.exitReason ?? '—']
  ]}/><p className="mt-5 text-cyan-300">{m.progress.join(' → ')}</p></section>}
  <section className="glass-card p-5"><h2 className="mb-4 font-semibold">Trade history</h2>{v.trades.map(r=><div key={r.id} className="flex flex-wrap justify-between gap-3 border-t border-white/10 py-3 text-sm"><span>{r.symbol} · {r.quantity}</span><span>{r.status} · {r.exitReason}</span><span>{money(r.pnl)}</span></div>)}</section></div>;
}
