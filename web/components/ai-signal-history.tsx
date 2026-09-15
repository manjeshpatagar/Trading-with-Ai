'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bot, Check, ChevronDown, Clock3, Radio, TrendingDown, TrendingUp, WalletCards, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, base, token } from '../lib/api';
import { signalHistoryDemoService } from '../lib/trading-services';

type TradeEvent = { id: string; type: string; triggerPrice: number; executedPrice: number; eventTime: string; profitPercent: number; holdingMinutes: number };
export type AiSignal = { id: string; signalTime: string; updatedAt: string; instrumentKey: string; stockName: string; symbol: string; sector: string; strategy: string; timeframe: string; currentPrice: number; entryPrice: number; stopLoss: number; target1: number; target2: number; target3: number; side: 'BUY' | 'SELL'; confidence: number; aiScore: number; riskReward: number; volume: number; status: string; events: TradeEvent[]; entryTriggeredAt?: string | null; runningAt?: string | null; target1At?: string | null; target2At?: string | null; target3At?: string | null; stopLossAt?: string | null; completedAt?: string | null; profitPercent?: number | null; holdingMinutes?: number | null };
type Response = { signals: AiSignal[]; summary: { todaySignals: number; winningTrades: number; losingTrades: number; winRate: number; averageProfit: number; averageLoss: number; bestTrade: AiSignal | null; worstTrade: AiSignal | null } };
const ACTIVE = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT'];
const rank: Record<string, number> = { WAITING: 0, ENTRY_TRIGGERED: 1, RUNNING: 2, TARGET1_HIT: 3, TARGET2_HIT: 4, TARGET3_HIT: 5, COMPLETED: 6, STOPLOSS_HIT: -1 };
const money = (amount: number) => `₹${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const time = (value?: string | null) => value ? new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';
const isCurrentTradingDay = (value: string) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const label = (value: string) => ({ TARGET1_HIT: 'Target 1 Hit', TARGET2_HIT: 'Target 2 Hit', TARGET3_HIT: 'Target 3 Hit', STOPLOSS_HIT: 'Stop Loss Hit', COMPLETED: 'Trade Completed' }[value] ?? value.split('_').map((word) => word[0] + word.slice(1).toLowerCase()).join(' '));
const selectClass = 'rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 text-xs font-semibold text-slate-200 outline-none focus:border-cyan-400/50';

function Summary({ label: title, value, tone = 'text-white' }: { label: string; value: string | number; tone?: string }) { return <div className="glass-card p-4"><p className="metric-label">{title}</p><p className={`mt-2 text-xl font-black ${tone}`}>{value}</p></div>; }
function Filter({ title, value, values, onChange }: { title: string; value: string; values: string[]; onChange: (value: string) => void }) { return <label className="flex min-w-32 flex-col gap-1.5"><span className="metric-label">{title}</span><select className={selectClass} value={value} onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{item === 'ALL' ? `All ${title}s` : label(item)}</option>)}</select></label>; }
function Metric({ title, value, tone = 'text-slate-200' }: { title: string; value: string; tone?: string }) { return <div><p className="metric-label">{title}</p><p className={`mt-1 text-xs font-bold ${tone}`}>{value}</p></div>; }

function Progress({ signal }: { signal: AiSignal }) {
  const stopped = signal.status === 'STOPLOSS_HIT';
  const steps = [
    { title: 'Waiting', done: true, at: signal.signalTime },
    { title: 'Entry Triggered', done: rank[signal.status] >= 1 || stopped, at: signal.entryTriggeredAt },
    { title: 'Running', done: rank[signal.status] >= 2 || stopped, at: signal.runningAt },
    { title: 'Target 1', done: rank[signal.status] >= 3, at: signal.target1At },
    { title: 'Target 2', done: rank[signal.status] >= 4, at: signal.target2At },
    { title: 'Target 3', done: rank[signal.status] >= 5 || signal.status === 'COMPLETED', at: signal.target3At },
    { title: 'Completed', done: signal.status === 'COMPLETED', at: signal.completedAt },
  ];
  return <div className="mt-4 border-t border-slate-700/70 pt-4"><p className="metric-label">Trade Progress</p><div className="mt-3 grid gap-2 sm:grid-cols-4 xl:grid-cols-7">{steps.map((step) => { const latest = step.done && step.at && time(step.at) === time(steps.filter((item) => item.done && item.at).at(-1)?.at); return <div key={step.title} className={`rounded-lg border p-2.5 ${step.done ? 'border-emerald-400/25 bg-emerald-400/[.07]' : 'border-slate-700 bg-slate-900/40'} ${latest && !signal.completedAt ? 'animate-pulse' : ''}`}><div className="flex items-center gap-1.5">{step.done ? <Check className="h-3.5 w-3.5 text-emerald-300" /> : <span className="h-2 w-2 rounded-full bg-slate-600" />}<p className={`text-[10px] font-bold ${step.done ? 'text-emerald-300' : 'text-slate-500'}`}>{step.title}</p></div><p className="mt-1 text-[10px] text-slate-500">{time(step.at)}</p></div>; })}</div>{stopped && <div className="mt-3 flex items-center gap-3 rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-rose-300"><X className="h-4 w-4" /><div><p className="text-xs font-black">STOP LOSS HIT · TRADE CLOSED</p><p className="mt-1 text-[10px]">{time(signal.stopLossAt)}</p></div></div>}</div>;
}

function TradeHistory({ trades }: { trades: AiSignal[] }) {
  if (!trades.length) return null;
  return <details className="mt-4 border-t border-slate-700/70 pt-3"><summary className="flex cursor-pointer list-none items-center gap-2 text-xs font-bold text-slate-400"><ChevronDown className="h-4 w-4" />Trade History ({trades.length})</summary><div className="mt-3 space-y-2">{trades.map((trade, index) => <Link key={trade.id} href={`/analysis/${encodeURIComponent(trade.instrumentKey)}?signal=${encodeURIComponent(trade.id)}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-900/50 p-3 text-xs"><span className="font-bold text-white">Trade #{trades.length - index}</span><span className={trade.status === 'STOPLOSS_HIT' ? 'text-rose-300' : 'text-emerald-300'}>{label(trade.status)}</span><span className={Number(trade.profitPercent) >= 0 ? 'text-emerald-300' : 'text-rose-300'}>{trade.profitPercent == null ? '—' : `${trade.profitPercent > 0 ? '+' : ''}${trade.profitPercent.toFixed(2)}%`}</span><span className="text-slate-500">{time(trade.entryTriggeredAt)} → {time(trade.completedAt)}</span></Link>)}</div></details>;
}

