'use client';
import { useEffect, useRef } from 'react';
import { CandlestickSeries, ColorType, HistogramSeries, LineSeries, createChart, type Time, type TickMarkType, type UTCTimestamp, type IChartApi, type ISeriesApi, type IPriceLine } from 'lightweight-charts';
import type { CandleResponse } from '../lib/nifty';
import type { ChartLevel } from './chart';
const axisDateFormatter = new Intl.DateTimeFormat('en-IN', {timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short'});
const axisTimeFormatter = new Intl.DateTimeFormat('en-IN', {timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
export function NiftyChart({ data, levels, enabled }: {
  data: CandleResponse | undefined;
  levels: ChartLevel[];
  enabled: string[];
}) {
  const host = useRef<HTMLDivElement>(null), chart = useRef<IChartApi | null>(null), price = useRef<ISeriesApi<'Candlestick'> | null>(null), volume = useRef<ISeriesApi<'Histogram'> | null>(null), lines = useRef<Record<string, ISeriesApi<'Line'>>>({}), priceLines = useRef<IPriceLine[]>([]), fitted = useRef(false);
  useEffect(() => { if (!host.current)
    return; const c = createChart(host.current, { height: 400, width: host.current.clientWidth, layout: { background: { type: ColorType.Solid, color: '#101827' }, textColor: '#94a3b8' }, grid: { vertLines: { color: '#1e293b' }, horzLines: { color: '#1e293b' } }, timeScale: { timeVisible: true, tickMarkFormatter: (value: Time, tickType: TickMarkType) => typeof value === 'number' ? (tickType <= 2 ? axisDateFormatter : axisTimeFormatter).format(new Date(value * 1000)) : null }, localization: { timeFormatter: (t: number | string | {
        year: number;
        month: number;
        day: number;
      }) => typeof t === 'number' ? new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }).format(new Date(t * 1000)) : String(t) } }); chart.current = c; price.current = c.addSeries(CandlestickSeries, { upColor: '#34d399', downColor: '#fb7185', borderVisible: false, wickUpColor: '#34d399', wickDownColor: '#fb7185' }); volume.current = c.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume' }, 1); for (const [key, color] of Object.entries({ ema20: '#60a5fa', ema50: '#a78bfa', vwap: '#fbbf24' }))
    lines.current[key] = c.addSeries(LineSeries, { color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }); const observer = new ResizeObserver(() => { if (host.current)
    c.resize(host.current.clientWidth, 400); }); observer.observe(host.current); return () => { observer.disconnect(); c.remove(); chart.current = null; price.current = null; volume.current = null; lines.current = {}; priceLines.current = []; fitted.current = false; }; }, []);
  useEffect(() => { const time = (v: string) => Math.floor(Date.parse(v) / 1000) as UTCTimestamp; price.current?.setData((data?.candles ?? []).map(c => ({ ...c, time: time(c.time) }))); volume.current?.setData((data?.candles ?? []).map(c => ({ time: time(c.time), value: c.volume, color: c.close >= c.open ? '#34d39970' : '#fb718570' }))); for (const [key, line] of Object.entries(lines.current))
    line.setData((data?.overlays[key] ?? []).map(p => ({ time: time(p.time), value: p.value }))); if (!fitted.current && data?.candles.length) {
    chart.current?.timeScale().fitContent();
    fitted.current = true;
  } }, [data]);
  useEffect(() => { volume.current?.applyOptions({ visible: enabled.includes('volume') }); for (const [key, line] of Object.entries(lines.current))
    line.applyOptions({ visible: enabled.includes(key) }); }, [enabled]);
  useEffect(() => { if (!price.current)
    return; for (const line of priceLines.current)
    price.current.removePriceLine(line); priceLines.current = levels.filter(l => typeof l.price === 'number' && Number.isFinite(l.price)).map(l => price.current!.createPriceLine({ price: l.price as number, color: l.color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.label })); }, [levels]);
  return <div className="relative"><div ref={host} className="h-[400px] w-full" aria-label="Nifty candlestick chart in Asia/Kolkata with indicators and trade levels"/>{!data?.candles.length && <div className="absolute inset-0 grid place-items-center text-sm text-slate-400">Waiting for broker candles</div>}</div>;
}
