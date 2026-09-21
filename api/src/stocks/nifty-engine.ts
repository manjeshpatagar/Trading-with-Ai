import { EMA, ATR } from 'technicalindicators';
import type { Candle } from './indicator.service';
export const NIFTY_KEY = 'NSE_INDEX|Nifty 50';
export const strategies = ['TREND_PULLBACK', 'BREAKOUT_RETEST', 'VWAP_RECLAIM_REJECTION', 'RANGE_REVERSAL'] as const;
export type Strategy = typeof strategies[number];
export const defaults = { primaryTimeframe: 15, setupTimeframe: 5, confirmationTimeframe: 3, openingRangeMinutes: 15, minimumScore: 70, minimumRR: 1.5, riskPercent: .5, dailyLossPercent: 1.5, maxTrades: 5, maxConsecutiveLosses: 3, capital: 10000, cutoff: '15:00', squareOff: '15:20', windows: [['09:30', '11:30'], ['13:30', '15:00']], staleMs: 15000, maximumSpreadPercent: 2, minimumOptionVolume: 1000, minimumVolumeRatio: 1.1, safetyBuffer: 5, minimumLevelDistance: 20, minimumSamples: 30, requireHistoricalPerformance: false, moveToBreakeven: true, trailAfterT2: true, strikeOffset: 0, expiryMinimumDays: 0, optionStopPercent: 20, optionTargetR: 3, enabledStrategies: [...strategies] as Strategy[] };
export type Settings = typeof defaults;
// NSE's modern trading calendar uses IST (UTC+05:30), without daylight saving.
const IST_OFFSET = 330 * 60000;
export function exchangeDate(at: Date) { return new Date(at.getTime()+IST_OFFSET).toISOString().slice(0,10); }
export function exchangeTime(at: Date) { return new Date(at.getTime()+IST_OFFSET).toISOString().slice(11,16); }
export function bucket(timestamp: number, interval: number) {
  const day=Math.floor((timestamp+IST_OFFSET)/86400000);
  const anchor=day*86400000-IST_OFFSET+(9*60+15)*60000;
  return anchor+Math.floor((timestamp-anchor)/(interval*60000))*interval*60000;
}
export function aggregate(candles: Candle[], interval: number): Candle[] {
  const rows = new Map<number, Candle>();
  for (const c of [...candles].sort((a,b)=>Date.parse(a.time)-Date.parse(b.time))) {
    const t = bucket(Date.parse(c.time), interval);
    const old = rows.get(t);
    if (old) {
      old.high = Math.max(old.high, c.high);
      old.low = Math.min(old.low, c.low);
      old.close = c.close;
      old.volume += c.volume;
    }
    else
      rows.set(t, { ...c, time: new Date(t).toISOString() });
  }
  return [...rows.values()].sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}