function EventTimeline({ events, side }: { events: TradeEvent[]; side: 'BUY' | 'SELL' }) {
  return <div className="mt-4 border-t border-slate-700/70 pt-4"><p className="metric-label">Chronological Event Timeline</p><div className="mt-3 space-y-2">{events.map((event, index) => <div key={event.id} className="grid gap-2 rounded-lg border border-slate-700 bg-slate-900/40 p-3 sm:grid-cols-[28px_1.3fr_repeat(5,1fr)]"><div className={`grid h-6 w-6 place-items-center rounded-full text-[10px] font-black ${event.type === 'STOPLOSS_HIT' ? 'bg-rose-500/20 text-rose-300' : side === 'BUY' ? 'bg-emerald-400/15 text-emerald-300' : 'bg-rose-400/15 text-rose-300'}`}>{index + 1}</div><Metric title="Event" value={label(event.type)} /><Metric title="Trigger Price" value={money(event.triggerPrice)} /><Metric title="Executed Price" value={money(event.executedPrice)} /><Metric title="Event Time" value={time(event.eventTime)} /><Metric title="Profit / Loss" value={`${event.profitPercent >= 0 ? '+' : ''}${event.profitPercent.toFixed(2)}%`} tone={event.profitPercent >= 0 ? 'text-emerald-300' : 'text-rose-300'} /><Metric title="Holding" value={`${event.holdingMinutes} min`} /></div>)}</div></div>;
}

function TradeCard({ signal, history, generate }: { signal: AiSignal; history: AiSignal[]; generate: (id: string) => void }) {
  const buy = signal.side === 'BUY'; const sideTone = buy ? 'text-emerald-300' : 'text-rose-300'; const terminal = signal.status === 'COMPLETED' || signal.status === 'STOPLOSS_HIT';
  const statusTone = signal.status === 'WAITING' ? 'bg-slate-700 text-slate-300' : signal.status === 'ENTRY_TRIGGERED' ? 'bg-sky-400/10 text-sky-300' : signal.status === 'RUNNING' ? 'bg-amber-400/10 text-amber-300' : signal.status === 'STOPLOSS_HIT' ? 'bg-rose-400/10 text-rose-300' : signal.status === 'COMPLETED' ? 'bg-emerald-700/30 text-emerald-200' : 'bg-emerald-400/10 text-emerald-300';
  return <article className="glass-card p-4"><Link href={`/analysis/${encodeURIComponent(signal.instrumentKey)}?signal=${encodeURIComponent(signal.id)}`} className="block"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-3"><div className={`grid h-10 w-10 place-items-center rounded-xl ${buy ? 'bg-emerald-400/10 text-emerald-300' : 'bg-rose-400/10 text-rose-300'}`}>{buy ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}</div><div><p className="font-bold text-white">{signal.stockName}</p><p className="mt-1 text-xs text-slate-500">{signal.symbol} · {signal.strategy} · {signal.timeframe}</p></div></div><div className="text-right"><span className={`inline-block rounded-full px-2.5 py-1 text-[10px] font-black ${buy ? 'bg-emerald-400/10 text-emerald-300' : 'bg-rose-400/10 text-rose-300'}`}>{signal.side}</span><span className={`ml-2 inline-block rounded-full px-2.5 py-1 text-[10px] font-bold ${statusTone}`}>{label(signal.status)}</span></div></div><div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-700/70 pt-3 sm:grid-cols-6 lg:grid-cols-11"><Metric title="Current" value={money(signal.currentPrice)} /><Metric title="Last Update" value={time(signal.updatedAt)} /><Metric title={`${signal.side} Entry`} value={money(signal.entryPrice)} tone={signal.entryTriggeredAt ? sideTone : 'text-slate-300'} /><Metric title="Stop Loss" value={money(signal.stopLoss)} tone="text-rose-300" /><Metric title="Target 1" value={money(signal.target1)} tone={signal.target1At ? sideTone : 'text-slate-300'} /><Metric title="Target 2" value={money(signal.target2)} tone={signal.target2At ? sideTone : 'text-slate-300'} /><Metric title="Target 3" value={money(signal.target3)} tone={signal.target3At ? sideTone : 'text-slate-300'} /><Metric title="AI Score" value={`${signal.aiScore}/100`} /><Metric title="Confidence" value={`${signal.confidence}%`} /><Metric title="Risk Reward" value={`1 : ${signal.riskReward.toFixed(2)}`} /><Metric title="Holding" value={signal.holdingMinutes == null ? 'Running' : `${signal.holdingMinutes} min`} /></div><Progress signal={signal} /><EventTimeline events={signal.events ?? []} side={signal.side} /></Link>{terminal && <div className="mt-4 flex justify-end"><button className="primary-button" onClick={() => generate(signal.id)}>Scan for New Setup</button></div>}<TradeHistory trades={history} /></article>;
}

