import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import type { Candle } from './indicator.service';
import { evaluateAll, exchangeDate, exchangeTime, strategies, type Settings } from './nifty-engine';
type Evaluation = ReturnType<typeof evaluateAll>[number];
export type Outcome = {
  date?: string;
  window?: string;
  side?: string;
  regime?: string;
  r: number;
  holding: number;
  t1: boolean;
  t2: boolean;
  t3: boolean;
  sl: boolean;
};
export function simulate(candles: Candle[], s: Settings, from?: string) {
  const frequency: Array<{strategy:string;date:string;window:string;regime:string;setupId:string;entered:boolean}> = [];
  const outcomes = new Map<string, Array<Outcome>>(strategies.map(k => [k, []]));
  type Active = {
    e: Evaluation; status: string; entry: number | null; started: number;
    t1: boolean; t2: boolean; t3: boolean; sl: boolean;
  };
  const states=new Map(strategies.map(strategy=>[strategy,{active:null as Active|null,seen:new Set<string>()}]));
  for (let i=750;i<candles.length;i++) {
    const bar=candles[i];
    const at=new Date(Date.parse(bar.time)+60000);
    if(from && exchangeDate(at)<from) continue;
      const time = exchangeTime(at);
      const inWindow = s.windows.some(([a,b])=>time>=a&&time<b) && time<s.cutoff;
      const evaluations=inWindow?evaluateAll(candles.slice(Math.max(0,i-2000),i),at,s):[];
      for(const strategy of strategies) {
      const state=states.get(strategy)!;
      let active=state.active;
      const seen=state.seen;
      const e=evaluations.find(e=>e.strategy===strategy) ?? null;
      const newSetup = !!e && e.valid && e.score >= s.minimumScore && !seen.has(e.setupId);
      if(newSetup && e) {
        seen.add(e.setupId);
        frequency.push({strategy,date:exchangeDate(at),window:time<'11:30'?'MORNING':'AFTERNOON',regime:e.regime,setupId:e.setupId,entered:false});
      }
      if (active) {
        const t = active.e.trade!;
        if (active.status === 'WAITING') {
          if (at.getTime()-Date.parse(active.e.setupDetectedAt)>15*60000 || exchangeTime(at) >= s.cutoff || exchangeDate(at) !== exchangeDate(new Date(active.e.setupDetectedAt))) {
            state.active = null; active = null;
            continue;
          }
          const triggered = active.e.side === 'BUY' ? bar.high >= t.entry : bar.low <= t.entry;
          if (triggered) {
            active.status = 'RUNNING';
            const opportunity=frequency.find(r=>r.setupId===active!.e.setupId);if(opportunity)opportunity.entered=true;
            active.entry = active.e.side === 'BUY' ? Math.max(t.entry, bar.open) : Math.min(t.entry, bar.open);
            active.started = at.getTime();
          }
          else
            continue;
        }
        const sign = active.e.side === 'BUY' ? 1 : -1;
        const stop = s.trailAfterT2 && active.t2 ? t.target1 : s.moveToBreakeven && active.t1 ? active.entry! : t.stopLoss;
        const stopHit = sign === 1 ? bar.low <= stop : bar.high >= stop;
        const square = exchangeTime(at) >= s.squareOff || exchangeDate(at) !== exchangeDate(new Date(active.e.setupDetectedAt));
        let exit: number | null = null;
        if (stopHit) {
          exit = sign === 1 ? Math.min(stop, bar.open) : Math.max(stop, bar.open);
          active.sl = stop === t.stopLoss;
        }
        else {
          active.t1 ||= sign === 1 ? bar.high >= t.target1 : bar.low <= t.target1;
          active.t2 ||= sign === 1 ? bar.high >= t.target2 : bar.low <= t.target2;
          active.t3 ||= sign === 1 ? bar.high >= t.target3 : bar.low <= t.target3;
          if (active.t3)
            exit = t.target3;
          else if (square)
            exit = bar.close;
        }
        if (exit !== null) {
          outcomes.get(strategy)!.push({ date:exchangeDate(new Date(active.e.setupDetectedAt)),window:exchangeTime(new Date(active.e.setupDetectedAt))<'11:30'?'MORNING':'AFTERNOON', r: (exit - active.entry!) * sign / t.risk, side: active.e.side, regime: active.e.regime, holding: (at.getTime() - active.started) / 60000, t1: active.t1, t2: active.t2, t3: active.t3, sl: active.sl });
          state.active = null; active = null;
        }
        continue;
      }

      const dailyTrades=frequency.filter(r=>r.strategy===strategy&&r.date===exchangeDate(at)&&r.entered).length;
      if (newSetup && e && dailyTrades<s.maxTrades) {
        state.active = active = { e, status: 'WAITING', entry: null, started: 0, t1: false, t2: false, t3: false, sl: false };
      }
    }
  }
  return {outcomes,frequency,days:[...new Set(candles.map(c=>exchangeDate(new Date(c.time))).filter(d=>!from||d>=from))]};
}
if (!isMainThread) {
  const input = workerData as {
    candles: Candle[];
    settings: Settings;
    from?: string;
  };
  const result=simulate(input.candles,input.settings,input.from);
  parentPort?.postMessage({...result,outcomes:[...result.outcomes]});
}
