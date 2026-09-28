"use client";

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api';
import { Download } from 'lucide-react';
import { downloadTargetOneReport, type TargetOneReport as Report } from '../lib/target-one-report';

const price = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const stamp = (value: string | null) => value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const tone = (outcome: string) => outcome === 'WIN' ? 'text-emerald-300' : outcome === 'LOSS' ? 'text-rose-300' : outcome === 'RUNNING' ? 'text-cyan-300' : 'text-slate-300';

export function TargetOneAnalysis({ session }: { session: string }) {
  const [filter, setFilter] = useState('ALL');
  const [downloadError, setDownloadError] = useState('');
  const [downloading, setDownloading] = useState(false);
  const report = useQuery({
    queryKey: ['strategy-target-one-analysis', session, 'month'],
    queryFn: () => api<Report>('/strategy-target-one-analysis'),
    enabled: Boolean(session), refetchInterval: 30_000, refetchIntervalInBackground: true,
  });
  const data = report.data;
  const rows = (data?.rows ?? []).filter(row => filter === 'ALL' || (filter === 'STOP_LOSS' ? Boolean(row.stopLossAt) : row.outcome === filter));
  const cards = [
    ['Reached Target 1', 'reachedTarget1'], ['Stop loss after T1', 'stopLossHits'], ['Completed', 'completed'],
    ['Wins', 'wins'], ['Losses', 'losses'], ['Breakeven', 'breakeven'], ['Still running', 'running'],
  ] as const;
  return <section className="glass-card mt-6 p-5" aria-labelledby="target-one-analysis-heading">
    <div className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <h2 id="target-one-analysis-heading" className="text-xl font-black text-white">After Target 1 · Trade Results</h2>
        <p className="mt-2 text-xs text-slate-400">Last 30 days, including today · Saved AI Strategy results after Target 1 · Results remain after rankings change · All times IST.</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
      <button type="button" disabled={!data || report.isError || downloading} title="Download all results as a styled PDF" className="primary-button disabled:cursor-not-allowed disabled:opacity-50" onClick={async () => {
        if (!data) return;
        setDownloadError('');
        setDownloading(true);
        try { await downloadTargetOneReport(data); }
        catch (error) { setDownloadError(error instanceof Error ? error.message : 'Unable to download the report. Please try again.'); }
        finally { setDownloading(false); }
      }}><Download className="h-4 w-4" /> {downloading ? 'Preparing PDF…' : 'Download PDF'}</button>
      <label className="text-xs text-slate-400">Show trades <select aria-label="Filter Target 1 results" value={filter} onChange={event => setFilter(event.target.value)} className="ml-2 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-slate-200">
        {[['ALL', 'All results'], ['STOP_LOSS', 'Stop loss after T1'], ['WIN', 'Wins'], ['LOSS', 'Losses'], ['BREAKEVEN', 'Breakeven'], ['RUNNING', 'Still running'], ['UNKNOWN', 'Missing exit data']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      </div>
    </div>
    <p className="mt-3 text-sm text-cyan-200">Win/loss starts at the Target 1 level. BUY wins when the final exit is above T1; SELL wins when it is below T1.</p>
    {downloadError && <p role="alert" className="mt-3 text-sm text-rose-300">{downloadError}</p>}
    {report.isLoading && <p className="mt-5 text-sm text-slate-400">Loading Target 1 trade results…</p>}
    {report.isError && <p role="alert" className="mt-5 text-sm text-rose-300">Unable to load Target 1 results. {report.error.message}</p>}
    {data && <>
      <div className="my-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">{cards.map(([label, key]) => <div key={key} className="rounded-xl border border-slate-800 bg-slate-950/40 p-3">
        <p className="text-xs text-slate-400">{label}</p><p className={`mt-2 text-xl font-black ${key === 'wins' ? 'text-emerald-300' : key === 'losses' ? 'text-rose-300' : 'text-white'}`}>{data.summary[key]}</p>
      </div>)}</div>
      <p className="mb-3 text-xs text-slate-400">{data.summary.reachedTarget1} trades across {data.summary.stocks} stocks reached T1. Showing {rows.length} trades. Summary counts include all results.</p>
      <div className="max-h-[640px] overflow-auto"><table className="w-full min-w-[1250px] text-left text-sm">
        <thead className="sticky top-0 z-10 border-b border-slate-700 bg-slate-950 text-xs uppercase text-slate-400"><tr>{['Stock / Side', 'Original entry', 'Target 1 price / Reach time', 'Stop-loss hit price / Time', 'Exit price', 'Exit / Win time', 'Result from T1', 'Return from T1', 'T1 → Exit duration'].map(label => <th key={label} scope="col" className="px-3 py-3">{label}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} className="border-b border-slate-800 align-top">
          <td className="px-3 py-4"><p className="font-bold text-white">{row.symbol} <span className={`ml-1 text-xs ${row.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}>{row.side}</span></p><p className="mt-1 max-w-48 text-xs text-slate-500">{row.stockName}</p></td>
          <td className="px-3 py-4 text-slate-300">{price(row.entryPrice)}</td>
          <td className="px-3 py-4"><p className="font-bold text-cyan-200">{price(row.target1Price)}</p><p className="mt-1 whitespace-nowrap text-xs text-slate-400">{stamp(row.target1At)}</p>{row.target1ObservedPrice !== null && <p className="mt-1 text-xs text-slate-500">Observed: {price(row.target1ObservedPrice)}</p>}</td>
          <td className="px-3 py-4"><p className={row.stopLossAt ? 'font-bold text-amber-200' : 'text-slate-500'}>{row.stopLossAt ? price(row.stopLossHitPrice) : 'Not hit after T1'}</p>{row.stopLossAt && <p className="mt-1 whitespace-nowrap text-xs text-slate-400">{stamp(row.stopLossAt)}</p>}</td>
          <td className="px-3 py-4"><p className="font-bold text-white">{price(row.exitPrice)}</p><p className="mt-1 text-xs text-slate-500">{row.exitReason ?? 'Still running'}</p></td>
          <td className="whitespace-nowrap px-3 py-4 text-xs text-slate-300">{stamp(row.completedAt)}</td>
          <td className={`px-3 py-4 font-bold ${tone(row.outcome)}`}>{row.outcome === 'UNKNOWN' ? 'Missing exit data' : row.outcome}</td>
          <td className={`px-3 py-4 font-bold ${tone(row.outcome)}`}>{row.profitPercent === null ? '—' : `${row.profitPercent > 0 ? '+' : ''}${row.profitPercent.toFixed(2)}%`}</td>
          <td className="px-3 py-4 text-slate-300">{row.minutesAfterTarget1 === null ? '—' : `${row.minutesAfterTarget1.toFixed(1)} min`}</td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <p className="py-8 text-center text-sm text-slate-400">{data.rows.length ? 'No trades match this filter.' : 'No saved strategy results in the last 30 days have reached Target 1.'}</p>}
      <p className="mt-4 text-xs text-slate-500">Updates every 30 seconds. Stop-loss hits count recorded touches or confirmed stops after T1; a touch may recover without closing. Wins/losses use the final exit versus the T1 level, before fees. Win time is the recorded closing time. Missing prices or times display —.{data.summary.unknown > 0 ? ` ${data.summary.unknown} completed trades have missing exit data and are excluded from wins/losses.` : ''}</p>
    </>}
  </section>;
}