type DemoOrder = { id: string; signalId?: string | null; instrumentKey: string; symbol: string; side: 'BUY' | 'SELL'; confidence: number; quantity: number; budget: number; investment: number; pnl: number; pnlPercent: number; status: string; plannedEntry: number; entryPrice?: number | null; currentPrice: number; target: number; stopLoss: number; createdAt: string; entryTime?: string | null; exitTime?: string | null; exitPrice?: number | null; exitReason?: string | null; durationMinutes?: number | null; lastMarketUpdate?: string | null };
type DemoDashboard = {
  account: { enabled: boolean; autoDemoTrading?: boolean; startingBalance: number; maxOpenTrades: number };
  summary: { virtualBalance: number; usedCapital: number; availableCapital: number; todayPnl: number; openPositions: number; closedTrades: number };
  performance: { todayProfit: number; todayLoss: number; winningTrades: number; losingTrades: number };
  openPositions: DemoOrder[];
  waitingOrders: DemoOrder[];
  tradeHistory: DemoOrder[];
};
type ScannerCandidate = {
  instrumentKey: string;
  symbol?: string;
  company?: string;
  signal?: string;
  confidence: number;
  riskReward?: number | null;
  target1?: number | null;
  target2?: number | null;
  target3?: number | null;
  stopLoss?: number | null;
  price?: number;
  aiScore?: number;
  entryQuality?: string;
  openingGapPercent?: number;
  riskLevel?: string;
  buyProbability?: number;
  sellProbability?: number;
  entryValidation?: Record<string, boolean>;
  indicators?: Record<string, number>;
  tradeStatus?: string | null;
};
function DemoRiskMeter({ level }: { level: string }) {
  const labels = ['VERY LOW', 'LOW', 'MEDIUM', 'HIGH', 'EXTREME'];
  const active = Math.max(0, labels.indexOf(level));
  return <div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><div className="flex justify-between"><p className="text-[10px] font-bold uppercase text-slate-500">Risk Meter</p><p className="text-[10px] font-black text-white">{level}</p></div><div className="mt-3 flex gap-1">{labels.map((item, index) => <span key={item} className={`h-2 flex-1 rounded-full ${index <= active ? index < 2 ? 'bg-emerald-400' : index === 2 ? 'bg-amber-400' : 'bg-rose-400' : 'bg-slate-800'}`} />)}</div></div>;
}