export function indicators(candles: Candle[]) {
  const closes = candles.map(c => c.close);
  const ema20 = EMA.calculate({ period: 20, values: closes }).at(-1) ?? null;
  const ema50 = EMA.calculate({ period: 50, values: closes }).at(-1) ?? null;
  const latestDate = exchangeDate(new Date(candles.at(-1)?.time ?? 0));
  const today = candles.filter(c => exchangeDate(new Date(c.time)) === latestDate);
  const volume = today.reduce((s, c) => s + c.volume, 0);
  const vwap = volume > 0 ? today.reduce((s, c) => s + (c.high + c.low + c.close) / 3 * c.volume, 0) / volume : null;
  const recent = candles.slice(-20, -1);
  const averageVolume = recent.length ? recent.reduce((s, c) => s + c.volume, 0) / recent.length : 0;
  const swingsHigh: number[] = [], swingsLow: number[] = [];
  let swingHighTime: string | null = null, swingLowTime: string | null = null;
  for (let i = Math.max(2, candles.length - 40); i < candles.length - 2; i++) {
    const c = candles[i];
    const neighbors = [candles[i - 2], candles[i - 1], candles[i + 1], candles[i + 2]];
    if (neighbors.every(n => c.high > n.high)) { swingsHigh.push(c.high); swingHighTime=c.time; }
    if (neighbors.every(n => c.low < n.low)) { swingsLow.push(c.low); swingLowTime=c.time; }
  }
  const bullishStructure = swingsHigh.length >= 2 && swingsLow.length >= 2 && swingsHigh.at(-1)! > swingsHigh.at(-2)! && swingsLow.at(-1)! > swingsLow.at(-2)!;
  const bearishStructure = swingsHigh.length >= 2 && swingsLow.length >= 2 && swingsHigh.at(-1)! < swingsHigh.at(-2)! && swingsLow.at(-1)! < swingsLow.at(-2)!;
  const last = candles.at(-1);
  const momentum = last && candles.length > 3 ? last.close - candles.at(-4)!.close : 0;
  const bull = !!last && ema20 !== null && ema50 !== null && last.close > ema20 && ema20 > ema50 && bullishStructure && momentum > 0;
  const bear = !!last && ema20 !== null && ema50 !== null && last.close < ema20 && ema20 < ema50 && bearishStructure && momentum < 0;
  const volumeRatio = averageVolume > 0 ? (last?.volume ?? 0) / averageVolume : 0;
  return { swingHighTime, swingLowTime, ema20, ema50, vwap, volumeRatio, volumeAvailable: volume > 0, momentum, bullishStructure, bearishStructure, swingHigh: swingsHigh.at(-1) ?? null, swingLow: swingsLow.at(-1) ?? null, atr: ATR.calculate({ period: 14, high: candles.map(c => c.high), low: candles.map(c => c.low), close: closes }).at(-1) ?? null, direction: bull ? 'BULLISH' : bear ? 'BEARISH' : 'RANGE', regime: bull ? (volumeRatio >= 1.2 ? 'STRONG BULLISH' : 'BULLISH') : bear ? (volumeRatio >= 1.2 ? 'STRONG BEARISH' : 'BEARISH') : 'RANGE' };
}
export function keyLevels(candles: Candle[], at: Date, s: Settings) {
  const days = [...new Set(candles.map(c => exchangeDate(new Date(c.time))))].filter(d => d < exchangeDate(at));
  const previous = candles.filter(c => exchangeDate(new Date(c.time)) === days.at(-1));
  const today = candles.filter(c => exchangeDate(new Date(c.time)) === exchangeDate(at));
  const end = new Date(`${exchangeDate(at)}T09:15:00+05:30`).getTime() + s.openingRangeMinutes * 60000;
  const opening = today.filter(c => Date.parse(c.time) < end);
  const i = indicators(aggregate(candles, 5));
  const high = (r: Candle[]) => r.length ? Math.max(...r.map(c => c.high)) : null;
  const low = (r: Candle[]) => r.length ? Math.min(...r.map(c => c.low)) : null;
  return { previousDayHigh: high(previous), previousDayLow: low(previous), previousClose: previous.at(-1)?.close ?? null, open: today[0]?.open ?? null, openingRangeHigh: high(opening), openingRangeLow: low(opening), openingRangeComplete: at.getTime() >= end && opening.length >= s.openingRangeMinutes, support: i.swingLow, resistance: i.swingHigh, swingHigh: i.swingHigh, swingLow: i.swingLow, vwap: i.vwap };
}
export function tradeLevels(entry: number, reference: number, side: 'BUY' | 'SELL', buffer: number) { const sign = side === 'BUY' ? 1 : -1; const stopLoss = reference - sign * buffer; const risk = (entry - stopLoss) * sign; return { entry, stopLoss, risk, target1: entry + sign * risk, target2: entry + sign * risk * 2, target3: entry + sign * risk * 3, riskReward: 2 }; }
export function positionSize(capital: number, riskPercent: number, premium: number, riskPerUnit: number, lotSize: number) { if (![capital, riskPercent, premium, riskPerUnit, lotSize].every(v => Number.isFinite(v) && v > 0) || !Number.isInteger(lotSize))
  return 0; return Math.max(0, Math.floor(Math.min(capital * riskPercent / 100 / riskPerUnit, capital / premium) / lotSize) * lotSize); }
