'use client';

import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { realTradingService } from '../lib/trading-services';
import { base, token } from '../lib/api';

type Source = 'STRATEGY' | 'SIGNAL_HISTORY';
type Event = { id: string; type: string; observedAt: string; origin: string; detail: string; brokerTimestamp?: string };
type Trade = { id: string; source: Source; symbol: string; side: string; status: string; quantity: number; hitAt: string; entryTime?: string; exitTime?: string; entryPrice?: number; exitPrice?: number; target: number; stopLoss: number; exitReason?: string; error?: string; events: Event[]; attempts: Array<{ id: string; kind: string; status: string; brokerOrderId?: string }> };
type Decision = { id: string; source: Source; symbol: string; side: string; hitAt: string; observedAt: string; code: string; reason: string; tradeId?: string; trade?: { status: string; error?: string } };
type Stream = { status: 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'INACTIVE'; lastMessageAt?: string; connectedAt?: string; reconnects: number; pollingFallback: boolean };
type Dashboard = {
  connected: boolean; broker: string; funds: { available: number; margin: number }; errors?: string[];
  positions: Array<{ instrumentKey: string; symbol: string; side: string; quantity: number; averagePrice: number; currentPrice: number; pnl: number; product: string }>;
  orders: Array<{ orderId: string; symbol: string; transactionType: string; status: string; quantity: number; averagePrice: number }>;
  automation: { riskPerTrade: number; maximumRiskAmount: number; strategyEnabled: boolean; historyEnabled: boolean; strategyEnabledAt?: string; historyEnabledAt?: string; activeTradeId?: string; trades: Trade[]; decisions: Decision[]; decisionCounts: Array<{ source: Source; code: string; _count: number }>; stream: Stream };
};
const money = (value?: number) => value == null ? '—' : `₹${value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const time = (value?: string) => value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) : '—';
const pageName = (source: Source) => source === 'STRATEGY' ? 'AI Trade Strategy' : 'AI Signal History';
const delay = (start: string, end: string) => {
  const milliseconds = new Date(end).getTime() - new Date(start).getTime();
  if (!Number.isFinite(milliseconds)) return '—';
  return milliseconds < 1_000 ? `+${Math.max(0, milliseconds)} ms` : `+${(Math.max(0, milliseconds) / 1_000).toFixed(2)} s`;
};
const eventName = (value: string) => value.replaceAll('_', ' ').toLowerCase().replace(/^./, letter => letter.toUpperCase());

export function RealTradingSection({ session, source }: { session: string; source: Source }) {
  const client = useQueryClient();
  const query = useQuery({ queryKey: ['real-trading'], queryFn: () => realTradingService.dashboard<Dashboard>(), enabled: !!session, retry: false, refetchInterval: 5_000 });
  const refresh = () => client.invalidateQueries({ queryKey: ['real-trading'] });
  const riskUpdate = useMutation({ mutationFn: (input: { percent: number; cap: number }) => realTradingService.setRisk(input.percent, input.cap), onSuccess: refresh });
  useEffect(() => {
    if (!session) return;
    const socket = io(base, { auth: { token: token() }, reconnection: true });
    socket.on('real-trading-updated', refresh);
    return () => { socket.close(); };
  }, [client, session]);
  const toggle = useMutation({ mutationFn: (enabled: boolean) => realTradingService.setEnabled(source, enabled), onSuccess: refresh });
  const exit = useMutation({ mutationFn: ({ key, product }: { key: string; product: string }) => realTradingService.exitPosition(key, product), onSuccess: refresh });
  if (!session) return <div className="glass-card p-5">Connect Upstox to use Real Trading.</div>;
  if (query.isLoading) return <div className="glass-card p-5">Loading your broker account…</div>;
  if (!query.data) return <div role="alert" className="glass-card p-5 text-rose-300">{query.error?.message ?? 'Broker data unavailable'}<button className="ml-3 underline" onClick={() => void query.refetch()}>Retry</button></div>;
  const data = query.data;
  const state = data.automation;
  const enabled = source === 'STRATEGY' ? state.strategyEnabled : state.historyEnabled;
  const enabledAt = source === 'STRATEGY' ? state.strategyEnabledAt : state.historyEnabledAt;
  const active = state.trades.find(trade => trade.id === state.activeTradeId);
  const trades = state.trades.filter(trade => trade.source === source);
  const decisions = state.decisions.filter(decision => decision.source === source);
  const selectedCount = state.decisionCounts.find(row => row.source === source && row.code === 'SELECTED')?._count ?? 0;
  const missedCount = state.decisionCounts.filter(row => row.source === source && row.code !== 'SELECTED' && row.code !== 'SHARED_SIGNAL').reduce((sum, row) => sum + row._count, 0);
  return <section className="space-y-5">
    <form className="glass-card flex flex-wrap items-end gap-4 p-5" onSubmit={event => { event.preventDefault(); const values = new FormData(event.currentTarget); riskUpdate.mutate({ percent: Number(values.get('risk')), cap: Number(values.get('cap')) }); }}>
      <label className="text-xs text-slate-400">Real risk: % of available margin<input name="risk" type="number" required min="0.1" max="2" step="0.1" defaultValue={data.automation.riskPerTrade} className="mt-1 block rounded bg-slate-900 p-2 text-white" /></label>
      <label className="text-xs text-slate-400">Maximum planned loss / trade (₹)<input name="cap" type="number" required min="1" max="100000" defaultValue={data.automation.maximumRiskAmount} className="mt-1 block rounded bg-slate-900 p-2 text-white" /></label>
      <button disabled={riskUpdate.isPending} className="primary-button">Save real risk limits</button>
      <p className="w-full text-xs text-slate-400">Separate from demo settings. Both caps apply before submission; market gaps can exceed the planned stop risk. Saving limits does not enable real trading.</p>
      {riskUpdate.error && <p className="text-xs text-rose-300">{riskUpdate.error.message}</p>}
    </form>
    <div className="glass-card flex flex-wrap items-center justify-between gap-5 p-5">
      <div><p className="section-eyebrow">LIVE BROKER ACCOUNT · {pageName(source)}</p><h2 className="text-2xl font-black text-white">Real Trading</h2><p className="mt-2 text-sm text-slate-400">New live Target 1 hits only. One shared position across both pages.</p></div>
      <button type="button" role="switch" aria-checked={enabled} aria-label={`Real trading for ${pageName(source)}`} disabled={toggle.isPending || (!enabled && !data.connected)} onClick={() => toggle.mutate(!enabled)} className={`min-h-12 rounded-xl border px-6 font-black disabled:opacity-50 ${enabled ? 'border-emerald-400 bg-emerald-400/15 text-emerald-300' : 'border-slate-600 bg-slate-900 text-slate-300'}`}>{toggle.isPending ? 'Updating…' : enabled ? 'ON — Turn OFF' : 'OFF — Turn ON'}</button>
      <p className="w-full text-sm text-slate-400">Turning ON places real intraday market orders using available broker funds and margin. Turning OFF stops new entries from this page; running trades keep their Target 3, stop-loss and 3:25 pm exits.</p>
      {enabled && <p className="text-xs text-emerald-300">Accepting fresh hits after {time(enabledAt)}. Previous and busy-slot hits are skipped.</p>}
    </div>
    {(toggle.error || exit.error || query.error) && <p role="alert" className="rounded-xl bg-rose-500/10 p-4 text-rose-300">{(toggle.error || exit.error || query.error)?.message}</p>}
    {!!data.errors?.length && <p role="alert" className="rounded-xl bg-amber-400/10 p-4 text-amber-200">Broker data unavailable: {data.errors.join(' · ')}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[
      ['Available broker margin', money(data.funds.available)], ['Used margin', money(data.funds.margin)],
      ['Broker confirmation', state.stream.status], ['Confirmation path', state.stream.pollingFallback ? 'REST fallback active' : 'Live order stream'],
    ].map(([label, value]) => <div key={label} className="glass-card p-4"><p className="text-xs text-slate-400">{label}</p><p className="mt-2 text-xl font-bold text-white">{value}</p></div>)}</div>
    <p className="text-xs text-slate-400">The live broker stream confirms fills immediately when connected. REST polling remains active as a safety fallback. Stream reconnects: {state.stream.reconnects}{state.stream.lastMessageAt ? ` · Last update ${time(state.stream.lastMessageAt)}` : ''}.</p>
    <p className="text-sm text-slate-400">No fixed ₹10,000 allocation or assumed leverage. Sizing is capped by the configured monetary risk, available-margin risk percentage, and broker margin; 2% of margin is reserved for charges and price movement. When both switches are ON, the first eligible live hit received gets the shared slot.</p>
    <div className="glass-card p-5"><h3 className="font-bold text-white">Shared execution status</h3>{active ? <div className="mt-3 space-y-2 text-sm"><p>{active.symbol} · {active.side} · {pageName(active.source)} · {active.status}</p><p>Filled quantity: {active.quantity} · Entry: {money(active.entryPrice)} · Target 3: {money(active.target)} · Stop: {money(active.stopLoss)}</p>{active.error && <p role="alert" className="text-amber-300">{active.error}</p>}<p className="text-slate-400">The shared slot stays occupied until the broker confirms the order and position are closed.</p></div> : <p className="mt-3 text-sm text-slate-400">No managed position. {enabled ? 'Waiting for the next fresh eligible T1 hit.' : 'New entries from this page are OFF.'}</p>}</div>
    <div className="glass-card p-5"><h3 className="font-bold text-white">Broker open positions</h3><div className="mt-3 space-y-3">{data.positions.map(position => <div key={`${position.instrumentKey}:${position.product}`} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-700 p-4"><div><p className="font-bold">{position.symbol} · {position.side} · {position.quantity}</p><p className="mt-1 text-sm text-slate-400">Entry {money(position.averagePrice)} · Live {money(position.currentPrice)} · P&L {money(position.pnl)}</p></div><button disabled={exit.isPending} onClick={() => { if (window.confirm(`Exit ${position.symbol} at market?`)) exit.mutate({ key: position.instrumentKey, product: position.product }); }} className="rounded-lg border border-rose-400/40 px-4 py-2 text-rose-300">Manual Exit</button></div>)}{!data.positions.length && <p className="text-sm text-slate-400">No broker positions.</p>}</div></div>
    <div className="glass-card overflow-x-auto p-5"><h3 className="mb-3 font-bold text-white">{pageName(source)} · Real trade activity</h3><table className="w-full text-left text-xs"><thead className="text-slate-400"><tr>{['Stock / side', 'T1 time', 'Status', 'Quantity', 'Entry / exit', 'Reason / broker message'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{trades.map(trade => <tr key={trade.id} className="border-t border-slate-800"><td className="p-3">{trade.symbol} {trade.side}</td><td className="p-3">{time(trade.hitAt)}</td><td className="p-3">{trade.status}</td><td className="p-3">{trade.quantity}</td><td className="p-3">{money(trade.entryPrice)} / {money(trade.exitPrice)}</td><td className="max-w-md p-3">{trade.error || trade.exitReason || '—'}</td></tr>)}</tbody></table>{!trades.length && <p className="p-3 text-sm text-slate-400">No real trade activity from this page yet.</p>}</div>
    <div className="glass-card p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="font-bold text-white">Execution timing</h3><p className="mt-1 text-xs text-slate-400">Every milestone is measured from the exact T1 hit time.</p></div><p className="text-xs text-slate-400">{trades.length} recorded trade{trades.length === 1 ? '' : 's'}</p></div><div className="mt-4 space-y-4">{trades.slice(0, 10).map(trade => <div key={trade.id} className="rounded-xl border border-slate-700 p-4"><p className="font-bold text-white">{trade.symbol} · {trade.side} · {trade.status}</p><div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-3"><div className="rounded-lg bg-slate-950/40 p-3"><p className="text-xs text-cyan-300">T1 detected · +0 ms</p><p className="mt-1 text-xs text-slate-400">{time(trade.hitAt)}</p></div>{trade.events.map(event => <div key={event.id} className="rounded-lg bg-slate-950/40 p-3"><p className="text-xs text-cyan-300">{eventName(event.type)} · {delay(trade.hitAt, event.observedAt)}</p><p className="mt-1 text-xs text-slate-300">{event.detail}</p><p className="mt-1 text-[11px] text-slate-500">{event.origin} · {time(event.observedAt)}</p></div>)}</div></div>)}{!trades.length && <p className="text-sm text-slate-400">Timing appears after the next T1 decision.</p>}</div></div>
    <div className="glass-card overflow-x-auto p-5"><div className="flex flex-wrap items-end justify-between gap-3"><div><h3 className="font-bold text-white">Why each T1 was executed or missed</h3><p className="mt-1 text-xs text-slate-400">Today’s decision is stored at the moment each T1 is observed.</p></div><p className="text-xs text-slate-300">Selected {selectedCount} · Missed {missedCount}</p></div><table className="mt-3 w-full text-left text-xs"><thead className="text-slate-400"><tr>{['T1 time', 'Stock / side', 'Decision', 'Explanation', 'Observed'].map(label => <th key={label} className="p-3">{label}</th>)}</tr></thead><tbody>{decisions.map(decision => <tr key={decision.id} className="border-t border-slate-800"><td className="whitespace-nowrap p-3">{time(decision.hitAt)}</td><td className="p-3 font-semibold">{decision.symbol} {decision.side}</td><td className={`p-3 font-bold ${decision.code === 'SELECTED' ? 'text-emerald-300' : 'text-amber-300'}`}>{eventName(decision.code)}</td><td className="max-w-xl p-3">{decision.trade?.error || decision.reason}</td><td className="whitespace-nowrap p-3">{delay(decision.hitAt, decision.observedAt)}</td></tr>)}</tbody></table>{!decisions.length && <p className="p-3 text-sm text-slate-400">No T1 decisions recorded for this page today.</p>}</div>
    <div className="glass-card overflow-x-auto p-5"><h3 className="mb-3 font-bold text-white">Broker orders</h3><table className="w-full text-left text-xs"><thead><tr>{['Order', 'Stock', 'Side', 'Status', 'Quantity', 'Average fill'].map(label => <th className="p-3 text-slate-400" key={label}>{label}</th>)}</tr></thead><tbody>{data.orders.map(order => <tr key={order.orderId} className="border-t border-slate-800"><td className="p-3">{order.orderId}</td><td className="p-3">{order.symbol}</td><td className="p-3">{order.transactionType}</td><td className="p-3">{order.status}</td><td className="p-3">{order.quantity}</td><td className="p-3">{money(order.averagePrice)}</td></tr>)}</tbody></table></div>
  </section>;
}