function LiveDemoPositionCard({ order, signal, scanner, onExit }: { order: DemoOrder; signal?: AiSignal; scanner?: ScannerCandidate; onExit: (id: string) => Promise<void> }) {
  const previousPnl = useRef(order.pnl);
  const [flash, setFlash] = useState<'up' | 'down' | null>(null);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1_000); return () => window.clearInterval(timer); }, []);
  useEffect(() => {
    if (order.pnl === previousPnl.current) return;
    setFlash(order.pnl > previousPnl.current ? 'up' : 'down');
    previousPnl.current = order.pnl;
    const timer = window.setTimeout(() => setFlash(null), 500);
    return () => window.clearTimeout(timer);
  }, [order.pnl]);
  const buy = order.side === 'BUY';
  const entry = Number(order.entryPrice ?? order.plannedEntry);
  const targets = [scanner?.target1 ?? signal?.target1, scanner?.target2 ?? signal?.target2, scanner?.target3 ?? signal?.target3 ?? order.target].map(Number);
  const targetHit = (target: number) => buy ? order.currentPrice >= target : order.currentPrice <= target;
  const stopHit = buy ? order.currentPrice <= order.stopLoss : order.currentPrice >= order.stopLoss;
  const finalTarget = targets[2] || order.target;
  const progress = finalTarget === entry ? 0 : Math.min(100, Math.max(0, (order.currentPrice - entry) / (finalTarget - entry) * 100));
  const currentValue = order.investment + order.pnl;
  const distanceToStop = Math.abs(entry - order.stopLoss);
  const remainingRisk = distanceToStop ? Math.max(0, (buy ? order.currentPrice - order.stopLoss : order.stopLoss - order.currentPrice) / distanceToStop) : 0;
  const riskLevel = stopHit ? 'EXTREME' : remainingRisk < .25 ? 'HIGH' : remainingRisk < .6 ? 'MEDIUM' : order.pnl >= 0 ? 'LOW' : 'MEDIUM';
  const baseRecovery = Number(buy ? scanner?.buyProbability : scanner?.sellProbability);
  const recovery = Math.round(Math.min(99, Math.max(1, (Number.isFinite(baseRecovery) ? baseRecovery : order.confidence) + order.pnlPercent * 2 - (riskLevel === 'HIGH' ? 18 : riskLevel === 'EXTREME' ? 35 : 0))));
  const recommendation = stopHit ? 'EXIT' : targetHit(targets[2]) ? 'BOOK PROFIT' : order.pnlPercent > 1 ? 'TRAIL STOP' : recovery >= 75 ? 'HOLD' : recovery >= 55 ? 'WATCH' : 'REDUCE RISK';
  const enteredAt = order.entryTime ? new Date(order.entryTime) : null;
  const durationSeconds = enteredAt ? Math.max(0, Math.floor((now - enteredAt.getTime()) / 1_000)) : 0;
  const duration = `${String(Math.floor(durationSeconds / 3600)).padStart(2, '0')}:${String(Math.floor(durationSeconds % 3600 / 60)).padStart(2, '0')}:${String(durationSeconds % 60).padStart(2, '0')}`;
  const positive = order.pnl >= 0;
  return <article className={`relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-[#111a2b] to-[#090e19] p-5 shadow-xl transition-all duration-300 ${positive ? 'border-l-4 border-l-emerald-400 shadow-emerald-950/20' : 'border-l-4 border-l-rose-400 shadow-rose-950/20'} ${flash === 'up' ? 'ring-2 ring-emerald-400/50' : flash === 'down' ? 'ring-2 ring-rose-400/50' : ''}`}>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex flex-wrap items-center gap-2"><h4 className="text-xl font-black text-white">{scanner?.company ?? signal?.stockName ?? order.symbol}</h4><span className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${buy ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-rose-400/30 bg-rose-400/10 text-rose-300'}`}>{order.side}</span><span className="rounded-full border border-sky-400/30 bg-sky-400/10 px-2.5 py-1 text-[10px] font-black text-sky-300">RUNNING</span></div><p className="mt-2 text-xs text-slate-500">{order.symbol} · Confidence <span className="font-black text-cyan-300">{order.confidence}%</span></p></div><div className="text-right"><p className="text-[10px] font-bold uppercase text-slate-500">Current Market Price · Live</p><p className="text-2xl font-black text-white">{money(order.currentPrice)}</p></div></div>
    <div className="mt-4 grid gap-2 sm:grid-cols-2"><div className="rounded-lg border border-sky-400/20 bg-sky-400/[.06] p-3"><p className="metric-label">Entry Triggered</p><p className="mt-1 font-mono text-sm font-black text-sky-300">{time(signal?.entryTriggeredAt)}</p></div><div className="rounded-lg border border-emerald-400/20 bg-emerald-400/[.06] p-3"><p className="metric-label">Auto {order.side} Executed</p><p className="mt-1 font-mono text-sm font-black text-emerald-300">{time(order.entryTime)}</p></div></div>
    <div className="mt-5 grid grid-cols-2 gap-x-4 gap-y-4 rounded-xl border border-slate-800 bg-slate-950/35 p-4 text-xs sm:grid-cols-4">{[['Entry Price', money(entry)], ['Current Price', money(order.currentPrice)], ['Quantity', String(order.quantity)], ['Investment', money(order.investment)], ['Current Value', money(currentValue)], ['Current P&L', `${order.pnl >= 0 ? '+' : ''}${money(order.pnl)}`], ['Current P&L %', `${order.pnlPercent >= 0 ? '+' : ''}${order.pnlPercent.toFixed(2)}%`], ["Today's P&L", `${order.pnl >= 0 ? '+' : ''}${money(order.pnl)}`]].map(([title, value]) => <Metric key={title} title={title} value={value} tone={title.includes('P&L') ? positive ? 'text-emerald-300' : 'text-rose-300' : 'text-slate-100'} />)}</div>
    <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">{[['Target 1', targets[0]], ['Target 2', targets[1]], ['Target 3', targets[2]], ['Stop Loss', order.stopLoss]].map(([title, value]) => { const hit = title === 'Stop Loss' ? stopHit : targetHit(Number(value)); return <div key={String(title)} className={`rounded-lg border p-3 ${title === 'Stop Loss' ? hit ? 'border-rose-300 bg-rose-400/20 ring-1 ring-rose-400/40' : 'border-rose-400/20 bg-rose-400/5' : hit ? 'border-emerald-300 bg-emerald-400/20 ring-1 ring-emerald-400/40' : 'border-emerald-400/15 bg-emerald-400/5'}`}><p className="text-[9px] font-bold uppercase tracking-wider text-slate-500">{title}</p><p className={`mt-1 font-black ${title === 'Stop Loss' ? 'text-rose-300' : 'text-emerald-300'}`}>{money(Number(value))}</p>{hit && <p className={`mt-1 text-[9px] font-black ${title === 'Stop Loss' ? 'text-rose-200' : 'text-emerald-200'}`}>REACHED</p>}</div>; })}</div>
    <div className="mt-5"><div className="relative h-2 rounded-full bg-slate-800"><div className={`h-full rounded-full transition-all duration-700 ${positive ? 'bg-emerald-400' : 'bg-rose-400'}`} style={{ width: `${progress}%` }} /><span className="absolute top-1/2 h-4 w-1 -translate-y-1/2 rounded bg-white shadow" style={{ left: `${progress}%` }} /></div><div className="mt-2 flex justify-between text-[9px] font-bold uppercase text-slate-600"><span>Entry</span><span>Target 1</span><span>Target 2</span><span>Target 3</span></div></div>
    <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4"><div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="metric-label">Recovery Probability</p><p className="mt-1 text-lg font-black text-cyan-300">{recovery}%</p></div><DemoRiskMeter level={riskLevel} /><div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="metric-label">AI Recommendation</p><p className={`mt-1 text-lg font-black ${recommendation === 'EXIT' ? 'text-rose-300' : recommendation === 'HOLD' ? 'text-emerald-300' : 'text-amber-300'}`}>{recommendation}</p></div><div className="rounded-xl border border-slate-800 bg-slate-950/40 p-3"><p className="metric-label">Trade Duration</p><p className="mt-1 font-mono text-lg font-black text-white">{duration}</p><p className="mt-1 text-[10px] text-slate-500">Entered {time(order.entryTime)}</p></div></div>
    <div className="mt-5 flex gap-3"><Link href={`/analysis/${encodeURIComponent(order.instrumentKey)}`} className="grid min-h-11 flex-1 place-items-center rounded-lg border border-sky-400/30 bg-sky-400/10 px-4 text-sm font-bold text-sky-300">View Details</Link><button onClick={() => void onExit(order.id)} className="min-h-11 flex-1 rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 text-sm font-bold text-rose-300">Manual Exit</button></div>
  </article>;
}