export type Check = {
  name: string;
  pass: boolean;
  reason: string;
  weight: number;
  required?: boolean;
  available?: boolean;
};
export function evaluate(strategy: Strategy, candles: Candle[], at: Date, s: Settings) {
  return evaluateWithInputs(strategy,candles,at,s,calculateInputs(candles,at,s));
}
export function evaluateAll(candles:Candle[],at:Date,s:Settings) {
  const inputs=calculateInputs(candles,at,s);
  return strategies.map(strategy=>evaluateWithInputs(strategy,candles,at,s,inputs));
}
function evaluateWithInputs(strategy:Strategy,candles:Candle[],at:Date,s:Settings,inputs:ReturnType<typeof calculateInputs>) {
  if (strategy !== 'TREND_PULLBACK') {
    const bullish=evaluateSide(strategy,candles,at,s,true,inputs);
    if(strategy==='VWAP_RECLAIM_REJECTION' && !bullish.available) return bullish;
    const choices = [bullish, evaluateSide(strategy, candles, at, s, false,inputs)];
    return choices.sort((a,b) => Number(b.valid)-Number(a.valid) || Number(b.checks.find(c=>c.name==='Setup quality')?.pass)-Number(a.checks.find(c=>c.name==='Setup quality')?.pass) || b.score-a.score)[0];
  }
  return evaluateSide(strategy, candles, at, s,undefined,inputs);
}
function calculateInputs(candles: Candle[], at: Date, s: Settings) {
  const c15=completeCandles(candles,s.primaryTimeframe,at),c5=completeCandles(candles,s.setupTimeframe,at),c3=completeCandles(candles,s.confirmationTimeframe,at);
  return {c15,c5,c3,a:indicators(c15),b:indicators(c5),c:indicators(c3),levels:keyLevels(candles,at,s)};
}
function evaluateSide(strategy: Strategy, candles: Candle[], at: Date, s: Settings, forcedLong: boolean | undefined, inputs:ReturnType<typeof calculateInputs>) {
  const {c15,c5,c3,a,b,c,levels}=inputs;
  const long = forcedLong ?? a.direction === 'BULLISH';
  const sign = long ? 1 : -1;
  const side: 'BUY' | 'SELL' = long ? 'BUY' : 'SELL';
  const last = c5.at(-1), confirm = c3.at(-1);
  const prior = c5.slice(-8, -1);
  const tolerance = Math.max(s.safetyBuffer, (b.atr ?? 0) * .25);
  const resistance = [levels.previousDayHigh, levels.openingRangeHigh, levels.resistance].filter((v): v is number => v !== null);
  const supports = [levels.previousDayLow, levels.openingRangeLow, levels.support].filter((v): v is number => v !== null);
  let setupAnchor = last?.time ?? 'missing';
  let level: number | null = null, setup = false, breakout = false, retest = false;
  if (last && confirm) {
    if (strategy === 'TREND_PULLBACK') {
      const refs = [b.ema20, b.vwap, long ? levels.support : levels.resistance].filter((v): v is number => v !== null);
      level = refs.find(v => long ? last.low <= v + tolerance && last.close > v : last.high >= v - tolerance && last.close < v) ?? null;
      retest = level !== null;
      setup = retest && (long ? b.bullishStructure : b.bearishStructure);
      if (setup) {
        const episode=c5.slice(-8).reverse();
        for(const bar of episode) {
          if (!refs.some(v=>long ? bar.low<=v+tolerance && bar.close>v : bar.high>=v-tolerance && bar.close<v)) break;
          setupAnchor=bar.time;
        }
        setupAnchor=(long ? b.swingLowTime : b.swingHighTime) ?? setupAnchor;
      }
    }
    if (strategy === 'RANGE_REVERSAL' && a.direction === 'RANGE') {
      level = (long ? supports : resistance).find(v=>retestHolds(last,v,long,tolerance)) ?? null;
      retest = level !== null;
      setup = retest && (last.close-last.open)*sign>0;
    }
    if (strategy === 'BREAKOUT_RETEST') {
      for (const v of long ? resistance : supports) {
        const idx = breakoutIndex(prior, v, long, 0);
        if (idx >= 0 && Math.abs(v - (long ? levels.support ?? v - s.minimumLevelDistance : levels.resistance ?? v + s.minimumLevelDistance)) >= s.minimumLevelDistance) {
          breakout = true;
          setupAnchor = prior[idx].time;
          level = v;
          retest = retestHolds(last, v, long, tolerance);
          setup = retest;
          if (setup)
            break;
        }
      }
    }
    if (strategy === 'VWAP_RECLAIM_REJECTION' && b.vwap !== null) {
      const v = b.vwap;
      level = v;
      const past = c5.slice(0, -1);
      const cross = vwapCrossIndex(prior.map(x => ({ close: x.close, vwap: indicators(past.slice(0, past.indexOf(x) + 1)).vwap })), long);
      breakout = cross >= 0;
      if (cross >= 0)
        setupAnchor = prior[cross].time;
      retest = retestHolds(last, v, long, tolerance);
      setup = breakout && retest;
    }
  }
  const previousConfirmation = c3.at(-2);
  const confirmationPattern = !!confirm && !!previousConfirmation && (long ? (confirm.close > previousConfirmation.high || (confirm.low > previousConfirmation.low && confirm.close > confirm.open) || (confirm.open <= previousConfirmation.close && confirm.close >= previousConfirmation.open && previousConfirmation.close < previousConfirmation.open)) : (confirm.close < previousConfirmation.low || (confirm.high < previousConfirmation.high && confirm.close < confirm.open) || (confirm.open >= previousConfirmation.close && confirm.close <= previousConfirmation.open && previousConfirmation.close > previousConfirmation.open)));
  const confirmation = confirmationPattern && !!confirm && !!last && Date.parse(confirm.time)+s.confirmationTimeframe*60000 >= Date.parse(last.time)+s.setupTimeframe*60000 && ((confirm.close - confirm.open) * sign > 0) && (long ? confirm.close > (confirm.high + confirm.low) / 2 : confirm.close < (confirm.high + confirm.low) / 2);
  const entry = confirm ? (long ? confirm.high : confirm.low) + sign * s.safetyBuffer : null;
  const reference = last && confirm ? (long ? Math.min(last.low, confirm.low) : Math.max(last.high, confirm.high)) : null;
  const trade = entry !== null && reference !== null ? tradeLevels(entry, reference, side, s.safetyBuffer) : null;
  const nextLevel = trade ? (long ? resistance.filter(v => v > trade.entry).sort((x, y) => x - y)[0] : supports.filter(v => v < trade.entry).sort((x, y) => y - x)[0]) : undefined;
  const rr = !!trade && trade.entry > 0 && trade.stopLoss > 0 && trade.target3 > 0 && trade.risk > 0 && trade.risk <= (b.atr ?? 0) * 3 && trade.riskReward >= s.minimumRR && (nextLevel === undefined || Math.abs(nextLevel - trade.entry) >= trade.risk * s.minimumRR);
  const available = strategy !== 'VWAP_RECLAIM_REJECTION' || b.vwap !== null;
  const structure = strategy === 'TREND_PULLBACK' ? (long ? a.bullishStructure : a.bearishStructure) : setup;
  const checks: Check[] = [
    { name: 'Market regime', pass: strategy === 'RANGE_REVERSAL' ? a.direction === 'RANGE' : strategy === 'TREND_PULLBACK' ? a.direction === (long ? 'BULLISH' : 'BEARISH') : a.direction === 'RANGE' || a.direction === (long ? 'BULLISH' : 'BEARISH'), required: strategy === 'TREND_PULLBACK' || strategy === 'RANGE_REVERSAL', reason: `15M ${a.regime}; momentum ${a.momentum.toFixed(2)}`, weight: 20 },
    { name: 'Price structure', pass: structure, required: true, reason: `15M HH/HL ${a.bullishStructure}; LH/LL ${a.bearishStructure}; reference ${level?.toFixed(2) ?? 'missing'}`, weight: 20 },
    { name: 'Setup quality', pass: setup, required: true, reason: `5M ${last?.time ?? 'missing'}; break/reclaim ${breakout}; retest ${retest}; level ${level?.toFixed(2) ?? 'missing'}`, weight: 20 },
    { name: 'Entry confirmation', pass: confirmation, required: true, reason: `Closed 3M ${confirm?.time ?? 'missing'}; directional pattern ${confirmationPattern}; close ${confirm?.close ?? 'missing'}`, weight: 15 },
    { name: 'VWAP', pass: !!confirm && b.vwap !== null && (confirm.close - b.vwap) * sign > 0, required: strategy === 'VWAP_RECLAIM_REJECTION', available: b.vwap !== null, reason: `5M session VWAP ${b.vwap?.toFixed(2) ?? 'N/A: no traded volume'}`, weight: 10 },
    { name: 'Volume', pass: b.volumeRatio >= s.minimumVolumeRatio, available: b.volumeAvailable, reason: b.volumeAvailable ? `5M relative volume ${b.volumeRatio.toFixed(2)}` : 'N/A: index traded volume unavailable', weight: 5 },
    { name: 'Key level', pass: level !== null, required: true, reason: `Reference ${level?.toFixed(2) ?? 'missing'}`, weight: 5 },
    { name: 'Risk/reward', pass: rr, required: true, reason: `R:R 1:${nextLevel !== undefined && trade ? (Math.abs(nextLevel-trade.entry)/trade.risk).toFixed(2) : trade?.riskReward ?? 'N/A'}; minimum ${s.minimumRR}; risk ${trade?.risk.toFixed(2) ?? 'N/A'}`, weight: 5 },
  ];
  const usable = checks.filter(k => k.available !== false);
  const score = Math.round(100 * usable.reduce((t,k)=>t+(k.pass?k.weight:0),0) / usable.reduce((t,k)=>t+k.weight,0));
  const historyReady = c15.length >= 50 && c5.length >= 20 && c3.length >= 2;
  const missing = checks.filter(k => k.required && !k.pass).map(k => `${k.name}: ${k.reason}`);
  if (!historyReady) missing.push('Required closed-candle history is insufficient');
  if (!available) missing.push('VWAP strategy UNAVAILABLE: no valid session VWAP');
  if (!s.enabledStrategies.includes(strategy)) missing.push('Strategy disabled');
  return { strategy, side, regime: a.regime, available, timeframes: { direction: a, setup: b, confirmation: c }, levels, checks, score, valid: missing.length === 0, trade, setupId: `${strategy}:${side}:${setupAnchor}:${strategy === 'TREND_PULLBACK' ? 'pullback' : level ?? 'none'}`, setupDetectedAt: last?.time ?? at.toISOString(), reasons: checks.filter(k => k.pass && k.available !== false).map(k => `${k.name}: ${k.reason}`), missing, invalidations: trade ? [`Structure invalid at ${trade.stopLoss.toFixed(2)}`, `Retest of ${level?.toFixed(2) ?? 'reference'} fails`, '15M direction reverses'] : [] };

}
export function sessionFilters(at: Date, s: Settings, open: number | null, close: number | null) { const time = exchangeTime(at); const reasons: string[] = []; if (open === null || close === null || at.getTime() < open || at.getTime() >= close)
  reasons.push('Market session is not active'); if (time >= s.cutoff)
  reasons.push('Trading cutoff reached'); if (open !== null && at.getTime() < open + s.openingRangeMinutes * 60000)
  reasons.push('Opening volatility: collecting opening range'); if (!s.windows.some(([start, end]) => time >= start && time < end))
  reasons.push('Outside configured trading windows'); return reasons; }
