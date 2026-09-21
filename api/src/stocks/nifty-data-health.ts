import type { Candle } from './indicator.service';
import { aggregate, completeCandles } from './nifty-engine';
export function niftyDataHealth(candles: Candle[], quote: { timestamp: number; timestampTrusted: boolean } | null, now: number, staleMs: number, inSession: boolean, websocketStatus: string) {
  const tickAge = quote ? now-quote.timestamp : null;
  const tickFresh = !!quote?.timestampTrusted && tickAge !== null && tickAge >= -1000 && tickAge <= staleMs;
  const timeframes = [1,3,5,15].map(tf=> {
    const latest = aggregate(candles,tf).at(-1)?.time ?? null;
    const closed = completeCandles(candles,tf,new Date(now)).at(-1)?.time ?? null;
    const age = latest ? now-Date.parse(latest) : null;
    const closedAge = closed ? now-Date.parse(closed)-tf*60000 : null;
    const fresh = age !== null && age >= 0 && age < tf*60000+staleMs && closedAge !== null && closedAge >= 0 && closedAge < tf*60000+staleMs;
    return {timeframe:tf, latest, latestClosed:closed, ageMs:age, closedAgeMs:closedAge, status:fresh?'LIVE':'DELAYED'};
  });
  const stale = !tickFresh || timeframes.some(t=>t.status!=='LIVE');
  return {status:!inSession?'MARKET CLOSED':stale?'DATA DELAYED':'LIVE', newTradesEnabled:inSession&&!stale, latestTick:quote?.timestamp??null,tickAgeMs:tickAge,websocketStatus,timeframes,stale};
}
