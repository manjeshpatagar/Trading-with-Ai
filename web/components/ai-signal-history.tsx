'use client';

import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Activity, Bot, Check, ChevronDown, Clock3, Radio, TrendingDown, TrendingUp, WalletCards, X } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { api, base, token, upstoxLoginUrl } from '../lib/api';
import { paperTradingService, realTradingService } from '../lib/trading-services';

type TradeEvent = { id: string; type: string; triggerPrice: number; executedPrice: number; eventTime: string; profitPercent: number; holdingMinutes: number };
export type AiSignal = { id: string; signalTime: string; updatedAt: string; instrumentKey: string; stockName: string; symbol: string; sector: string; strategy: string; timeframe: string; currentPrice: number; entryPrice: number; stopLoss: number; target1: number; target2: number; target3: number; side: 'BUY' | 'SELL'; confidence: number; aiScore: number; riskReward: number; volume: number; status: string; events: TradeEvent[]; entryTriggeredAt?: string | null; runningAt?: string | null; target1At?: string | null; target2At?: string | null; target3At?: string | null; stopLossAt?: string | null; completedAt?: string | null; profitPercent?: number | null; holdingMinutes?: number | null };
type AnalyticsMetric = { key: string; label: string; count: number; signalIds: string[] };
type AnalyticsSection = { key: string; title: string; count: number; signalIds: string[]; metrics: AnalyticsMetric[] };
type QualityBadge = { key: string; label: string; stars: number; tone: string };
type ConversionMetric = { key: string; label: string; numerator: number; denominator: number; percentage: number; rating: string; stars: number; tone: string };
type HealthMetric = { key: string; label: string; value: number; suffix: string; rating: string; stars: number; tone: string };
type Response = { signals: AiSignal[]; summary: { todaySignals: number; winningTrades: number; losingTrades: number; winRate: number; averageProfit: number; averageLoss: number; bestTrade: AiSignal | null; worstTrade: AiSignal | null }; analytics: { generatedAt: string; compactFlow: AnalyticsMetric[]; conversions: ConversionMetric[]; qualities: Array<AnalyticsMetric & QualityBadge>; qualityBySignal: Record<string, QualityBadge>; health: HealthMetric[]; sections: AnalyticsSection[] } };
const ACTIVE = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT'];
const rank: Record<string, number> = { WAITING: 0, ENTRY_TRIGGERED: 1, RUNNING: 2, TARGET1_HIT: 3, TARGET2_HIT: 4, TARGET3_HIT: 5, COMPLETED: 6, STOPLOSS_HIT: -1 };
const money = (amount: number) => `₹${Number(amount).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const time = (value?: string | null) => value ? new Date(value).toLocaleTimeString('en-IN') : '—';
const isCurrentTradingDay = (value: string) => new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) === new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const label = (value: string) => ({ TARGET1_HIT: 'Target 1 Hit', TARGET2_HIT: 'Target 2 Hit', TARGET3_HIT: 'Target 3 Hit', STOPLOSS_HIT: 'Stop Loss Hit', COMPLETED: 'Trade Completed' }[value] ?? value.split('_').map((word) => word[0] + word.slice(1).toLowerCase()).join(' '));
const qualityTone = (tone: string) => tone === 'emerald' ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : tone === 'blue' ? 'border-sky-400/30 bg-sky-400/10 text-sky-300' : tone === 'amber' ? 'border-amber-400/30 bg-amber-400/10 text-amber-300' : 'border-rose-400/30 bg-rose-400/10 text-rose-300';
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

function TradeCard({ signal, history, generate, quality }: { signal: AiSignal; history: AiSignal[]; generate: (id: string) => void; quality?: QualityBadge }) {
  const buy = signal.side === 'BUY'; const sideTone = buy ? 'text-emerald-300' : 'text-rose-300'; const terminal = signal.status === 'COMPLETED' || signal.status === 'STOPLOSS_HIT';
  const statusTone = signal.status === 'WAITING' ? 'bg-slate-700 text-slate-300' : signal.status === 'ENTRY_TRIGGERED' ? 'bg-sky-400/10 text-sky-300' : signal.status === 'RUNNING' ? 'bg-amber-400/10 text-amber-300' : signal.status === 'STOPLOSS_HIT' ? 'bg-rose-400/10 text-rose-300' : signal.status === 'COMPLETED' ? 'bg-emerald-700/30 text-emerald-200' : 'bg-emerald-400/10 text-emerald-300';
  return <article className="glass-card p-4"><Link href={`/analysis/${encodeURIComponent(signal.instrumentKey)}?signal=${encodeURIComponent(signal.id)}`} className="block"><div className="flex flex-wrap items-start justify-between gap-3"><div className="flex items-center gap-3"><div className={`grid h-10 w-10 place-items-center rounded-xl ${buy ? 'bg-emerald-400/10 text-emerald-300' : 'bg-rose-400/10 text-rose-300'}`}>{buy ? <TrendingUp className="h-5 w-5" /> : <TrendingDown className="h-5 w-5" />}</div><div><p className="font-bold text-white">{signal.stockName}</p><p className="mt-1 text-xs text-slate-500">{signal.symbol} · {signal.strategy} · {signal.timeframe}</p></div></div><div className="text-right">{quality && <span className={`mr-2 inline-block rounded-full border px-2.5 py-1 text-[10px] font-black ${qualityTone(quality.tone)}`}>{'★'.repeat(quality.stars)} {quality.label.toUpperCase()}</span>}<span className={`inline-block rounded-full px-2.5 py-1 text-[10px] font-black ${buy ? 'bg-emerald-400/10 text-emerald-300' : 'bg-rose-400/10 text-rose-300'}`}>{signal.side}</span><span className={`ml-2 inline-block rounded-full px-2.5 py-1 text-[10px] font-bold ${statusTone}`}>{label(signal.status)}</span></div></div><div className="mt-4 grid grid-cols-3 gap-3 border-t border-slate-700/70 pt-3 sm:grid-cols-6 lg:grid-cols-11"><Metric title="Current" value={money(signal.currentPrice)} /><Metric title="Last Update" value={time(signal.updatedAt)} /><Metric title={`${signal.side} Entry`} value={money(signal.entryPrice)} tone={signal.entryTriggeredAt ? sideTone : 'text-slate-300'} /><Metric title="Stop Loss" value={money(signal.stopLoss)} tone="text-rose-300" /><Metric title="Target 1" value={money(signal.target1)} tone={signal.target1At ? sideTone : 'text-slate-300'} /><Metric title="Target 2" value={money(signal.target2)} tone={signal.target2At ? sideTone : 'text-slate-300'} /><Metric title="Target 3" value={money(signal.target3)} tone={signal.target3At ? sideTone : 'text-slate-300'} /><Metric title="AI Score" value={`${signal.aiScore}/100`} /><Metric title="Confidence" value={`${signal.confidence}%`} /><Metric title="Risk Reward" value={`1 : ${signal.riskReward.toFixed(2)}`} /><Metric title="Holding" value={signal.holdingMinutes == null ? 'Running' : `${signal.holdingMinutes} min`} /></div><Progress signal={signal} /><EventTimeline events={signal.events ?? []} side={signal.side} /></Link>{terminal && <div className="mt-4 flex justify-end"><button className="primary-button" onClick={() => generate(signal.id)}>Scan for New Setup</button></div>}<TradeHistory trades={history} /></article>;
}

type DemoOrder = { id: string; instrumentKey: string; symbol: string; side: 'BUY' | 'SELL'; confidence: number; quantity: number; budget: number; investment: number; marketValue: number; pnl: number; pnlPercent: number; unrealizedPnl: number; unrealizedPnlPercent: number; status: string; tradeStage: string; plannedEntry: number; entryPrice?: number | null; currentPrice: number; target: number; target1?: number | null; target2?: number | null; stopLoss: number; createdAt: string; entryTime?: string | null; exitTime?: string | null; exitPrice?: number | null; exitReason?: string | null; durationMinutes?: number | null };
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
type ScannerDashboard = { topBuy: ScannerCandidate[]; topSell: ScannerCandidate[] };
const CAPITAL_OPTIONS = Array.from({ length: 10 }, (_, index) => (index + 1) * 5_000);
const DEMO_CAPITAL_PER_TRADE = 10_000;
const DEMO_AUTO_STORAGE_KEY = 'quantpulse.demoTrading.autoEnabled';
const DEMO_QUEUE_STORAGE_KEY = 'quantpulse.demoTrading.waitingQueue';
type QueuedDemoSignal = Pick<AiSignal, 'id' | 'instrumentKey' | 'symbol' | 'side' | 'entryPrice' | 'confidence' | 'aiScore' | 'signalTime' | 'strategy' | 'timeframe' | 'riskReward' | 'entryTriggeredAt'> & { queuedAt: string };

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
  const targets = [order.target1 ?? signal?.target1 ?? scanner?.target1, order.target2 ?? signal?.target2 ?? scanner?.target2, order.target ?? signal?.target3 ?? scanner?.target3].map(Number);
  const targetHit = (target: number) => buy ? order.currentPrice >= target : order.currentPrice <= target;
  const stopHit = buy ? order.currentPrice <= order.stopLoss : order.currentPrice >= order.stopLoss;
  const finalTarget = targets[2] || order.target;
  const progress = finalTarget === entry ? 0 : Math.min(100, Math.max(0, (order.currentPrice - entry) / (finalTarget - entry) * 100));
  const currentValue = order.marketValue || order.currentPrice * order.quantity;
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
  const restoredBackendPreference = useRef(false);
  const [autoEnabled, setAutoEnabled] = useState(true);
  const [preferenceLoaded, setPreferenceLoaded] = useState(false);
  const [waitingQueue, setWaitingQueue] = useState<QueuedDemoSignal[]>([]);
  const [capital, setCapital] = useState(10_000);
  const [maxTrades, setMaxTrades] = useState(5);
  const paper = useQuery({ queryKey: ['demo-paper-trading'], queryFn: () => paperTradingService.dashboard<DemoDashboard>(), enabled: Boolean(session), retry: false, refetchInterval: 10_000 });
  const scanner = useQuery({ queryKey: ['demo-scanner-validation'], queryFn: () => api<ScannerDashboard>('/dashboard'), enabled: Boolean(session), retry: false, refetchInterval: 15_000 });
  useEffect(() => {
    try {
      const savedPreference = window.localStorage.getItem(DEMO_AUTO_STORAGE_KEY);
      setAutoEnabled(savedPreference == null ? true : savedPreference === 'true');
      const savedQueue = JSON.parse(window.localStorage.getItem(DEMO_QUEUE_STORAGE_KEY) ?? '[]');
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
      if (Array.isArray(savedQueue)) {
        setWaitingQueue(savedQueue.filter((item) => item?.queuedAt && new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(item.queuedAt)) === today));
      }
    } catch {
      setWaitingQueue([]);
    } finally {
      setPreferenceLoaded(true);
    }
  }, []);
  useEffect(() => {
    if (!preferenceLoaded) return;
    window.localStorage.setItem(DEMO_AUTO_STORAGE_KEY, String(autoEnabled));
  }, [autoEnabled, preferenceLoaded]);
  useEffect(() => {
    if (!preferenceLoaded) return;
    window.localStorage.setItem(DEMO_QUEUE_STORAGE_KEY, JSON.stringify(waitingQueue));
  }, [preferenceLoaded, waitingQueue]);
  useEffect(() => {
    if (!session) return;
    const socket = io(base, { auth: { token: token() }, reconnection: true });
    socket.on('market-price-updated', (tick: { instrumentKey: string; ltp: number }) => {
      client.setQueryData<DemoDashboard>(['demo-paper-trading'], (current) => {
        if (!current) return current;
        const update = (order: DemoOrder) => {
          if (order.instrumentKey !== tick.instrumentKey) return order;
          const entry = Number(order.entryPrice ?? order.plannedEntry);
          const pnl = order.status === 'OPEN' ? (order.side === 'BUY' ? tick.ltp - entry : entry - tick.ltp) * order.quantity : order.pnl;
          const pnlPercent = entry && order.quantity ? pnl / (entry * order.quantity) * 100 : 0;
          return { ...order, currentPrice: tick.ltp, marketValue: tick.ltp * order.quantity, pnl, pnlPercent, unrealizedPnl: pnl, unrealizedPnlPercent: pnlPercent };
        };
        const openPositions = current.openPositions.map(update);
        const waitingOrders = current.waitingOrders.map(update);
        const usedCapital = openPositions.reduce((total, order) => total + Number(order.investment || order.budget), 0);
        const unrealized = openPositions.reduce((total, order) => total + order.pnl, 0);
        return { ...current, openPositions, waitingOrders, summary: { ...current.summary, usedCapital, availableCapital: current.summary.virtualBalance - usedCapital, todayPnl: current.performance.todayProfit - current.performance.todayLoss + unrealized } };
      });
    });
    socket.on('paper-trading-updated', () => void client.invalidateQueries({ queryKey: ['demo-paper-trading'] }));
    return () => { socket.close(); };
  }, [client, session]);
  useEffect(() => {
    if (!paper.data) return;
    setCapital(CAPITAL_OPTIONS.includes(paper.data.account.startingBalance) ? paper.data.account.startingBalance : 10_000);
    setMaxTrades(paper.data.account.maxOpenTrades === 0 ? 0 : Math.min(5, Math.max(1, paper.data.account.maxOpenTrades)));
  }, [paper.data?.account.startingBalance, paper.data?.account.maxOpenTrades]);
  const updateSettings = async (nextCapital: number, nextMaxTrades: number, enabled = autoEnabled) => {
    await paperTradingService.updateSettings({ startingBalance: nextCapital, maxOpenTrades: nextMaxTrades, minimumConfidence: 95, enabled: true, autoDemoTrading: enabled });
    await client.invalidateQueries({ queryKey: ['demo-paper-trading'] });
    await client.invalidateQueries({ queryKey: ['paper-trading'] });
  };
  useEffect(() => {
    if (!preferenceLoaded || !paper.data || restoredBackendPreference.current) return;
    restoredBackendPreference.current = true;
    if (typeof paper.data.account.autoDemoTrading === 'boolean') setAutoEnabled(paper.data.account.autoDemoTrading);
    else void updateSettings(capital, maxTrades, autoEnabled);
  }, [autoEnabled, capital, maxTrades, paper.data, preferenceLoaded]);
  const setDemoCapital = (value: number) => { setCapital(value); void updateSettings(value, maxTrades); };
  const setTradeLimit = (value: number) => { setMaxTrades(value); void updateSettings(capital, value); };
  const toggleAuto = () => {
    const next = !autoEnabled;
    setAutoEnabled(next);
    void updateSettings(capital, maxTrades, next);
  };
  const exitTrade = async (id: string) => {
    await paperTradingService.exitTrade(id);
    await client.invalidateQueries({ queryKey: ['demo-paper-trading'] });
  };
  const candidates = [...(scanner.data?.topBuy ?? []), ...(scanner.data?.topSell ?? [])];
  const activeKeys = new Set([...(paper.data?.openPositions ?? []), ...(paper.data?.waitingOrders ?? []), ...(paper.data?.tradeHistory ?? [])].map((order) => order.instrumentKey));
  const validateSignal = (signal: Pick<AiSignal, 'id' | 'instrumentKey' | 'side' | 'entryPrice' | 'confidence' | 'riskReward' | 'status' | 'entryTriggeredAt'>) => {
    if (signal.status !== 'ENTRY_TRIGGERED' || !signal.entryTriggeredAt || signal.confidence < 95 || signal.riskReward < 3 || activeKeys.has(signal.instrumentKey)) return false;
    const row = candidates.find((candidate) => candidate.instrumentKey === signal.instrumentKey);
    if (!row || row.confidence < 95 || Number(row.riskReward ?? 0) < 3) return false;
    const checks = row.entryValidation ?? {};
    const indicators = row.indicators ?? {};
    const status = String(row.tradeStatus ?? '').toUpperCase();
    const macdConfirmed = signal.side === 'BUY' ? Number(indicators.macd ?? 0) > 0 : Number(indicators.macd ?? 0) < 0;
    const rsi = Number(indicators.rsi ?? 0);
    const rsiConfirmed = signal.side === 'BUY' ? rsi >= 55 && rsi <= 68 : rsi >= 32 && rsi <= 45;
    const entryAge = Date.now() - new Date(signal.entryTriggeredAt).getTime();
    const stopDistance = Math.abs(Number(signal.entryPrice) - Number(row.stopLoss ?? 0)) / Number(signal.entryPrice);
    const trendConfirmed = row.signal === signal.side;
    const overextended = checks.lateEntry || checks.fakeBreakout || /POOR|FAKE/.test(String(row.entryQuality ?? '').toUpperCase()) || Math.abs(Number(row.openingGapPercent ?? 0)) >= 8;
    const newsSpike = Boolean(indicators.newsSpike);
    return entryAge <= 45 * 60_000 && stopDistance >= .0015 && trendConfirmed && !overextended && !newsSpike && checks.volumeIncreased && checks.vwapConfirmed && checks.emaConfirmed && checks.breakoutConfirmed && macdConfirmed && rsiConfirmed && Number(indicators.adx ?? 0) > 25 && !/BLACKLIST|WATCH/.test(status);
  };
  const qualifiedSignals = signals.filter((signal) => validateSignal(signal));
  useEffect(() => {
    if (!preferenceLoaded) return;
    if (maxTrades === 0) {
      setWaitingQueue([]);
      return;
    }
    setWaitingQueue((current) => {
      const byId = new Map(current.map((item) => [item.id, item]));
      for (const signal of qualifiedSignals) {
        if (!activeKeys.has(signal.instrumentKey)) byId.set(signal.id, { id: signal.id, instrumentKey: signal.instrumentKey, symbol: signal.symbol, side: signal.side, entryPrice: signal.entryPrice, confidence: signal.confidence, aiScore: signal.aiScore, signalTime: signal.signalTime, strategy: signal.strategy, timeframe: signal.timeframe, riskReward: signal.riskReward, entryTriggeredAt: signal.entryTriggeredAt, queuedAt: byId.get(signal.id)?.queuedAt ?? new Date().toISOString() });
      }
      return [...byId.values()]
        .filter((item) => !activeKeys.has(item.instrumentKey))
        .sort((left, right) => right.confidence - left.confidence || right.aiScore - left.aiScore || right.riskReward - left.riskReward || new Date(right.signalTime).getTime() - new Date(left.signalTime).getTime());
    });
  }, [maxTrades, preferenceLoaded, qualifiedSignals.map((signal) => `${signal.id}:${signal.confidence}:${signal.aiScore}`).join('|'), [...activeKeys].join('|')]);
  const data = paper.data;
  const running = (data?.openPositions.length ?? 0) + (data?.waitingOrders.length ?? 0);
  const roi = data && capital ? data.summary.todayPnl / capital * 100 : 0;
  const capitalPerTrade = DEMO_CAPITAL_PER_TRADE;
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
  return <section className="space-y-5">
    <div className="flex flex-wrap items-end justify-between gap-4"><div><p className="section-eyebrow">AUTOMATED PAPER EXECUTION</p><h1 className="text-3xl font-bold text-white">Demo Trading</h1><p className="mt-2 text-sm text-slate-400">AI signals are simulated only after every entry confirmation passes. No real orders are placed.</p></div><button onClick={toggleAuto} className={`flex items-center gap-3 rounded-xl border px-4 py-3 text-sm font-black ${autoEnabled ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}><span className={`relative h-5 w-9 rounded-full ${autoEnabled ? 'bg-emerald-400' : 'bg-slate-700'}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${autoEnabled ? 'left-[18px]' : 'left-0.5'}`} /></span>Auto Demo Trading · {autoEnabled ? 'ON' : 'OFF'}</button></div>
    <div className="glass-card flex flex-wrap gap-4 p-5"><label className="min-w-44"><span className="metric-label">Demo Capital</span><select value={capital} onChange={(event) => setDemoCapital(Number(event.target.value))} className={`${selectClass} mt-2 w-full`}>{CAPITAL_OPTIONS.map((value) => <option key={value} value={value}>{money(value)}</option>)}</select></label><label className="min-w-44"><span className="metric-label">Maximum Open Trades</span><select value={maxTrades} onChange={(event) => setTradeLimit(Number(event.target.value))} className={`${selectClass} mt-2 w-full`}>{[1, 2, 3, 4, 5].map((value) => <option key={value}>{value}</option>)}<option value={0}>Unlimited Trades</option></select></label><div className="min-w-44 rounded-xl border border-cyan-400/20 bg-cyan-400/[.06] px-4 py-3"><p className="metric-label">Allocation</p><p className="mt-2 text-lg font-black text-cyan-300">{money(capitalPerTrade)}</p><p className="text-[10px] text-slate-500">per trade</p></div></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">{metrics.map(([title, value, tone]) => <Summary key={title} label={title} value={value} tone={tone} />)}</div>
    <div className="grid gap-5 xl:grid-cols-[1.2fr_.8fr]"><div className="glass-card p-5"><div className="flex items-center gap-3"><Bot className="h-5 w-5 text-cyan-300" /><div><h2 className="font-black text-white">Automatic Entry Monitor</h2><p className="text-xs text-slate-500">Signal Generated → Waiting → Entry Triggered → Auto {waitingQueue[0]?.side ?? 'BUY / SELL'}</p></div></div><div className="mt-4 rounded-lg border border-cyan-400/15 bg-cyan-400/[.05] p-4 text-sm text-slate-300"><span className="live-dot mr-2" />Monitoring all AI Signal History signals continuously, including while demo trades are running.</div></div><div className="glass-card p-5"><div className="flex items-center gap-2"><WalletCards className="h-5 w-5 text-violet-300" /><h2 className="font-black text-white">Capital Recovery</h2></div><p className="mt-4 text-sm leading-6 text-slate-400">Allocated capital is released immediately when a simulated trade closes. The highest-ranked queued signal is revalidated before the next automatic entry.</p></div></div>
    <section className="glass-card p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="section-eyebrow">RANKED ENTRY TRIGGERS</p><h2 className="text-xl font-black text-white">Waiting Signals</h2><p className="mt-1 text-xs text-slate-500">Sorted by confidence, AI score, risk/reward and signal recency.</p></div><span className="rounded-full border border-amber-400/20 bg-amber-400/[.07] px-3 py-1 text-xs font-black text-amber-300">Waiting Queue · {waitingQueue.length}</span></div><div className="mt-4 space-y-2">{waitingQueue.map((queued, index) => { const latest = signals.find((signal) => signal.id === queued.id); const slotsFull = running >= maxTrades; return <div key={queued.id} className="grid items-center gap-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3 text-xs sm:grid-cols-[32px_1.1fr_.7fr_.7fr_.8fr_.9fr_auto]"><span className="grid h-7 w-7 place-items-center rounded-full bg-slate-800 font-black text-slate-400">{index + 1}</span><div><p className="font-black text-white">{queued.symbol} <span className={queued.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}>{queued.side}</span></p><p className="mt-1 text-[10px] text-slate-500">{queued.strategy} · {queued.timeframe}</p></div><Metric title="Entry Price" value={money(queued.entryPrice)} /><Metric title="Confidence" value={`${latest?.confidence ?? queued.confidence}%`} tone="text-cyan-300" /><Metric title="AI Score" value={`${latest?.aiScore ?? queued.aiScore}/100`} /><Metric title="Queued Time" value={time(queued.queuedAt)} /><div className="text-right"><p className="font-black text-amber-300">{autoEnabled ? slotsFull ? 'Waiting for Capital' : 'Ready to Execute' : 'Auto Trading Off'}</p></div></div>; })}{!waitingQueue.length && <p className="py-10 text-center text-sm text-slate-500">No valid Entry Trigger is waiting.</p>}</div></section>
    <section><div className="mb-3 flex items-center justify-between"><div><p className="section-eyebrow">LIVE DEMO POSITIONS</p><h2 className="text-xl font-black text-white">Running Demo Trades</h2></div><span className="text-xs text-slate-500">{data?.openPositions.length ?? 0} running</span></div><div className="grid gap-4 xl:grid-cols-2">{data?.openPositions.map((order) => <LiveDemoPositionCard key={order.id} order={order} signal={signals.find((item) => item.instrumentKey === order.instrumentKey)} scanner={candidates.find((item) => item.instrumentKey === order.instrumentKey)} onExit={exitTrade} />)}</div>{!data?.openPositions.length && <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 py-12 text-center text-sm text-slate-500">No running demo trades. A card will appear after Entry Triggered and automatic execution.</div>}</section>
    <section><div className="mb-3 flex items-center justify-between"><div><p className="section-eyebrow">CLOSED DEMO POSITIONS</p><h2 className="text-xl font-black text-white">Completed Demo Trades</h2></div><span className="text-xs text-slate-500">{data?.tradeHistory.length ?? 0} completed</span></div><div className="grid gap-4 xl:grid-cols-2">{data?.tradeHistory.map((order) => <CompletedDemoTradeCard key={order.id} order={order} signal={signals.find((item) => item.instrumentKey === order.instrumentKey)} />)}</div>{!data?.tradeHistory.length && <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/30 py-10 text-center text-sm text-slate-500">Completed demo trades will move here automatically.</div>}</section>
  </section>;
}

type RealDashboard = {
  connected: boolean;
  broker: string;
  profile?: { userName?: string; userId?: string };
  funds: { available: number; margin: number };
  settings: { tradingCapital: number; maxOpenTrades: number; riskPerTrade: number; minimumConfidence: number; maxDailyLoss: number; maxDailyProfit: number; autoTrading: boolean; buySignals: boolean; sellSignals: boolean; squareOffTime: string };
  safety: { tokenValid: boolean; marketOpen: boolean; autoTradingEnabled: boolean; dailyLimitReached: boolean };
  todayPnl: number;
  statistics: { availableCapital: number; capitalPerTrade: number; usedCapital: number; netProfit: number; todayProfit: number; todayLoss: number; runningTrades: number; winningTrades: number; losingTrades: number; completedTrades: number; roi: number; winRate: number };
  connectionTime?: string | null;
  ledger: Array<{ id: string; signalId: string; brokerOrderId?: string | null; instrumentKey: string; symbol: string; side: string; status: string; entryPrice: number; currentPrice: number; quantity: number; investment: number; pnl: number; pnlPercent: number; target1: number; target2: number; target3: number; currentStop: number; executionTime?: string | null; exitPrice?: number | null; exitReason?: string | null; exitTime?: string | null }>;
  queue: Array<{ id: string; symbol: string; side: string; confidence: number; aiScore: number; entryPrice: number; status: string; displayStatus: string; reason?: string | null; validationLog: string; brokerResponse?: string | null; queuedAt: string }>;
  orders: Array<Record<string, unknown>>;
  trades: Array<Record<string, unknown>>;
  errors?: string[];
};
type RealOrderExecution = { brokerOrderId: string; stockName: string; symbol: string; side: 'BUY' | 'SELL'; quantity: number; entryPrice: number; orderStatus: 'COMPLETE' | 'OPEN' };

type QueueFilter = 'All' | 'Waiting' | 'Executing' | 'Running' | 'Completed' | 'Failed' | 'Broker Error';

function RealEntryQueue({ queue }: { queue: RealDashboard['queue'] }) {
  const [filter, setFilter] = useState<QueueFilter>('All');
  const [limit, setLimit] = useState(20);
  const [collapsed, setCollapsed] = useState(false);
  const diagnostics = (item: RealDashboard['queue'][number]) => {
    try { return JSON.parse(item.validationLog) as Array<{ step: string; status: 'PASS' | 'FAIL'; detail: string }>; } catch { return []; }
  };
  const rawError = (item: RealDashboard['queue'][number]) => `${item.reason ?? ''} ${item.brokerResponse ?? ''}`;
  const isBrokerError = (item: RealDashboard['queue'][number]) => /UDAPI|\b403\b|broker|permission|static ip/i.test(rawError(item));
  const category = (item: RealDashboard['queue'][number]): Exclude<QueueFilter, 'All' | 'Broker Error'> => {
    const value = `${item.status} ${item.displayStatus}`.toUpperCase();
    if (/PROCESSING|EXECUTING/.test(value)) return 'Executing';
    if (/EXECUTED|RUNNING|OPEN/.test(value)) return 'Running';
    if (/COMPLETED|CLOSED/.test(value)) return 'Completed';
    if (/REJECTED|FAILED|ERROR/.test(value)) return 'Failed';
    return 'Waiting';
  };
  const friendlyReason = (item: RealDashboard['queue'][number]) => {
    const value = rawError(item);
    if (/UDAPI1154/i.test(value)) return 'Static IP Required';
    if (/\b403\b/.test(value)) return 'Broker Permission Error';
    if (/entry condition failed|entry price|live price/i.test(value)) return 'Live Price Changed';
    if (/confidence/i.test(value)) return 'Confidence Too Low';
    if (/risk.?reward/i.test(value)) return 'Risk/Reward Failed';
    if (isBrokerError(item)) return 'Broker API Error';
    return item.reason?.split('\n')[0].slice(0, 110) || (category(item) === 'Waiting' ? 'Waiting for entry trigger' : category(item));
  };
  const newest = [...queue].sort((a, b) => new Date(b.queuedAt).getTime() - new Date(a.queuedAt).getTime());
  const filtered = newest.filter((item) => filter === 'All' || filter === 'Broker Error' ? filter === 'All' || isBrokerError(item) : category(item) === filter);
  const visible = filtered.slice(0, limit);
  const count = (value: QueueFilter) => value === 'Broker Error' ? newest.filter(isBrokerError).length : newest.filter((item) => category(item) === value).length;
  const icon = (item: RealDashboard['queue'][number]) => isBrokerError(item) || category(item) === 'Failed' ? '🔴' : category(item) === 'Running' || category(item) === 'Completed' ? '🟢' : '🟡';
  const filters: QueueFilter[] = ['All', 'Waiting', 'Executing', 'Running', 'Completed', 'Failed', 'Broker Error'];
  return <aside className={`glass-card order-last self-start overflow-hidden xl:sticky xl:top-4 xl:col-start-2 xl:row-start-6 xl:row-span-2 xl:w-[320px] xl:min-w-[320px] ${collapsed ? '' : 'flex h-[250px] flex-col'}`}>
    <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2.5"><div><h2 className="text-sm font-black text-white">Entry Queue</h2><p className="text-[9px] uppercase tracking-wider text-slate-500">Newest execution signals</p></div><button onClick={() => setCollapsed((value) => !value)} className="rounded-md border border-slate-700 px-2 py-1 text-[10px] font-bold text-slate-300">{collapsed ? 'Expand' : 'Collapse'}</button></div>
    {!collapsed && <><div className="flex gap-1 overflow-x-auto border-b border-slate-800 p-2">{filters.map((value) => <button key={value} onClick={() => { setFilter(value); setLimit(20); }} className={`whitespace-nowrap rounded-md border px-2 py-1 text-[9px] font-bold ${filter === value ? 'border-cyan-400/40 bg-cyan-400/10 text-cyan-300' : 'border-slate-800 bg-slate-950/40 text-slate-500'}`}>{value}{value === 'All' ? ` (${queue.length})` : ` (${count(value)})`}</button>)}</div>
    <div className="grid grid-cols-2 gap-1 border-b border-slate-800 px-2 py-2 text-[9px]"><span className="text-amber-300">Waiting ({count('Waiting')})</span><span className="text-cyan-300">Executing ({count('Executing')})</span><span className="text-rose-300">Failed ({count('Failed')})</span><span className="text-orange-300">Broker Errors ({count('Broker Error')})</span></div>
    <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto overscroll-contain p-2">{visible.map((item) => { const log = diagnostics(item); const state = category(item); return <details key={item.id} className="group rounded-lg border border-slate-800 bg-slate-950/50"><summary className="cursor-pointer list-none p-2"><div className="grid grid-cols-[18px_1fr_auto] items-center gap-1.5 text-[10px]"><span>{icon(item)}</span><b className="truncate text-white">{item.symbol} <span className={item.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}>{item.side}</span></b><span className="text-slate-500">{time(item.queuedAt)}</span></div><div className="mt-1 grid grid-cols-[1fr_auto_auto] gap-2 text-[10px]"><span className="text-slate-300">{money(item.entryPrice)}</span><span className="text-cyan-300">{item.confidence}%</span><b className={state === 'Failed' ? 'text-rose-300' : state === 'Running' || state === 'Completed' ? 'text-emerald-300' : 'text-amber-300'}>{state}</b></div><p className="mt-1 truncate text-[9px] text-slate-500">Reason: {friendlyReason(item)}</p></summary><div className="border-t border-slate-800 p-2 text-[9px]"><p className="font-black uppercase text-slate-400">Execution Log</p><div className="mt-1 space-y-1">{log.map((entry, index) => <div key={`${item.id}-${index}`} className="grid grid-cols-[1fr_34px] gap-1 rounded bg-slate-900 p-1.5"><span className="truncate text-slate-400">{entry.step}: {entry.detail}</span><b className={entry.status === 'PASS' ? 'text-emerald-300' : 'text-rose-300'}>{entry.status}</b></div>)}{!log.length && <p className="text-slate-600">No execution log recorded.</p>}</div><p className="mt-2 font-black uppercase text-slate-400">Technical Details</p><p className="mt-1 break-all text-slate-600">ID {item.id} · Status {item.status}</p>{item.brokerResponse && <details className="mt-2"><summary className="cursor-pointer font-bold text-rose-300">API Response / Stack Trace</summary><pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded bg-black/30 p-2 text-[8px] text-rose-200">{item.brokerResponse}</pre></details>}</div></details>; })}{!visible.length && <p className="py-10 text-center text-xs text-slate-600">No queue records match this filter.</p>}{filtered.length > visible.length && <button onClick={() => setLimit((value) => value + 20)} className="w-full rounded-md border border-slate-700 py-2 text-[10px] font-bold text-slate-300">Load 20 older records</button>}</div></>}
  </aside>;
}