function CompletedDemoTradeCard({ order, signal }: { order: DemoOrder; signal?: AiSignal }) {
  const positive = order.pnl >= 0;
  return <article className={`rounded-2xl border border-slate-800 bg-gradient-to-br from-[#111a2b] to-[#090e19] p-5 ${positive ? 'border-l-4 border-l-emerald-400' : 'border-l-4 border-l-rose-400'}`}><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><h4 className="text-lg font-black text-white">{signal?.stockName ?? order.symbol}</h4><span className={`rounded-full border px-2.5 py-1 text-[10px] font-black ${order.side === 'BUY' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-rose-400/30 bg-rose-400/10 text-rose-300'}`}>{order.side}</span><span className="rounded-full border border-slate-600 bg-slate-800 px-2.5 py-1 text-[10px] font-black text-slate-300">COMPLETED</span></div><p className="mt-2 text-xs text-slate-500">{order.symbol}</p></div><p className={`text-xl font-black ${positive ? 'text-emerald-300' : 'text-rose-300'}`}>{order.pnl >= 0 ? '+' : ''}{money(order.pnl)}</p></div><div className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-slate-800 bg-slate-950/35 p-4 sm:grid-cols-4"><Metric title="Exit Price" value={money(Number(order.exitPrice ?? order.currentPrice))} /><Metric title="Exit Time" value={time(order.exitTime)} /><Metric title="Exit Reason" value={order.exitReason ?? 'Completed'} tone={/STOP|LOSS/i.test(order.exitReason ?? '') ? 'text-rose-300' : 'text-emerald-300'} /><Metric title="Final Profit / Loss" value={`${order.pnl >= 0 ? '+' : ''}${money(order.pnl)} (${order.pnlPercent >= 0 ? '+' : ''}${order.pnlPercent.toFixed(2)}%)`} tone={positive ? 'text-emerald-300' : 'text-rose-300'} /><Metric title="Holding Time" value={`${order.durationMinutes ?? 0} min`} /><Metric title="Entry Triggered" value={time(signal?.entryTriggeredAt)} /><Metric title={`Auto ${order.side} Executed`} value={time(order.entryTime)} /><Metric title="Capital Released" value={money(order.investment + order.pnl)} tone="text-cyan-300" /></div><Link href={`/analysis/${encodeURIComponent(order.instrumentKey)}`} className="mt-4 grid min-h-11 place-items-center rounded-lg border border-sky-400/30 bg-sky-400/10 text-sm font-bold text-sky-300">View Details</Link></article>;
}

