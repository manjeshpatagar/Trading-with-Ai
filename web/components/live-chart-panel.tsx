'use client';

import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { PriceChart } from './chart';

const RELIANCE = 'NSE_EQ|INE002A01018';
const intervals = [{ label: '1m', timeframe: '1m' }, { label: '3m', timeframe: '3m' }, { label: '5m', timeframe: '5m' }, { label: '15m', timeframe: '15m' }, { label: '30m', timeframe: '30m' }];

export function LiveChartPanel() { const [selected, setSelected] = useState(intervals[6]); const chart = useQuery({ queryKey: ['upstox-chart', RELIANCE, selected.timeframe], queryFn: () => api<{ candles: any[] }>(`/stocks/${encodeURIComponent(RELIANCE)}/chart?timeframe=${selected.timeframe}`), retry: false }); return <div><div className="mb-6 flex flex-wrap items-end justify-between gap-3"><div><p className="section-eyebrow">LIVE UPSTOX CHART</p><h1 className="text-3xl font-semibold">RELIANCE · NSE</h1></div><button onClick={() => chart.refetch()} className="primary-button"><RefreshCw className="h-4 w-4" />Refresh live candles</button></div><div className="glass-card overflow-hidden"><div className="flex flex-wrap gap-2 border-b border-white/[.06] p-3">{intervals.map((item) => <button onClick={() => setSelected(item)} key={item.label} className={`rounded-lg px-3 py-2 text-xs font-semibold ${selected.label === item.label ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:bg-white/[.05]'}`}>{item.label}</button>)}</div><div className="p-5">{chart.isLoading && <div className="grid h-96 place-items-center text-sm text-slate-500">Loading authenticated Upstox OHLC candles…</div>}{chart.isError && <div className="grid h-96 place-items-center text-sm text-rose-200">{chart.error.message}</div>}{chart.data && <PriceChart candles={chart.data.candles} />}</div></div></div>; }