function RealSignalTrading({ session }: { session: string }) {
  const client = useQueryClient();
  const announcedOrderIds = useRef(new Set<string>());
  const dashboard = useQuery({ queryKey: ['signal-history-real-trading'], queryFn: () => realTradingService.dashboard<RealDashboard>(), enabled: Boolean(session), retry: false, refetchInterval: 10_000 });
  const [settings, setSettings] = useState<RealDashboard['settings'] | null>(null);
  useEffect(() => { if (dashboard.data) setSettings(dashboard.data.settings); }, [dashboard.data]);
  useEffect(() => {
    if (!session) return;
    const socket = io(base, { auth: { token: token() }, reconnection: true });
    socket.on('real-trading-updated', () => void client.invalidateQueries({ queryKey: ['signal-history-real-trading'] }));
    socket.on('real-order-executed', (execution: RealOrderExecution) => {
      if (!execution?.brokerOrderId || !['COMPLETE', 'OPEN'].includes(execution.orderStatus) || announcedOrderIds.current.has(execution.brokerOrderId)) return;
      announcedOrderIds.current.add(execution.brokerOrderId);
      if (!('speechSynthesis' in window)) return;
      const utterance = new SpeechSynthesisUtterance(
        `${execution.side === 'BUY' ? 'Buy' : 'Sell'} order executed. ${execution.stockName || execution.symbol}. Quantity ${execution.quantity}. Entry price ${Number(execution.entryPrice).toLocaleString('en-IN', { maximumFractionDigits: 2 })} rupees.`,
      );
      utterance.lang = 'en-IN';
      utterance.rate = 1;
      utterance.volume = 0.7;
      utterance.pitch = 1;
      const voices = window.speechSynthesis.getVoices();
      utterance.voice = voices.find((voice) => voice.lang === 'en-IN')
        ?? voices.find((voice) => voice.lang.startsWith('en-'))
        ?? null;
      // SpeechSynthesis queues utterances in call order, so simultaneous real
      // fills are announced once each without interrupting one another.
      window.speechSynthesis.speak(utterance);
    });
    return () => { socket.close(); };
  }, [client, session]);
  const save = async (next: RealDashboard['settings']) => {
    setSettings(next);
    await realTradingService.updateSettings(next);
    await client.invalidateQueries({ queryKey: ['signal-history-real-trading'] });
  };
  const disconnect = async () => {
    if (!window.confirm('Disconnect Upstox and disable Auto Real Trading?')) return;
    await realTradingService.disconnect();
    localStorage.removeItem('upstox_session');
    window.location.assign('/ai-signal-history');
  };
  const exitOrder = async (orderId: string) => {
    if (!window.confirm('Exit this live Upstox position at market?')) return;
    await realTradingService.exitOrder(orderId);
    await client.invalidateQueries({ queryKey: ['signal-history-real-trading'] });
  };
  if (!session) return <div className="glass-card p-5 text-sm text-amber-200">Connect Upstox to configure Real Trading.</div>;
  if (!dashboard.data || !settings) return <div className="glass-card grid min-h-56 place-items-center"><Activity className="h-6 w-6 animate-pulse text-cyan-300" /></div>;
  const data = dashboard.data;
  const open = data.ledger.filter((order) => order.status === 'OPEN');
  const history = data.ledger.filter((order) => order.status !== 'OPEN');
  const displayedCapitalPerTrade = settings.maxOpenTrades > 0
    ? (data.funds.available + data.statistics.usedCapital) / settings.maxOpenTrades
    : data.funds.available;
  const connectionChecks = [['Upstox Account', data.connected], ['Access Token', data.safety.tokenValid], ['Market Open', data.safety.marketOpen], ['Available Margin', data.funds.available > 0], ['Risk Settings', settings.maxDailyLoss > 0 && settings.riskPerTrade > 0], ['Auto Trading', settings.autoTrading]];
  return <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
    <div className="flex flex-wrap items-end justify-between gap-4 xl:col-span-2"><div><p className="section-eyebrow">UPSTOX LIVE EXECUTION</p><h1 className="text-3xl font-bold text-white">Real Trading</h1><p className="mt-2 text-sm text-slate-400">Start enables monitoring. Orders are sent only after Entry Triggered advances to Running and every safety check passes.</p></div><div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-4 py-2 text-xs font-black ${data.connected ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-rose-400/30 bg-rose-400/10 text-rose-300'}`}>● UPSTOX {data.connected ? 'CONNECTED' : 'DISCONNECTED'}</span><button onClick={() => window.location.assign(upstoxLoginUrl())} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-black text-cyan-300">Connect Upstox</button><button onClick={() => void client.invalidateQueries({ queryKey: ['signal-history-real-trading'] })} className="rounded-lg border border-slate-700 px-3 py-2 text-xs font-black text-slate-300">Refresh Balance</button><button onClick={() => void disconnect()} className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-xs font-black text-rose-300">Disconnect Broker</button></div></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:col-span-2 xl:grid-cols-7"><Summary label="Broker Name" value="Upstox" /><Summary label="Connected Account" value={data.profile?.userName ?? '—'} /><Summary label="Client ID" value={data.profile?.userId ?? '—'} /><Summary label="Trading Status" value={settings.autoTrading ? 'AUTO ON' : 'AUTO OFF'} tone={settings.autoTrading ? 'text-emerald-300' : 'text-slate-400'} /><Summary label="Available Balance" value={money(data.funds.available)} tone="text-emerald-300" /><Summary label="Used Margin" value={money(data.funds.margin)} tone="text-amber-300" /><Summary label="Connection Time" value={time(data.connectionTime)} /></div>
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5 xl:col-span-2 xl:grid-cols-11">{[['Remaining Balance', money(data.statistics.availableCapital)], ['Capital Per Trade', money(displayedCapitalPerTrade)], ['Used Capital', money(data.statistics.usedCapital)], ['Net Profit', money(data.statistics.netProfit)], ["Today's Profit", money(data.statistics.todayProfit)], ["Today's Loss", money(data.statistics.todayLoss)], ['Running Trades', data.statistics.runningTrades], ['Winning Trades', data.statistics.winningTrades], ['Losing Trades', data.statistics.losingTrades], ['Completed Trades', data.statistics.completedTrades], ['ROI / Win Rate', `${data.statistics.roi.toFixed(2)}% / ${data.statistics.winRate.toFixed(1)}%`]].map(([title, value]) => <Summary key={String(title)} label={String(title)} value={value} />)}</div>
    <div className="glass-card p-5 xl:col-span-2"><p className="section-eyebrow">PRE-TRADE SAFETY</p><div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">{connectionChecks.map(([title, pass]) => <div key={String(title)} className={`rounded-lg border p-3 text-xs font-black ${pass ? 'border-emerald-400/20 bg-emerald-400/[.06] text-emerald-300' : 'border-rose-400/20 bg-rose-400/[.06] text-rose-300'}`}>{pass ? '✓' : '✕'} {title}</div>)}</div></div>
    <div className="glass-card p-5 xl:col-span-2"><datalist id="real-capital-options">{[1000, 5000, 10000, 25000, 50000, 100000].map((value) => <option key={value} value={value} />)}</datalist><div className="flex flex-wrap items-end gap-4">{([['Trading Capital', 'tradingCapital'], ['Risk Per Trade %', 'riskPerTrade'], ['Minimum Confidence', 'minimumConfidence'], ['Maximum Daily Loss', 'maxDailyLoss'], ['Maximum Daily Profit', 'maxDailyProfit']] as const).map(([title, key]) => <label key={key} className="min-w-36 flex-1"><span className="metric-label">{title}</span><input type="number" list={key === 'tradingCapital' ? 'real-capital-options' : undefined} value={settings[key]} onChange={(event) => setSettings({ ...settings, [key]: Number(event.target.value) })} onBlur={() => void save(settings)} className={`${selectClass} mt-2 w-full`} /></label>)}<label className="min-w-36"><span className="metric-label">Maximum Open Trades</span><select value={settings.maxOpenTrades} onChange={(event) => void save({ ...settings, maxOpenTrades: Number(event.target.value) })} className={`${selectClass} mt-2 w-full`}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value}</option>)}<option value={0}>Unlimited</option></select></label><label className="min-w-36"><span className="metric-label">Square Off Time</span><input type="time" value={settings.squareOffTime} onChange={(event) => void save({ ...settings, squareOffTime: event.target.value })} className={`${selectClass} mt-2 w-full`} /></label></div><div className="mt-5 flex flex-wrap gap-3"><button onClick={() => void save({ ...settings, autoTrading: true })} disabled={settings.autoTrading} className="rounded-lg border border-emerald-400/30 bg-emerald-400/10 px-4 py-2.5 text-xs font-black text-emerald-300 disabled:opacity-40">Start Real Trading</button><button onClick={() => void save({ ...settings, autoTrading: false })} disabled={!settings.autoTrading} className="rounded-lg border border-rose-400/30 bg-rose-400/10 px-4 py-2.5 text-xs font-black text-rose-300 disabled:opacity-40">Stop Real Trading</button>{([['BUY Signals', 'buySignals'], ['SELL Signals', 'sellSignals']] as const).map(([title, key]) => <button key={key} onClick={() => void save({ ...settings, [key]: !settings[key] })} className={`rounded-lg border px-4 py-2.5 text-xs font-black ${settings[key] ? 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-500'}`}>{title} · {settings[key] ? 'ON' : 'OFF'}</button>)}</div>{data.safety.dailyLimitReached && <p className="mt-4 rounded-lg border border-rose-400/30 bg-rose-400/10 p-3 text-sm font-bold text-rose-300">Daily profit/loss limit reached. Automatic trading is disabled.</p>}</div>
    <section className="xl:col-start-1 xl:row-start-6"><div className="mb-3 flex justify-between"><h2 className="text-xl font-black text-white">Live Positions</h2><span className="text-xs text-slate-500">{open.length} open</span></div><div className="grid gap-4 xl:grid-cols-2">{open.map((order) => <article key={order.id} className={`rounded-2xl border border-slate-800 bg-gradient-to-br from-[#111a2b] to-[#090e19] p-5 ${order.pnl >= 0 ? 'border-l-4 border-l-emerald-400' : 'border-l-4 border-l-rose-400'}`}><div className="flex justify-between"><div><p className="text-xl font-black text-white">{order.symbol}</p><p className={`mt-1 text-xs font-black ${order.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}>{order.side} · MANAGING POSITION</p></div><p className={`text-xl font-black ${order.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{order.pnl >= 0 ? '+' : ''}{money(order.pnl)}</p></div><div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4"><Metric title="Entry Price" value={money(order.entryPrice)} /><Metric title="Current Price" value={money(order.currentPrice)} /><Metric title="Quantity" value={String(order.quantity)} /><Metric title="Investment" value={money(order.investment)} /><Metric title="P&L %" value={`${order.pnlPercent.toFixed(2)}%`} /><Metric title="Target 1" value={money(order.target1)} tone="text-emerald-300" /><Metric title="Target 2" value={money(order.target2)} tone="text-emerald-300" /><Metric title="Target 3" value={money(order.target3)} tone="text-emerald-300" /><Metric title="Stop Loss" value={money(order.currentStop)} tone="text-rose-300" /><Metric title="Holding Time" value={order.executionTime ? `${Math.max(0, Math.floor((Date.now() - new Date(order.executionTime).getTime()) / 60000))} min` : '—'} /><Metric title="Order Status" value={order.status} /><Metric title="Broker Order ID" value={order.brokerOrderId ?? 'Pending'} /></div><div className="mt-4 flex gap-3"><Link href={`/analysis/${encodeURIComponent(order.instrumentKey)}`} className="grid min-h-11 flex-1 place-items-center rounded-lg border border-sky-400/30 bg-sky-400/10 text-sm font-bold text-sky-300">View Details</Link><button onClick={() => void exitOrder(order.id)} className="min-h-11 flex-1 rounded-lg border border-rose-400/30 bg-rose-400/10 text-sm font-bold text-rose-300">Manual Exit</button></div></article>)}</div>{!open.length && <div className="rounded-xl border border-dashed border-slate-700 py-10 text-center text-sm text-slate-500">No live Upstox positions created by AI Signal History.</div>}</section>
    <RealEntryQueue queue={data.queue} />
    <section className="glass-card p-5 xl:col-start-1 xl:row-start-7"><div className="flex justify-between"><h2 className="font-black text-white">Trade History</h2><span className="text-xs text-slate-500">{history.length} records</span></div><div className="mt-3 space-y-2">{history.map((order) => <div key={order.id} className="grid gap-3 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-xs sm:grid-cols-6"><Metric title="Stock" value={order.symbol} /><Metric title="Side" value={order.side} /><Metric title="Order Status" value={order.status} /><Metric title="Exit Reason" value={order.exitReason ?? '—'} /><Metric title="Exit Time" value={time(order.exitTime)} /><Metric title="Final P&L" value={money(order.pnl)} tone={order.pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'} /></div>)}</div></section>
  </section>;
}

function TradeProgressAnalytics({ analytics, selectedKey, onSelect, onClear }: { analytics: Response['analytics']; selectedKey: string | null; onSelect: (key: string, label: string, signalIds: string[]) => void; onClear: () => void }) {
  const toneText = (tone: string) => tone === 'emerald' ? 'text-emerald-300' : tone === 'blue' ? 'text-sky-300' : tone === 'amber' ? 'text-amber-300' : 'text-rose-300';
  const toneBar = (tone: string) => tone === 'emerald' ? 'bg-emerald-400' : tone === 'blue' ? 'bg-sky-400' : tone === 'amber' ? 'bg-amber-400' : 'bg-rose-400';
  const flowForConversion = (key: string) => analytics.compactFlow.find((metric) => metric.key === ({ running_target1: 'flow_target1', target1_target2: 'flow_target2', target2_target3: 'flow_target3', target3_completed: 'flow_completed', running_stoploss: 'flow_stoploss' } as Record<string, string>)[key]);
  const contextCohort = selectedKey === 'flow_target1' ? analytics.compactFlow.find((metric) => metric.key === 'flow_target1') : selectedKey === 'flow_running' ? analytics.compactFlow.find((metric) => metric.key === 'flow_running') : null;
  const contextMetrics = selectedKey === 'flow_target1' ? analytics.qualities.filter((item) => ['quality_elite', 'quality_excellent', 'quality_weak'].includes(item.key)) : selectedKey === 'flow_running' ? analytics.compactFlow.filter((item) => ['flow_target1', 'flow_target2', 'flow_target3', 'flow_completed', 'flow_stoploss'].includes(item.key)) : [];
  const withinContext = (signalIds: string[]) => signalIds.filter((id) => contextCohort?.signalIds.includes(id));
  return <section className="glass-card mt-5 p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div><p className="section-eyebrow">LIVE EVENT LEDGER</p><h2 className="text-lg font-black text-white">Trade Progress Analytics</h2></div>{selectedKey && <button onClick={onClear} className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[10px] font-black text-slate-300">Clear filter</button>}</div><div className="mt-3 grid gap-3 xl:grid-cols-2"><article className="rounded-xl border border-slate-800 bg-slate-950/35 p-3"><h3 className="metric-label">1 · Trade Flow</h3><div className="mt-2 flex flex-wrap gap-1.5">{analytics.compactFlow.map((metric) => <button key={metric.key} onClick={() => onSelect(metric.key, metric.label, metric.signalIds)} className={`min-w-[72px] rounded-lg border px-2 py-1.5 text-left ${selectedKey === metric.key ? 'border-cyan-300 bg-cyan-400/15' : metric.key === 'flow_stoploss' ? 'border-rose-400/20 bg-rose-400/[.06]' : 'border-slate-800 bg-slate-900/60'}`}><span className="block text-[8px] font-bold uppercase text-slate-500">{metric.label}</span><span className={`block text-base font-black ${metric.key === 'flow_stoploss' ? 'text-rose-300' : 'text-slate-100'}`}>{metric.count}</span></button>)}</div></article><article className="rounded-xl border border-slate-800 bg-slate-950/35 p-3"><h3 className="metric-label">2 · AI Quality Score</h3><div className="mt-2 grid gap-x-3 gap-y-2 sm:grid-cols-2">{analytics.conversions.map((item) => { const target = flowForConversion(item.key); return <button key={item.key} onClick={() => target && onSelect(target.key, target.label, target.signalIds)} className="text-left"><div className="flex items-center justify-between gap-2 text-[10px]"><span className="font-bold text-slate-300">{item.label}</span><span className="text-slate-500">{item.numerator}/{item.denominator} <b className={toneText(item.tone)}>{item.percentage.toFixed(1)}%</b></span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-800"><div className={`h-full rounded-full ${toneBar(item.tone)}`} style={{ width: `${Math.min(100, item.percentage)}%` }} /></div><p className={`mt-1 text-[9px] font-black ${toneText(item.tone)}`}>{'★'.repeat(item.stars)} {item.rating}</p></button>; })}</div></article><article className="rounded-xl border border-slate-800 bg-slate-950/35 p-3"><h3 className="metric-label">3 · Best Stock Quality</h3><div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">{analytics.qualities.map((quality) => <button key={quality.key} onClick={() => onSelect(quality.key, quality.label, quality.signalIds)} className={`rounded-lg border px-2 py-2 text-left ${selectedKey === quality.key ? 'border-cyan-300 bg-cyan-400/15' : qualityTone(quality.tone)}`}><span className="block text-[9px] font-black">{'★'.repeat(quality.stars)} {quality.label}</span><span className="mt-1 block text-base font-black">{quality.count}</span><span className="text-[8px] opacity-70">Stocks</span></button>)}</div></article><article className="rounded-xl border border-slate-800 bg-slate-950/35 p-3"><h3 className="metric-label">4 · AI Health</h3><div className="mt-2 grid grid-cols-3 gap-1.5">{analytics.health.map((item) => <div key={item.key} className="rounded-lg border border-slate-800 bg-slate-900/60 px-2 py-1.5"><span className="block text-[8px] font-bold uppercase text-slate-500">{item.label}</span><span className={`block text-sm font-black ${toneText(item.tone)}`}>{item.value.toFixed(item.key === 'health_score' ? 0 : 1)}{item.suffix}</span><span className={`text-[8px] font-bold ${toneText(item.tone)}`}>{item.rating}</span></div>)}</div></article></div>{contextCohort && <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg border border-cyan-400/15 bg-cyan-400/[.04] p-2"><span className="mr-1 text-[9px] font-black uppercase text-cyan-300">{selectedKey === 'flow_target1' ? 'Target 1 quality' : 'Running progression'}</span>{contextMetrics.map((item) => { const ids = withinContext(item.signalIds); return <button key={`context-${item.key}`} onClick={() => onSelect(`context_${item.key}`, item.label, ids)} className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-[9px] font-bold text-slate-300">{item.label} <b className="text-white">{ids.length}</b></button>; })}</div>}</section>;
}

export function AiSignalHistory({ session }: { session: string }) {
  const client = useQueryClient(); const [activeTab, setActiveTab] = useState<'history' | 'demo' | 'real'>('history'); const [side, setSide] = useState('ALL'); const [strategy, setStrategy] = useState('ALL'); const [timeframe, setTimeframe] = useState('ALL'); const [tradeStatus, setTradeStatus] = useState('ALL'); const [analyticsFilter, setAnalyticsFilter] = useState<{ key: string; label: string; signalIds: string[] } | null>(null);
  const query = useQuery({ queryKey: ['ai-signal-history'], queryFn: () => api<Response>('/signal-history'), enabled: Boolean(session), retry: false, refetchInterval: 15_000 });
  const filteredQuery = useQuery({ queryKey: ['ai-signal-history', 'status', tradeStatus], queryFn: () => api<Response>(`/signal-history?status=${encodeURIComponent(tradeStatus)}`), enabled: Boolean(session && tradeStatus !== 'ALL'), retry: false, refetchInterval: 15_000 });
  const statisticStatuses = ['WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'STOPLOSS_HIT', 'COMPLETED'] as const;
  const statisticQueries = useQueries({ queries: statisticStatuses.map((status) => ({ queryKey: ['ai-signal-history', 'status-count', status], queryFn: () => api<Response>(`/signal-history?status=${encodeURIComponent(status)}`), enabled: Boolean(session), retry: false, refetchInterval: 15_000 })) });
  const create = useMutation({ mutationFn: (id: string) => api<AiSignal>(`/signal-history/${encodeURIComponent(id)}/generate`, { method: 'POST' }), onSuccess: () => void client.invalidateQueries({ queryKey: ['ai-signal-history'] }) });
  useEffect(() => { if (!session) return; const socket = io(base, { auth: { token: token() }, reconnection: true }); socket.on('signal-history-updated', () => void client.invalidateQueries({ queryKey: ['ai-signal-history'] })); socket.on('market-price-updated', (tick: { instrumentKey: string; ltp: number; timestamp: number }) => client.setQueryData<Response>(['ai-signal-history'], (data) => data ? { ...data, signals: data.signals.map((signal) => { if (signal.instrumentKey !== tick.instrumentKey) return signal; console.debug('[QuantPulse] Price update received', { instrument: tick.instrumentKey, previousPrice: signal.currentPrice, newPrice: tick.ltp }); queueMicrotask(() => console.debug('[QuantPulse] Component re-rendered', { instrument: tick.instrumentKey, price: tick.ltp })); return { ...signal, currentPrice: tick.ltp, updatedAt: new Date(tick.timestamp).toISOString() }; }) } : data)); return () => { socket.close(); }; }, [client, session]);
  const statusSignals = analyticsFilter ? query.data?.signals.filter((signal) => analyticsFilter.signalIds.includes(signal.id)) : tradeStatus === 'ALL' ? query.data?.signals : filteredQuery.data?.signals;
  const groups = useMemo(() => { const result = new Map<string, AiSignal[]>(); for (const signal of statusSignals ?? []) { if (!isCurrentTradingDay(signal.signalTime)) continue; const key = `${signal.instrumentKey}:${signal.timeframe}:${signal.strategy}`; result.set(key, [...(result.get(key) ?? []), signal]); } return [...result.values()].map((trades) => { const ordered = trades.sort((a, b) => new Date(b.signalTime).getTime() - new Date(a.signalTime).getTime()); const current = ordered.find((trade) => ACTIVE.includes(trade.status)) ?? ordered[0]; return { current, history: ordered.filter((trade) => trade.id !== current.id) }; }).filter(({ current }) => current.currentPrice >= 60 && current.currentPrice <= 600 && (side === 'ALL' || current.side === side) && (strategy === 'ALL' || current.strategy === strategy) && (timeframe === 'ALL' || current.timeframe === timeframe)).sort((a, b) => b.current.aiScore - a.current.aiScore || b.current.confidence - a.current.confidence || b.current.volume - a.current.volume || new Date(b.current.signalTime).getTime() - new Date(a.current.signalTime).getTime()); }, [statusSignals, side, strategy, timeframe]);
  const summary = query.data?.summary;
  const todayStats = Object.fromEntries(statisticStatuses.map((status, index) => [status, statisticQueries[index].data?.summary.todaySignals ?? 0])) as Record<(typeof statisticStatuses)[number], number>;
  const selectAnalytics = (key: string, filterLabel: string, signalIds: string[]) => { setAnalyticsFilter({ key, label: filterLabel, signalIds }); setTradeStatus('ALL'); };
  const selectStatus = (status: string) => { setAnalyticsFilter(null); setTradeStatus(status); };
  return <div><nav className="mb-6 flex gap-2 border-b border-slate-800 pb-3">{([['history', 'Signal History'], ['demo', 'Demo Trading'], ['real', 'Real Trading']] as const).map(([key, title]) => <button key={key} onClick={() => setActiveTab(key)} className={`rounded-lg border px-4 py-2.5 text-sm font-black ${activeTab === key ? 'border-cyan-400/30 bg-cyan-400/10 text-cyan-300' : 'border-slate-800 bg-slate-950/40 text-slate-500'}`}>{title}</button>)}</nav><div className={activeTab === 'history' ? 'block' : 'hidden'}><div className="mb-7 flex flex-wrap items-end justify-between gap-4"><div><p className="section-eyebrow">AUTOMATED INTRADAY JOURNAL</p><h1 className="text-3xl font-bold text-white">Intraday Signal History</h1><p className="mt-2 text-sm text-slate-400">One evolving card per active stock, timeframe, and strategy.</p></div><div className="flex items-center gap-2 rounded-full border border-emerald-400/20 bg-emerald-400/[.07] px-3 py-2 text-xs font-bold text-emerald-300"><span className="live-dot" /><Radio className="h-3.5 w-3.5" />LIVE TRACKING</div></div><section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-8"><Summary label="Today's Signals" value={summary?.todaySignals ?? '—'} /><Summary label="Winning Trades" value={summary?.winningTrades ?? '—'} tone="text-emerald-300" /><Summary label="Losing Trades" value={summary?.losingTrades ?? '—'} tone="text-rose-300" /><Summary label="Win Rate" value={summary ? `${summary.winRate.toFixed(1)}%` : '—'} /><Summary label="Average Profit" value={summary ? `${summary.averageProfit.toFixed(2)}%` : '—'} tone="text-emerald-300" /><Summary label="Average Loss" value={summary ? `${summary.averageLoss.toFixed(2)}%` : '—'} tone="text-rose-300" /><Summary label="Best Trade" value={summary?.bestTrade ? `${summary.bestTrade.symbol} +${Number(summary.bestTrade.profitPercent).toFixed(2)}%` : '—'} tone="text-emerald-300" /><Summary label="Worst Trade" value={summary?.worstTrade ? `${summary.worstTrade.symbol} ${Number(summary.worstTrade.profitPercent).toFixed(2)}%` : '—'} tone="text-rose-300" /><Summary label="Waiting" value={todayStats.WAITING} /><Summary label="Entry Triggered" value={todayStats.ENTRY_TRIGGERED} /><Summary label="Running" value={todayStats.RUNNING} /><Summary label="Target 1 Hit" value={todayStats.TARGET1_HIT} tone="text-emerald-300" /><Summary label="Target 2 Hit" value={todayStats.TARGET2_HIT} tone="text-emerald-300" /><Summary label="Target 3 Hit" value={todayStats.TARGET3_HIT} tone="text-emerald-300" /><Summary label="Stop Loss Hit" value={todayStats.STOPLOSS_HIT} tone="text-rose-300" /><Summary label="Completed" value={todayStats.COMPLETED} /></section>{query.data?.analytics && <TradeProgressAnalytics analytics={query.data.analytics} selectedKey={analyticsFilter?.key ?? null} onSelect={selectAnalytics} onClear={() => setAnalyticsFilter(null)} />}<section className="glass-card mt-5 flex flex-wrap gap-3 p-4"><label className="flex min-w-32 flex-col gap-1.5"><span className="metric-label">Price</span><select className={selectClass} value="₹60–₹600" disabled><option>₹60–₹600</option></select></label><Filter title="Signal" value={side} values={['ALL', 'BUY', 'SELL']} onChange={setSide} /><Filter title="Strategy" value={strategy} values={['ALL', 'Breakout', 'Momentum', 'VWAP', 'ORB', 'Pullback']} onChange={setStrategy} /><Filter title="Timeframe" value={timeframe} values={['ALL', '1m', '3m', '5m', '15m', '30m']} onChange={setTimeframe} /><Filter title="Status" value={tradeStatus} values={['ALL', 'WAITING', 'ENTRY_TRIGGERED', 'RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'COMPLETED', 'STOPLOSS_HIT']} onChange={selectStatus} /></section>{analyticsFilter && <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/[.06] px-4 py-3 text-xs font-bold text-cyan-200">Analytics filter: {analyticsFilter.label} · {analyticsFilter.signalIds.length} trades</div>}{!session && <div className="glass-card mt-5 p-5 text-amber-200">Connect Upstox to track scanner signals.</div>}{query.isLoading && <div className="glass-card mt-5 grid min-h-64 place-items-center"><Activity className="h-6 w-6 animate-pulse text-cyan-300" /></div>}{query.isError && <div className="glass-card mt-5 border-rose-400/20 p-5 text-sm text-rose-200">{query.error.message}</div>}{create.isError && <div className="glass-card mt-5 border-amber-400/20 p-4 text-sm text-amber-200">{create.error.message}</div>}{query.data && <section className="mt-5 space-y-3">{groups.map(({ current, history }) => <TradeCard key={`${current.instrumentKey}:${current.timeframe}:${current.strategy}`} signal={current} history={history} quality={query.data?.analytics.qualityBySignal[current.id]} generate={(id) => create.mutate(id)} />)}{!groups.length && <div className="glass-card grid min-h-56 place-items-center text-center"><div><Clock3 className="mx-auto h-7 w-7 text-slate-500" /><p className="mt-3 text-sm text-slate-400">No trading signals match the selected analytics and signal filters.</p></div></div>}</section>}</div>{activeTab === 'demo' && <DemoTrading session={session} signals={query.data?.signals ?? []} />}{activeTab === 'real' && <RealSignalTrading session={session} />}</div>;
}
