'use client';

import { Download } from 'lucide-react';
import { useState } from 'react';
import { api } from '../lib/api';
import { downloadTargetOneReport, type TargetOneReport } from '../lib/target-one-report';

export function DemoReportDownload({ session }: { session: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <section className="glass-card mb-5 flex flex-wrap items-center justify-between gap-3 p-4">
    <div><h2 className="font-bold text-white">Demo Trade PDF Report</h2><p className="mt-1 text-xs text-slate-400">Today + previous 6 days, grouped by entry date · Stock names, targets, Target 1 times, wins/losses and demo P&L · IST</p></div>
    <button type="button" disabled={!session || busy} className="primary-button disabled:cursor-not-allowed disabled:opacity-50" onClick={async () => {
      setBusy(true); setError('');
      try {
        const report = await api<TargetOneReport>('/signal-history-demo/report', { signal: AbortSignal.timeout(30_000) });
        await downloadTargetOneReport(report, true);
      } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to download the PDF. Please try again.'); }
      finally { setBusy(false); }
    }}><Download className="h-4 w-4" />{busy ? 'Preparing PDF…' : 'Download demo PDF'}</button>
    {error && <p role="alert" className="w-full text-sm text-rose-300">{error}</p>}
  </section>;
}