export function lifecycle(price: number, side: string, entry: number, stop: number, targets: number[], status: string, squareOff: boolean) { if (['TARGET_3_HIT', 'STOP_LOSS', 'AUTO_EXIT', 'BREAKEVEN', 'CANCELLED', 'EXPIRED'].includes(status))
  return []; if (squareOff)
  return [status === 'WAITING' ? 'EXPIRED' : 'AUTO_EXIT']; const sign = side === 'BUY' ? 1 : -1; if (status === 'WAITING')
  return (price - entry) * sign >= 0 ? ['ENTRY_TRIGGERED', 'RUNNING'] : []; if ((price - stop) * sign <= 0)
  return [stop === entry ? 'BREAKEVEN' : 'STOP_LOSS']; const prior = status === 'TARGET_2_HIT' ? 2 : status === 'TARGET_1_HIT' ? 1 : 0; return targets.flatMap((t, i) => i >= prior && (price - t) * sign >= 0 ? [`TARGET_${i + 1}_HIT`] : []); }
// Shared price-action primitives used by live evaluation and historical replay.
export function retestHolds(bar: Candle, level: number, long: boolean, tolerance: number) { return long ? bar.low <= level + tolerance && bar.low >= level - tolerance && bar.close > level : bar.high >= level - tolerance && bar.high <= level + tolerance && bar.close < level; }
export function breakoutIndex(prior: Candle[], level: number, long: boolean, minimumVolumeRatio: number) { const sign = long ? 1 : -1; return prior.findIndex((x, k) => k > 0 && (x.close - level) * sign > 0 && (prior[k - 1].close - level) * sign <= 0 && (minimumVolumeRatio === 0 || (x.volume > 0 && x.volume >= prior.slice(0, k).reduce((t, r) => t + r.volume, 0) / k * minimumVolumeRatio))); }
export function vwapCrossIndex(prior: Array<{
  close: number;
  vwap: number | null;
}>, long: boolean) { const sign = long ? 1 : -1; return prior.findIndex((x, k) => k > 0 && x.vwap !== null && prior[k - 1].vwap !== null && (x.close - x.vwap) * sign > 0 && (prior[k - 1].close - prior[k - 1].vwap!) * sign < 0); }
export function optionLiquidityPass(option:{ltp:number;bid:number;ask:number;volume:number;lotSize:number;timestamp:number;timestampTrusted:boolean},settings:Settings,now:number){
  return [option.ltp,option.bid,option.ask,option.volume,option.lotSize,option.timestamp].every(Number.isFinite)&&option.ltp>0&&option.bid>0&&option.ask>=option.bid&&option.volume>=settings.minimumOptionVolume&&Number.isInteger(option.lotSize)&&option.lotSize>0&&option.timestampTrusted&&option.timestamp<=now+1000&&now-option.timestamp<=settings.staleMs&&(option.ask-option.bid)/option.ltp*100<=settings.maximumSpreadPercent;
}

/** Only full, consecutive source minutes may authorize a timeframe setup. */
export function completeCandles(candles: Candle[], tf: number, at: Date) {
  const source = new Set(candles.map(c=>Date.parse(c.time)));
  return aggregate(candles,tf).filter(c=> {
    const start=Date.parse(c.time);
    return start+tf*60000<=at.getTime() && Array.from({length:tf},(_,i)=>start+i*60000).every(t=>source.has(t));
  });
}
