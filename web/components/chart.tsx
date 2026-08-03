'use client';

import { useEffect, useRef, useState } from 'react';
import type { UTCTimestamp } from 'lightweight-charts';

type Candle = { time: string; open: number; high: number; low: number; close: number; volume: number };
export type LiveChartTick = { ltp: number; timestamp: number; volume?: number | null };
export type ChartLevel = { price: number | null | undefined; label: string; color: string; lineStyle?: 0 | 1 | 2 | 3 | 4 };

type ChartCandle = Omit<Candle, 'time'> & { time: UTCTimestamp };

const toChartCandle = (candle: Candle): ChartCandle => ({ ...candle, time: Math.floor(new Date(candle.time).getTime() / 1000) as UTCTimestamp });
const volumePoint = (candle: ChartCandle) => ({ time: candle.time, value: candle.volume || 0, color: candle.close >= candle.open ? 'rgba(66, 211, 146, .45)' : 'rgba(251, 113, 133, .45)' });

export function PriceChart({ candles, levels = [], liveTick, timeframeMinutes }: { candles?: Candle[]; levels?: ChartLevel[]; liveTick?: LiveChartTick | null; timeframeMinutes?: number }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<any>(null);
  const priceRef = useRef<any>(null);
  const volumeRef = useRef<any>(null);
  const priceLinesRef = useRef<any[]>([]);
  const currentCandleRef = useRef<ChartCandle | null>(null);
  const cumulativeVolumeRef = useRef<number | null>(null);
  const chartReadyRef = useRef(false);
  const pendingTicksRef = useRef<LiveChartTick[]>([]);
  const websocketLoggedRef = useRef(false);
  const [mounted, setMounted] = useState(false);
  const [chartCreated, setChartCreated] = useState(false);
  useEffect(() => setMounted(true), []);

  const updateLiveCandle = (tick: LiveChartTick) => {
    if (!timeframeMinutes || !priceRef.current || !volumeRef.current || !currentCandleRef.current) {
      console.error('[Trading Chart] Live update failed after initialization: chart dependencies are missing');
      return;
    }
    const ltp = Number(tick.ltp);
    const rawTimestamp = Number(tick.timestamp);
    if (!Number.isFinite(ltp) || !Number.isFinite(rawTimestamp)) {
      console.error('[Trading Chart] Live update rejected: invalid WebSocket tick', tick);
      return;
    }
    const tickSeconds = Math.floor(rawTimestamp > 10_000_000_000 ? rawTimestamp / 1000 : rawTimestamp);
    const intervalSeconds = timeframeMinutes * 60;
    const candleTime = Math.floor(tickSeconds / intervalSeconds) * intervalSeconds as UTCTimestamp;
    const previous = currentCandleRef.current;
    if (Number(candleTime) < Number(previous.time)) return;

    const cumulativeVolume = tick.volume == null ? Number.NaN : Number(tick.volume);
    let addedVolume = 0;
    if (Number.isFinite(cumulativeVolume) && cumulativeVolume >= 0) {
      if (cumulativeVolumeRef.current !== null) addedVolume = Math.max(0, cumulativeVolume - cumulativeVolumeRef.current);
      cumulativeVolumeRef.current = cumulativeVolume;
    }
    const next: ChartCandle = candleTime === previous.time
      ? { ...previous, high: Math.max(previous.high, ltp), low: Math.min(previous.low, ltp), close: ltp, volume: previous.volume + addedVolume }
      : { time: candleTime, open: ltp, high: ltp, low: ltp, close: ltp, volume: addedVolume };
    try {
      currentCandleRef.current = next;
      priceRef.current.update(next);
      volumeRef.current.update(volumePoint(next));
      console.info('[Trading Chart] Live candle updated', { time: next.time, open: next.open, high: next.high, low: next.low, close: next.close });
    } catch (error) {
      console.error('[Trading Chart] series.update() failed:', error);
    }
  };

  useEffect(() => {
    if (!mounted) return;
    if (!host.current) {
      console.error('[Trading Chart] Chart creation failed: chart container does not exist');
      return;
    }
    let disposed = false;
    let creating = false;
    const validSize = (width: number, height: number) => Number.isFinite(width) && Number.isFinite(height) && width >= 1 && height >= 1;
    const create = (width: number, height: number) => {
      if (disposed || creating || chartRef.current || !host.current || !validSize(width, height)) return;
      creating = true;
      void import('lightweight-charts').then(({ CandlestickSeries, ColorType, HistogramSeries, createChart }) => {
        if (disposed || !host.current) return;
        const currentWidth = host.current.clientWidth;
        const currentHeight = host.current.clientHeight;
        if (!validSize(currentWidth, currentHeight)) {
          creating = false;
          return;
        }
        try {
          const chart = createChart(host.current, {
          width: currentWidth,
          height: currentHeight,
          layout: { background: { type: ColorType.Solid, color: '#101827' }, textColor: '#91a0b8' },
          grid: { vertLines: { color: '#22304a' }, horzLines: { color: '#22304a' } },
          crosshair: { mode: 1 },
          rightPriceScale: { borderColor: '#334155' },
          timeScale: { borderColor: '#334155', timeVisible: true },
        });
        console.info('[Trading Chart] Chart created');
        const price = chart.addSeries(CandlestickSeries, { upColor: '#42d392', downColor: '#fb7185', borderVisible: false, wickUpColor: '#42d392', wickDownColor: '#fb7185' });
        const volume = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false }, 1);
        console.info('[Trading Chart] Series created');
        chartRef.current = chart;
        priceRef.current = price;
        volumeRef.current = volume;
        setChartCreated(true);
        } catch (error) {
          creating = false;
          console.error('[Trading Chart] Chart or series creation failed:', error);
        }
      }).catch((error) => {
        creating = false;
        console.error('[Trading Chart] Chart library failed to load:', error);
      });
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect || !validSize(rect.width, rect.height)) return;
      if (!chartRef.current) {
        create(rect.width, rect.height);
        return;
      }
      chartRef.current.resize(rect.width, rect.height);
    });
    observer.observe(host.current);
    const initialRect = host.current.getBoundingClientRect();
    create(initialRect.width, initialRect.height);
    return () => {
      disposed = true;
      observer.disconnect();
      chartRef.current?.remove();
      chartRef.current = null;
      priceRef.current = null;
      volumeRef.current = null;
      chartReadyRef.current = false;
      setChartCreated(false);
    };
  }, [mounted]);

  useEffect(() => {
    if (!chartCreated) return;
    chartReadyRef.current = false;
    if (!priceRef.current || !volumeRef.current) {
      console.error('[Trading Chart] Historical render failed: candlestick or volume series does not exist');
      return;
    }
    if (!Array.isArray(candles)) {
      console.error('[Trading Chart] Historical data not loaded: candle API response is not available');
      return;
    }
    console.info('[Trading Chart] Candles received', candles.length);
    const values: ChartCandle[] = [];
    const seenTimes = new Set<number>();
    candles.forEach((candle, index) => {
      if (!candle || typeof candle !== 'object') {
        console.error(`[Trading Chart] Candle ${index} rejected: candle is not an object`, candle);
        return;
      }
      const value = toChartCandle(candle);
      const required = { time: value.time, open: value.open, high: value.high, low: value.low, close: value.close };
      if (!Number.isFinite(value.time)) {
        console.error(`[Trading Chart] Candle ${index} rejected: invalid time`, required);
        return;
      }
      if (![value.open, value.high, value.low, value.close].every(Number.isFinite)) {
        console.error(`[Trading Chart] Candle ${index} rejected: OHLC values must be finite numbers`, required);
        return;
      }
      if (value.high < Math.max(value.open, value.close, value.low) || value.low > Math.min(value.open, value.close, value.high)) {
        console.error(`[Trading Chart] Candle ${index} rejected: inconsistent OHLC range`, required);
        return;
      }
      if (seenTimes.has(Number(value.time))) {
        console.error(`[Trading Chart] Candle ${index} rejected: duplicate timestamp`, required);
        return;
      }
      seenTimes.add(Number(value.time));
      values.push({ ...value, volume: Number.isFinite(value.volume) && value.volume >= 0 ? value.volume : 0 });
    });
    values.sort((left, right) => Number(left.time) - Number(right.time));
    if (!values.length) {
      priceRef.current.setData([]);
      volumeRef.current.setData([]);
      currentCandleRef.current = null;
      console.error('[Trading Chart] Historical render stopped: no valid candles were returned');
      return;
    }
    try {
      priceRef.current.setData(values);
      volumeRef.current.setData(values.map(volumePoint));
      currentCandleRef.current = values.at(-1) ?? null;
      cumulativeVolumeRef.current = null;
      chartRef.current?.timeScale().fitContent();
      chartReadyRef.current = true;
      console.info('[Trading Chart] Candles rendered', values.length);
      const pendingTicks = pendingTicksRef.current;
      pendingTicksRef.current = [];
      for (const tick of pendingTicks) updateLiveCandle(tick);
    } catch (error) {
      chartReadyRef.current = false;
      console.error('[Trading Chart] setData() failed:', error);
    }
  }, [candles, chartCreated]);

  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;
    for (const line of priceLinesRef.current) price.removePriceLine(line);
    priceLinesRef.current = levels.filter((level) => Number.isFinite(level.price)).map((level) => price.createPriceLine({ price: Number(level.price), color: level.color, lineWidth: 1, lineStyle: level.lineStyle ?? 2, axisLabelVisible: true, title: level.label }));
  }, [levels, chartCreated]);

  useEffect(() => {
    if (!liveTick) return;
    if (!websocketLoggedRef.current) {
      websocketLoggedRef.current = true;
      console.info('[Trading Chart] WebSocket connected');
    }
    if (!chartReadyRef.current) {
      pendingTicksRef.current.push(liveTick);
      return;
    }
    updateLiveCandle(liveTick);
  }, [liveTick, timeframeMinutes]);

  return <div className="relative h-96 w-full">
    <div ref={host} className="h-full w-full" aria-label="Candlestick chart with volume" />
    {mounted && Array.isArray(candles) && candles.length === 0 && <div className="absolute inset-0 grid place-items-center bg-[#101827] muted">No candle data available</div>}
  </div>;
}
