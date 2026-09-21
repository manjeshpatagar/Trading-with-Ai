export type TargetOneReportRow = {
  id: string; symbol: string; stockName: string; side: string; entryPrice: number | null;
  target1Price: number | null; target1At: string | null; target1ObservedPrice: number | null;
  stopLossAt: string | null; stopLossHitPrice: number | null;
  completedAt: string | null; exitPrice: number | null; exitReason: string | null;
  profitPercent: number | null; outcome: string; minutesAfterTarget1: number | null;
  entryAt?: string; quantity?: number; currentPrice?: number; target2?: number | null; target3?: number | null; demoTarget?: number; stopLossLevel?: number;
  profitAmount?: number | null; durationMinutes?: number | null;
};
export type DemoDay = { date: string; rows: TargetOneReportRow[]; summary: TargetOneReport['summary'] };
export type TargetOneReport = {
  generatedAt: string;
  days?: DemoDay[];
  rows: TargetOneReportRow[];
  summary: { reachedTarget1: number; stocks: number; stopLossHits: number; completed: number; wins: number; losses: number; breakeven: number; running: number; unknown: number; trades?: number; realizedProfit?: number; realizedLoss?: number; realizedPnl?: number; unrealizedPnl?: number };
};

export type ReportFonts = { regular: string; bold: string };
const money = (value: number | null) => value === null || !Number.isFinite(value) ? '—' : value.toLocaleString('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dateLabel = (value: Date) => value.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });
const stamp = (value: string | null) => value ? `${dateLabel(new Date(value))}\n${new Date(value).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit' })}` : '—';

/** Draw actual PDF text and shapes, keeping every row legible across pages. */
export async function targetOneDocument(report: TargetOneReport, fonts: ReportFonts, demo = false) {
  const { jsPDF } = await import('jspdf');
  const date = new Date(report.generatedAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Refresh the results before downloading the report.');
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const start = new Date(`${day}T12:00:00+05:30`);
  start.setUTCDate(start.getUTCDate() - (demo ? 6 : 29));
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4', compress: true });
  pdf.addFileToVFS('ReportRegular.ttf', fonts.regular);
  pdf.addFont('ReportRegular.ttf', 'Report', 'normal');
  pdf.addFileToVFS('ReportBold.ttf', fonts.bold);
  pdf.addFont('ReportBold.ttf', 'Report', 'bold');
  const title = demo ? 'AI Signal History · Demo Trade Results' : 'After Target 1 · Trade Results';
  pdf.setProperties({ title, author: 'QuantPulse', subject: demo ? 'Seven days of recorded demo trade results by entry date' : 'Monthly AI Strategy results measured from Target 1' });
  const width = pdf.internal.pageSize.getWidth(), height = pdf.internal.pageSize.getHeight();
  const margin = 20, inner = width - margin * 2;
  const colors = { bg: '#0d1422', panel: '#090f1c', border: '#263348', text: '#f1f5f9', muted: '#94a3b8', green: '#5ee6b6', red: '#fda4af', cyan: '#a5f3fc' };
  const text = (value: string, x: number, y: number, size = 8, color = colors.text, bold = false) => {
    pdf.setFont('Report', bold ? 'bold' : 'normal'); pdf.setFontSize(size); pdf.setTextColor(color);
    pdf.text(value, x, y);
  };
  const widths = [136, 75, 116, 111, 67, 103, 65, 67, 62].map(w => w / 802 * inner);
  const labels = demo ? ['STOCK / SIDE / QTY', 'DEMO ENTRY / TIME', 'SIGNAL TARGETS / DEMO TARGET / SL', 'TARGET 1 REACHED', 'EXIT / CURRENT PRICE', 'EXIT TIME / REASON', 'RESULT', 'PROFIT / LOSS', 'TRADE DURATION'] : ['STOCK / SIDE', 'ORIGINAL ENTRY', 'TARGET 1 PRICE / REACH TIME', 'STOP-LOSS HIT / TIME', 'EXIT PRICE', 'EXIT / WIN TIME', 'RESULT FROM T1', 'RETURN FROM T1', 'T1 TO EXIT DURATION'];
  let y = 0;
  let section = '';
  let sectionSummary = '';
  const newPage = (first: boolean) => {
    if (!first) pdf.addPage();
    pdf.setFillColor(colors.bg); pdf.rect(0, 0, width, height, 'F');
    text(title, margin, 33, 16, colors.text, true);
    text(demo ? `${section || `${dateLabel(start)} – ${dateLabel(date)}`} · Demo entry dates · All times IST` : `${dateLabel(start)} – ${dateLabel(date)} · AI Strategy monthly queue · All times IST${first ? '' : ' · Continued'}`, margin, 50, 8, colors.muted);
    if (first) {
      text(demo ? 'Recorded demo execution P&L. Completed wins/losses and open unrealized P&L are reported separately.' : 'Win/loss starts at Target 1. BUY wins above T1; SELL wins below T1. Returns before fees.', margin, 67, 8, colors.cyan);
      const cards = [['Reached Target 1', 'reachedTarget1'], ['Stop loss after T1', 'stopLossHits'], ['Completed', 'completed'], ['Wins', 'wins'], ['Losses', 'losses'], ['Breakeven', 'breakeven'], ['Still running', 'running']] as const;
      const cardWidth = (inner - 6 * 7) / 7;
      cards.forEach(([label, key], index) => {
        const x = margin + index * (cardWidth + 7);
        pdf.setFillColor(colors.panel); pdf.setDrawColor(colors.border); pdf.setLineWidth(.5);
        pdf.roundedRect(x, 81, cardWidth, 45, 5, 5, 'FD');
        text(demo && key === 'stopLossHits' ? 'Stop-loss exits' : label, x + 8, 95, 7, colors.muted);
        text(String(report.summary[key]), x + 8, 116, 14, key === 'wins' ? colors.green : key === 'losses' ? colors.red : colors.text, true);
      });
      text(demo ? `All ${report.rows.length} demo trades · Realized profit ${money(report.summary.realizedProfit ?? 0)} · Realized loss ${money(report.summary.realizedLoss ?? 0)} · Net ${money(report.summary.realizedPnl ?? 0)}` : `${report.summary.reachedTarget1} trades across ${report.summary.stocks} stocks · Full report: all ${report.rows.length} trades included.`, margin, 144, 8, colors.muted);
      y = 155;
    } else {
      if (demo) text(sectionSummary, margin, 66, 7.5, colors.cyan);
      y = demo ? 80 : 64;
    }
    if (first && demo) return;
    pdf.setFillColor('#040919'); pdf.rect(margin, y, inner, 30, 'F');
    let x = margin;
    labels.forEach((label, index) => {
      pdf.setFont('Report', 'bold'); pdf.setFontSize(6.5);
      const lines: string[] = pdf.splitTextToSize(label, widths[index] - 12);
      text(lines.join('\n'), x + 6, y + 11, 6.5, colors.muted, true);
      x += widths[index];
    });
    y += 30;
  };
  newPage(true);
  if (demo) {
    text('DATE', margin + 6, 175, 8, colors.muted, true);
    const summaryX = [135, 205, 275, 345, 420, 510, 610, 705];
    ['TRADES', 'COMPLETED', 'WINS', 'LOSSES', 'RUNNING', 'PROFIT', 'LOSS', 'NET P&L'].forEach((label, i) => text(label, summaryX[i], 175, 7, colors.muted, true));
    (report.days ?? []).forEach((day, index) => {
      const baseline = 204 + index * 31;
      text(dateLabel(new Date(`${day.date}T12:00:00+05:30`)), margin + 6, baseline, 8);
      const d = day.summary;
      const values = [String(day.rows.length), String(d.completed), String(d.wins), String(d.losses), String(d.running), money(d.realizedProfit ?? 0), money(d.realizedLoss ?? 0), money(d.realizedPnl ?? 0)];
      values.forEach((value, i) => text(value, summaryX[i], baseline, 8, i === 2 || i === 5 ? colors.green : i === 3 || i === 6 ? colors.red : colors.text));
      pdf.setDrawColor(colors.border); pdf.line(margin, baseline + 12, width - margin, baseline + 12);
    });
    text(`Open unrealized P&L: ${money(report.summary.unrealizedPnl ?? 0)}. Excluded from completed wins/losses and net realized P&L.`, margin, 450, 8, colors.cyan);
    text('Today appears first in the detailed daily sections. Dates with no trades are included.', margin, 470, 8, colors.muted);
  }
  const groups = demo ? report.days ?? [] : [{ date: '', rows: report.rows, summary: report.summary }];
  for (const group of groups) {
    if (demo) {
      section = `${group.date === day ? 'Today · ' : ''}${dateLabel(new Date(`${group.date}T12:00:00+05:30`))}`;
      sectionSummary = `${group.rows.length} trades · ${group.summary.wins} wins · ${group.summary.losses} losses · ${group.summary.running} running · Realized ${money(group.summary.realizedPnl ?? 0)} · Unrealized ${money(group.summary.unrealizedPnl ?? 0)}`;
      newPage(false);
    }
  for (const row of group.rows) {
    const resultColor = row.outcome === 'WIN' ? colors.green : row.outcome === 'LOSS' ? colors.red : row.outcome === 'RUNNING' ? colors.cyan : colors.muted;
    const cells = demo ? [
      [`${row.symbol}  ${row.side}`, row.stockName, `Qty: ${row.quantity ?? '—'}`],
      [money(row.entryPrice), stamp(row.entryAt ?? null)],
      [`T1: ${money(row.target1Price)}`, `T2: ${money(row.target2 ?? null)}`, `T3: ${money(row.target3 ?? null)}`, `Demo: ${money(row.demoTarget ?? null)}`, `SL: ${money(row.stopLossLevel ?? null)}`],
      [stamp(row.target1At), ...(row.target1ObservedPrice !== null ? [`Observed: ${money(row.target1ObservedPrice)}`] : [])],
      [money(row.completedAt ? row.exitPrice : row.outcome === 'RUNNING' ? row.currentPrice ?? null : null), row.completedAt ? 'Exit price' : row.outcome === 'RUNNING' ? 'Last saved price' : 'Missing exit data'],
      [stamp(row.completedAt), row.exitReason ?? (row.outcome === 'UNKNOWN' ? 'Missing exit data' : 'Still running')], [row.outcome === 'UNKNOWN' ? 'Missing exit data' : row.outcome],
      [money(row.profitAmount ?? null), row.profitPercent === null ? '—' : `${row.profitPercent > 0 ? '+' : ''}${row.profitPercent.toFixed(2)}%`, row.outcome === 'UNKNOWN' ? 'Unclassified' : row.completedAt ? 'Realized' : 'Unrealized'],
      [row.durationMinutes == null ? '—' : `${row.durationMinutes.toFixed(1)} min`],
    ] : [
      [`${row.symbol}  ${row.side}`, row.stockName], [money(row.entryPrice)],
      [money(row.target1Price), stamp(row.target1At), ...(row.target1ObservedPrice !== null ? [`Observed: ${money(row.target1ObservedPrice)}`] : [])],
      row.stopLossAt ? [money(row.stopLossHitPrice), stamp(row.stopLossAt)] : ['Not hit after T1'],
      [money(row.exitPrice), row.exitReason ?? 'Still running'], [stamp(row.completedAt)],
      [row.outcome === 'UNKNOWN' ? 'Missing exit data' : row.outcome],
      [row.profitPercent === null ? '—' : `${row.profitPercent > 0 ? '+' : ''}${row.profitPercent.toFixed(2)}%`],
      [row.minutesAfterTarget1 === null ? '—' : `${row.minutesAfterTarget1.toFixed(1)} min`],
    ];
    const wrapped = cells.map((parts, index) => parts.map((part, partIndex) => {
      pdf.setFont('Report', partIndex === 0 ? 'bold' : 'normal'); pdf.setFontSize(7);
      return pdf.splitTextToSize(part, widths[index] - 12) as string[];
    }));
    const rowHeight = Math.max(48, ...wrapped.map(parts => parts.reduce((sum, lines) => sum + lines.length * 9 + 3, 0) + 14));
    if (y + rowHeight > height - 58) newPage(false);
    let x = margin;
    wrapped.forEach((parts, index) => {
      let baseline = y + 15;
      parts.forEach((lines, partIndex) => {
        const color = index === 6 || index === 7 ? resultColor : partIndex > 0 ? colors.muted : index === 2 ? colors.cyan : colors.text;
        text(lines.join('\n'), x + 6, baseline, 7, color, partIndex === 0 && index !== 5 && index !== 8);
        baseline += lines.length * 9 + 3;
      });
      x += widths[index];
    });
    y += rowHeight;
    pdf.setDrawColor(colors.border); pdf.setLineWidth(.4); pdf.line(margin, y, width - margin, y);
  }
  if (!group.rows.length) text(demo ? 'No demo trades were entered on this date.' : 'No trades in this reporting period have reached Target 1.', margin + 6, y + 25, 10, colors.muted);
  }
  const pageCount = pdf.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    pdf.setPage(page);
    text(demo ? 'Demo trades only. Grouped by entry date; results may close later. Target times come from the exact linked signal. — indicates missing data.' : 'Stop-loss touches may recover. Win time is the closing time. — indicates missing data. Tracked AI Strategy signal results.', margin, height - 38, 7, colors.muted);
    text(`Missing exit data: ${report.summary.unknown} · Results as of ${stamp(report.generatedAt).replace('\n', ', ')} IST`, margin, height - 25, 7, colors.muted);
    text(`QUANTPULSE · ${page} / ${pageCount}`, width - 125, height - 12, 7, colors.muted);
  }
  return { content: pdf.output('arraybuffer'), filename: `QuantPulse-${demo ? 'Signal-History-Demo' : 'Target1-Results'}-${day}.pdf`, pageCount };
}

let fontPromise: Promise<ReportFonts> | undefined;
async function loadFonts() {
  const base64 = async (path: string) => {
    const response = await fetch(path);
    if (!response.ok) throw new Error('Unable to load PDF fonts. Please try again.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    return btoa(binary);
  };
  if (!fontPromise) fontPromise = Promise.all([base64('/fonts/report-regular.ttf'), base64('/fonts/report-bold.ttf')])
    .then(([regular, bold]) => ({ regular, bold })).catch(error => { fontPromise = undefined; throw error; });
  return fontPromise;
}
export async function downloadTargetOneReport(report: TargetOneReport, demo = false) {
  const { content, filename } = await targetOneDocument(report, await loadFonts(), demo);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/pdf' }));
  const link = document.createElement('a'); link.href = url; link.download = filename;
  document.body.appendChild(link);
  try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30_000); }
}
