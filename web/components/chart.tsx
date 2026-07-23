'use client';

import { useEffect, useRef, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };
export type ChartLevel = { price: number | null | undefined; label: string; color: string; lineStyle?: 0 | 1 | 2 | 3 | 4 };

export function PriceChart({ candles, levels = [] }: { candles?: Candle[]; levels?: ChartLevel[] }) {
  const host = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!mounted || !host.current) return;
    let disposed = false;
    let remove = () => undefined;
    void import('lightweight-charts').then(({ CandlestickSeries, ColorType, HistogramSeries, createChart }) => {
      if (disposed || !host.current) return;
      const chart = createChart(host.current, {
        width: host.current.clientWidth,
        height: 380,
        layout: { background: { type: ColorType.Solid, color: '#101827' }, textColor: '#91a0b8' },
        grid: { vertLines: { color: '#22304a' }, horzLines: { color: '#22304a' } },
        crosshair: { mode: 1 },
        rightPriceScale: { borderColor: '#334155' },
        timeScale: { borderColor: '#334155', timeVisible: true },
      });
      const price = chart.addSeries(CandlestickSeries, { upColor: '#42d392', downColor: '#fb7185', borderVisible: false, wickUpColor: '#42d392', wickDownColor: '#fb7185' });
      const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false }, 1);
      const values = (Array.isArray(candles) ? candles : []).map((candle) => ({ ...candle, time: Math.floor(new Date(candle.time).getTime() / 1000) as UTCTimestamp })).filter((candle) => Number.isFinite(candle.time) && [candle.open, candle.high, candle.low, candle.close].every(Number.isFinite));
      price.setData(values);
      levels.filter((level) => Number.isFinite(level.price)).forEach((level) => price.createPriceLine({ price: Number(level.price), color: level.color, lineWidth: 1, lineStyle: level.lineStyle ?? 2, axisLabelVisible: true, title: level.label }));
      volume.setData(values.map((candle) => ({ time: candle.time, value: candle.volume || 0, color: candle.close >= candle.open ? 'rgba(66, 211, 146, .45)' : 'rgba(251, 113, 133, .45)' })));
      chart.timeScale().fitContent();
      const observer = new ResizeObserver((entries) => chart.applyOptions({ width: entries[0].contentRect.width }));
      observer.observe(host.current);
      remove = () => { observer.disconnect(); chart.remove(); };
    });
    return () => { disposed = true; remove(); };
  }, [candles, levels, mounted]);

  if (!mounted) return <div className="h-96" aria-label="Loading candlestick chart" />;
  if (!candles?.length) return <div className="h-96 grid place-items-center muted">No candle data is available for this instrument.</div>;
  return <div ref={host} className="h-96 w-full" aria-label="Candlestick chart with volume" />;
}