function DemoTrading({ session, signals }: { session: string; signals: AiSignal[] }) {
  const client = useQueryClient();
  const latestTickAt = useRef(new Map<string, number>());
  const paper = useQuery({ queryKey: ['signal-history-demo'], queryFn: () => signalHistoryDemoService.dashboard<DemoDashboard>(), enabled: Boolean(session), retry: 2, refetchInterval: 5_000, refetchIntervalInBackground: true, refetchOnMount: 'always', refetchOnWindowFocus: true });
  useEffect(() => {
    if (!session) return;
    const socket = io(base, { auth: { token: token() }, reconnection: true });
    socket.on('connect', () => console.info('[demo-live] connected', { socketId: socket.id, at: new Date().toISOString() }));
    socket.on('disconnect', (reason) => console.warn('[demo-live] disconnected', { reason, at: new Date().toISOString() }));
    socket.on('connect_error', (error) => console.error('[demo-live] connection error', { message: error.message, at: new Date().toISOString() }));
    socket.on('market-price-updated', (tick: { instrumentKey: string; ltp: number; timestamp: number }) => {
      const timestamp = Number(tick.timestamp) || Date.now();
      const previousTimestamp = latestTickAt.current.get(tick.instrumentKey) ?? 0;
      if (!Number.isFinite(tick.ltp) || timestamp < previousTimestamp) {
        console.warn('[demo-live] ignored invalid/out-of-order tick', { ...tick, previousTimestamp });
        return;
      }
      latestTickAt.current.set(tick.instrumentKey, timestamp);
      console.info('[demo-live] price updated', { instrumentKey: tick.instrumentKey, ltp: tick.ltp, marketTime: new Date(timestamp).toISOString(), receivedAt: new Date().toISOString() });
      client.setQueryData<DemoDashboard>(['signal-history-demo'], (current) => {
        if (!current) return current;
        const update = (order: DemoOrder) => {
          if (order.instrumentKey !== tick.instrumentKey) return order;
          const entry = Number(order.entryPrice ?? order.plannedEntry);
          const pnl = order.status === 'OPEN' ? (order.side === 'BUY' ? tick.ltp - entry : entry - tick.ltp) * order.quantity : order.pnl;
          const pnlPercent = entry && order.quantity ? pnl / (entry * order.quantity) * 100 : 0;
          return { ...order, currentPrice: tick.ltp, pnl, pnlPercent, lastMarketUpdate: new Date(timestamp).toISOString() };
        };
        const openPositions = current.openPositions.map(update);
        const waitingOrders = current.waitingOrders.map(update);
        const usedCapital = openPositions.reduce((total, order) => total + order.budget, 0);
        const unrealized = openPositions.reduce((total, order) => total + order.pnl, 0);
        return { ...current, openPositions, waitingOrders, summary: { ...current.summary, usedCapital, availableCapital: current.summary.virtualBalance - usedCapital, todayPnl: current.performance.todayProfit - current.performance.todayLoss + unrealized } };
      });
    });
    socket.on('paper-trading-updated', (event) => {
      console.info('[demo-live] target/position state changed; refreshing dashboard', event);
      void client.invalidateQueries({ queryKey: ['signal-history-demo'] });
    });
    return () => { socket.close(); };
  }, [client, session]);
  const exitTrade = async (id: string) => {
    await signalHistoryDemoService.exitTrade(id);
    await client.invalidateQueries({ queryKey: ['signal-history-demo'] });
  };
  const data = paper.data;
  const capital = data?.account.startingBalance ?? 10_000;
  const running = (data?.openPositions.length ?? 0) + (data?.waitingOrders.length ?? 0);
  const roi = data && capital ? data.summary.todayPnl / capital * 100 : 0;
  const capitalPerTrade = data?.summary.availableCapital ?? capital;
  const metrics = [
    ['Demo Balance', money(data?.summary.virtualBalance ?? capital), 'text-white'],
    ['Used Capital', money(data?.summary.usedCapital ?? 0), 'text-sky-300'],
    ['Available Capital', money(data?.summary.availableCapital ?? capital), 'text-emerald-300'],
    ['Capital Per Trade', money(capitalPerTrade), 'text-cyan-300'],
    ["Today's Profit", money(data?.performance.todayProfit ?? 0), 'text-emerald-300'],
    ["Today's Loss", money(data?.performance.todayLoss ?? 0), 'text-rose-300'],
    ['Net Profit', money(data?.summary.todayPnl ?? 0), Number(data?.summary.todayPnl ?? 0) >= 0 ? 'text-emerald-300' : 'text-rose-300'],
    ['ROI', `${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`, roi >= 0 ? 'text-emerald-300' : 'text-rose-300'],
    ['Winning Trades', String(data?.performance.winningTrades ?? 0), 'text-emerald-300'],
    ['Losing Trades', String(data?.performance.losingTrades ?? 0), 'text-rose-300'],
    ['Running Trades', String(running), 'text-amber-300'],
    ['Completed Trades', String(data?.summary.closedTrades ?? 0), 'text-violet-300'],
  ];
  if (!session) return <div className="glass-card p-5 text-sm text-amber-200">Connect Upstox to start Demo Trading.</div>;
  if (paper.isLoading) return <div className="glass-card grid min-h-64 place-items-center"><div className="text-center"><Activity className="mx-auto h-7 w-7 animate-pulse text-cyan-300" /><p className="mt-3 text-sm text-slate-400">Loading persisted demo trades and live prices…</p></div></div>;
  if (paper.isError) return <div className="glass-card border-rose-400/25 p-5 text-sm text-rose-200"><p className="font-black">Demo Trading data could not be loaded.</p><p className="mt-2 text-rose-200/70">{paper.error.message}</p><button onClick={() => void paper.refetch()} className="mt-4 rounded-lg border border-rose-300/30 bg-rose-400/10 px-4 py-2 font-bold">Retry</button></div>;
  return <section className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="section-eyebrow">AUTOMATED PAPER EXECUTION</p><h1 className="text-3xl font-bold text-white">Demo Trading</h1><p className="mt-2 text-sm text-slate-400">A simulated intraday BUY/SELL is placed only on a fresh Target 1 hit while capital is free. No real orders are placed.</p></div><div className="flex items-center gap-3 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-3 text-sm font-black text-emerald-300"><span className="relative h-5 w-9 rounded-full bg-emerald-400"><span className="absolute left-[18px] top-0.5 h-4 w-4 rounded-full bg-white" /></span>Auto Demo Trading · ON</div></div>
    <div className="glass-card flex flex-wrap gap-4 p-5"><label className="min-w-44"><span className="metric-label">Demo Capital</span><select value={10_000} disabled className={`${selectClass} mt-2 w-full`}><option value={10_000}>{money(10_000)}</option></select></label><label className="min-w-44"><span className="metric-label">Maximum Open Trades</span><select value={1} disabled className={`${selectClass} mt-2 w-full`}><option value={1}>1</option></select></label><div className="min-w-44 rounded-xl border border-cyan-400/20 bg-cyan-400/[.06] px-4 py-3"><p className="metric-label">Intraday Margin Allocation</p><p className="mt-2 text-lg font-black text-cyan-300">{money(capitalPerTrade)}</p><p className="text-[10px] text-slate-500">one active trade</p></div></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">{metrics.map(([title, value, tone]) => <Summary key={title} label={title} value={value} tone={tone} />)}</div>
    <div className="grid gap-5 xl:grid-cols-2"><div className="glass-card p-5"><div className="flex items-center gap-3"><Bot className="h-5 w-5 text-cyan-300" /><div><h2 className="font-black text-white">Fresh Target 1 Monitor</h2><p className="text-xs text-slate-500">Signal Generated → Entry Triggered → Running → Target 1 Hit → Auto BUY / SELL</p></div></div><div className="mt-4 rounded-lg border border-cyan-400/15 bg-cyan-400/[.05] p-4 text-sm text-slate-300"><span className="live-dot mr-2" />{running ? 'One trade is active. Other Target 1 hits are skipped, not queued.' : 'Capital is free. The next fresh Target 1 hit can execute immediately.'}</div></div><div className="glass-card p-5"><div className="flex items-center gap-2"><WalletCards className="h-5 w-5 text-violet-300" /><h2 className="font-black text-white">Full Margin Allocation</h2></div><p className="mt-4 text-sm leading-6 text-slate-400">The single trade uses all available demo capital as intraday margin. After it closes, capital is released; only a Target 1 hit occurring after that time can open the next trade.</p></div></div>
    <section><div className="mb-3 flex items-center justify-between"><div><p className="section-eyebrow">LIVE DEMO POSITIONS</p><h2 className="text-xl font-black text-white">Running Demo Trades</h2></div><span className="text-xs text-slate-500">{data?.openPositions.length ?? 0} running</span></div><div className="grid gap-4 xl:grid-cols-2">{data?.openPositions.map((order) => <LiveDemoPositionCard key={order.id} order={order} signal={signals.find((item) => item.id === order.signalId) ?? signals.find((item) => item.instrumentKey === order.instrumentKey)} onExit={exitTrade} />)}</div>{!data?.openPositions.length && <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 py-12 text-center text-sm text-slate-500">No running demo trade. The backend is monitoring signals even while this page is closed.</div>}</section>
    <section><div className="mb-3 flex items-center justify-between"><div><p className="section-eyebrow">CLOSED DEMO POSITIONS</p><h2 className="text-xl font-black text-white">Completed Demo Trades</h2></div><span className="text-xs text-slate-500">{data?.tradeHistory.length ?? 0} completed</span></div><div className="grid gap-4 xl:grid-cols-2">{data?.tradeHistory.map((order) => <CompletedDemoTradeCard key={order.id} order={order} signal={signals.find((item) => item.id === order.signalId) ?? signals.find((item) => item.instrumentKey === order.instrumentKey)} />)}</div>{!data?.tradeHistory.length && <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 py-10 text-center text-sm text-slate-500">No completed demo trades for this account yet.</div>}</section>
  </section>;
}

export function AiSignalHistory({ session }: { session: string }) {
  const client = useQueryClient(); const [activeTab, setActiveTab] = useState<'history' | 'demo'>('history'); const [side, setSide] = useState('ALL'); const [strategy, setStrategy] = useState('ALL'); const [timeframe, setTimeframe] = useState('ALL'); const [tradeStatus, setTradeStatus] = useState('ALL');
  const query = useQuery({ queryKey: ['ai-signal-history'], queryFn: () => api<Response>('/signal-history'), enabled: Boolean(session), retry: false, refetchInterval: 15_000 });
  const filteredQuery = useQuery({ queryKey: ['ai-signal-history', 'status', tradeStatus], queryFn: () => api<Response>(`/signal-history?status=${encodeURIComponent(tradeStatus)}`), enabled: Boolean(session && tradeStatus !== 'ALL'), retry: false, refetchInterval: 15_000 });
  const statisticStatuses = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'STOPLOSS_HIT', 'COMPLETED'] as const;
  const statisticQueries = useQueries({ queries: statisticStatuses.map((status) => ({ queryKey: ['ai-signal-history', 'status-count', status], queryFn: () => api<Response>(`/signal-history?status=${encodeURIComponent(status)}`), enabled: Boolean(session), retry: false, refetchInterval: 15_000 })) });
  const create = useMutation({ mutationFn: (id: string) => api<AiSignal>(`/signal-history/${encodeURIComponent(id)}/generate`, { method: 'POST' }), onSuccess: () => void client.invalidateQueries({ queryKey: ['ai-signal-history'] }) });
  useEffect(() => { if (!session) return; const socket = io(base, { auth: { token: token() }, reconnection: true }); socket.on('signal-history-updated', () => void client.invalidateQueries({ queryKey: ['ai-signal-history'] })); socket.on('market-price-updated', (tick: { instrumentKey: string; ltp: number; timestamp: number }) => client.setQueriesData<Response>({ queryKey: ['ai-signal-history'] }, (data) => data ? { ...data, signals: data.signals.map((signal) => signal.instrumentKey === tick.instrumentKey ? { ...signal, currentPrice: tick.ltp, updatedAt: new Date(tick.timestamp).toISOString() } : signal) } : data)); return () => { socket.close(); }; }, [client, session]);
  const statusSignals = tradeStatus === 'ALL' ? query.data?.signals : filteredQuery.data?.signals;
  const groups = useMemo(() => { const result = new Map<string, AiSignal[]>(); for (const signal of statusSignals ?? []) { if (!isCurrentTradingDay(signal.signalTime)) continue; const key = `${signal.instrumentKey}:${signal.timeframe}:${signal.strategy}`; result.set(key, [...(result.get(key) ?? []), signal]); } return [...result.values()].map((trades) => { const ordered = trades.sort((a, b) => new Date(b.signalTime).getTime() - new Date(a.signalTime).getTime()); const current = ordered.find((trade) => ACTIVE.includes(trade.status)) ?? ordered[0]; return { current, history: ordered.filter((trade) => trade.id !== current.id) }; }).filter(({ current }) => current.currentPrice >= 60 && current.currentPrice <= 600 && (side === 'ALL' || current.side === side) && (strategy === 'ALL' || current.strategy === strategy) && (timeframe === 'ALL' || current.timeframe === timeframe)).sort((a, b) => {
    const aTarget1At = a.current.target1At ? new Date(a.current.target1At).getTime() : 0;
    const bTarget1At = b.current.target1At ? new Date(b.current.target1At).getTime() : 0;
    return bTarget1At - aTarget1At || b.current.aiScore - a.current.aiScore || b.current.confidence - a.current.confidence || b.current.volume - a.current.volume || new Date(b.current.signalTime).getTime() - new Date(a.current.signalTime).getTime();
  }); }, [statusSignals, side, strategy, timeframe]);
  const summary = query.data?.summary;
  const todayStats = Object.fromEntries(statisticStatuses.map((status, index) => [status, statisticQueries[index].data?.summary.todaySignals ?? 0])) as Record<(typeof statisticStatuses)[number], number>;
  return <div><nav className="mb-6 flex gap-2 border-b border-slate-800 pb-3">{([['history', 'Signal History'], ['demo', 'Demo Trading']] as const).map(([key, title]) => <button key={key} onClick={() => setActiveTab(key)} className={`rounded-lg border px-4 py-2.5 text-sm font-black ${activeTab === key ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300' : 'border-slate-800 bg-slate-950/40 text-slate-500'}`}>{title}</button>)}</nav><div className={activeTab === 'history' ? 'block' : 'hidden'}><div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="section-eyebrow">AUTOMATED INTRADAY JOURNAL</p><h1 className="text-3xl font-bold text-white">Intraday Signal History</h1><p className="mt-2 text-sm text-slate-400">One evolving card per active stock, timeframe, and strategy.</p></div><div className="flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[.07] px-3 py-2 text-xs font-bold text-emerald-300"><span className="live-dot" /><Radio className="h-3.5 w-3.5" />LIVE TRACKING</div></div><section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8"><Summary label="Today's Signals" value={summary?.todaySignals ?? '—'} /><Summary label="Winning Trades" value={summary?.winningTrades ?? '—'} tone="text-emerald-300" /><Summary label="Losing Trades" value={summary?.losingTrades ?? '—'} tone="text-rose-300" /><Summary label="Win Rate" value={summary ? `${summary.winRate.toFixed(1)}%` : '—'} /><Summary label="Average Profit" value={summary ? `${summary.averageProfit.toFixed(2)}%` : '—'} tone="text-emerald-300" /><Summary label="Average Loss" value={summary ? `${summary.averageLoss.toFixed(2)}%` : '—'} tone="text-rose-300" /><Summary label="Best Trade" value={summary?.bestTrade ? `${summary.bestTrade.symbol} +${Number(summary.bestTrade.profitPercent).toFixed(2)}%` : '—'} tone="text-emerald-300" /><Summary label="Worst Trade" value={summary?.worstTrade ? `${summary.worstTrade.symbol} ${Number(summary.worstTrade.profitPercent).toFixed(2)}%` : '—'} tone="text-rose-300" /><Summary label="Waiting" value={todayStats.WAITING} /><Summary label="Entry Triggered" value={todayStats.ENTRY_TRIGGERED} /><Summary label="Running" value={todayStats.RUNNING} /><Summary label="Target 1 Hit" value={todayStats.TARGET1_HIT} tone="text-emerald-300" /><Summary label="Target 2 Hit" value={todayStats.TARGET2_HIT} tone="text-emerald-300" /><Summary label="Target 3 Hit" value={todayStats.TARGET3_HIT} tone="text-emerald-300" /><Summary label="Stop Loss Hit" value={todayStats.STOPLOSS_HIT} tone="text-rose-300" /><Summary label="Completed" value={todayStats.COMPLETED} /></section><section className="glass-card mt-5 flex flex-wrap gap-3 p-4"><label className="flex min-w-32 flex-col gap-1.5"><span className="metric-label">Price</span><select className={selectClass} value="₹60–₹600" disabled><option>₹60–₹600</option></select></label><Filter title="Signal" value={side} values={['ALL', 'BUY', 'SELL']} onChange={setSide} /><Filter title="Strategy" value={strategy} values={['ALL', 'Breakout', 'Momentum', 'VWAP', 'ORB', 'Pullback']} onChange={setStrategy} /><Filter title="Timeframe" value={timeframe} values={['ALL', '1m', '3m', '5m', '15m', '30m']} onChange={setTimeframe} /><Filter title="Status" value={tradeStatus} values={['ALL', 'WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'COMPLETED', 'STOPLOSS_HIT']} onChange={setTradeStatus} /></section>{!session && <div className="glass-card mt-5 p-5 text-amber-200">Connect Upstox to track scanner signals.</div>}{query.isLoading && <div className="glass-card mt-5 grid min-h-64 place-items-center"><Activity className="h-6 w-6 animate-pulse text-cyan-300" /></div>}{query.isError && <div className="glass-card mt-5 border-rose-400/20 p-5 text-sm text-rose-200">{query.error.message}</div>}{create.isError && <div className="glass-card mt-5 border-amber-400/20 p-4 text-sm text-amber-200">{create.error.message}</div>}{query.data && <section className="mt-5 space-y-3">{groups.map(({ current, history }) => <TradeCard key={`${current.instrumentKey}:${current.timeframe}:${current.strategy}`} signal={current} history={history} generate={(id) => create.mutate(id)} />)}{!groups.length && <div className="glass-card grid min-h-56 place-items-center text-center"><div><Clock3 className="mx-auto h-7 w-7 text-slate-500" /><p className="mt-3 text-sm text-slate-400">No trading signals generated for today's market yet.</p></div></div>}</section>}</div>{activeTab === 'demo' && <DemoTrading session={session} signals={query.data?.signals ?? []} />}</div>;
}
