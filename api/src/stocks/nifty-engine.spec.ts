import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { aggregate, breakoutIndex, retestHolds, vwapCrossIndex, bucket, defaults, evaluate, evaluateAll, indicators, keyLevels, lifecycle, optionLiquidityPass, positionSize, sessionFilters, tradeLevels } from './nifty-engine';
import type { Candle } from './indicator.service';
const at = (t: string) => new Date(`2026-09-16T${t}:00+05:30`);
function candles(count: number, volume = 100): Candle[] { return Array.from({ length: count }, (_, i) => ({ time: new Date(at('09:15').getTime() + i * 60000).toISOString(), open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume })); }
test('15/5/3/1 minute candles share exchange-open anchor, including 09:15 15M', () => { for (const tf of [1, 3, 5, 15])
  assert.equal(bucket(at('09:15').getTime(), tf), at('09:15').getTime()); assert.equal(aggregate(candles(15), 15).length, 1); assert.equal(aggregate(candles(15), 5).length, 3); assert.equal(aggregate(candles(15), 3).length, 5); });
test('aggregate conserves OHLC and volume', () => { const c = aggregate(candles(5), 5)[0]; assert.equal(c.open, 100); assert.equal(c.close, 105); assert.equal(c.high, 106); assert.equal(c.low, 99); assert.equal(c.volume, 500); });
test('VWAP requires real volume; unavailable index volume is optional for price strategies', () => { const c = candles(200, 0); assert.equal(indicators(c).vwap, null); for (const strategy of defaults.enabledStrategies) {
  const e = evaluate(strategy, c, at('14:00'), defaults);
  assert.equal(e.valid, false);
  assert.ok(e.checks.some(k => k.name === 'Volume' && k.available === false && !k.required));
  assert.equal(e.available, strategy !== 'VWAP_RECLAIM_REJECTION');
} });
test('monotone closes without confirmed swing structure do not declare bullish regime', () => { assert.equal(indicators(candles(100)).direction, 'RANGE'); });
test('opening range uses exact session time and previous session levels', () => { const before = candles(20).map(c => ({ ...c, time: new Date(Date.parse(c.time) - 86400000).toISOString() })); const k = keyLevels([...before, ...candles(30)], at('10:00'), defaults); assert.equal(k.previousDayHigh, 121); assert.equal(k.previousClose, 120); assert.equal(k.openingRangeHigh, 116); assert.equal(k.openingRangeLow, 99); assert.equal(k.openingRangeComplete, true); });
test('long/short SL comes from structure and buffered risk; targets are 1/2/3R', () => { assert.deepEqual(tradeLevels(120, 85, 'BUY', 5), { entry: 120, stopLoss: 80, risk: 40, target1: 160, target2: 200, target3: 240, riskReward: 2 }); const short = tradeLevels(100, 135, 'SELL', 5); assert.equal(short.stopLoss, 140); assert.equal(short.target3, -20); });
test('position size uses premium risk, capital and actual lot metadata', () => { assert.equal(positionSize(100000, .5, 5, 5, 25), 100); assert.equal(positionSize(10000, .5, 100, 100, 75), 0); assert.equal(positionSize(100000, .5, 5, 0, 25), 0); assert.equal(positionSize(100000, .5, 5, 5, 0), 0); });
test('opening volatility, midday, cutoff, closed and unknown session block entry', () => { const open = at('09:15').getTime(), close = at('15:30').getTime(); assert.ok(sessionFilters(at('09:20'), defaults, open, close).some(x => x.includes('Opening'))); assert.deepEqual(sessionFilters(at('10:00'), defaults, open, close), []); assert.ok(sessionFilters(at('12:00'), defaults, open, close).length); assert.ok(sessionFilters(at('15:01'), defaults, open, close).some(x => x.includes('cutoff'))); assert.ok(sessionFilters(at('10:00'), defaults, null, null).length); });
test('entry/lifecycle and duplicate target protection', () => { assert.deepEqual(lifecycle(100, 'BUY', 110, 90, [120, 130, 140], 'WAITING', false), []); assert.deepEqual(lifecycle(110, 'BUY', 110, 90, [120, 130, 140], 'WAITING', false), ['ENTRY_TRIGGERED', 'RUNNING']); assert.deepEqual(lifecycle(135, 'BUY', 110, 90, [120, 130, 140], 'RUNNING', false), ['TARGET_1_HIT', 'TARGET_2_HIT']); assert.deepEqual(lifecycle(135, 'BUY', 110, 90, [120, 130, 140], 'TARGET_2_HIT', false), []); assert.deepEqual(lifecycle(140, 'BUY', 110, 90, [120, 130, 140], 'TARGET_2_HIT', false), ['TARGET_3_HIT']); assert.deepEqual(lifecycle(141, 'BUY', 110, 90, [120, 130, 140], 'TARGET_3_HIT', false), []); });
test('stop loss, breakeven and market square-off are terminal', () => { assert.deepEqual(lifecycle(85, 'BUY', 110, 90, [120, 130, 140], 'RUNNING', false), ['STOP_LOSS']); assert.deepEqual(lifecycle(110, 'BUY', 110, 110, [120, 130, 140], 'TARGET_1_HIT', false), ['BREAKEVEN']); assert.deepEqual(lifecycle(100, 'BUY', 110, 90, [120, 130, 140], 'RUNNING', true), ['AUTO_EXIT']); assert.deepEqual(lifecycle(100, 'BUY', 110, 90, [120, 130, 140], 'WAITING', true), ['EXPIRED']); });
test('single VWAP cross or resistance break without retest/3M cannot authorize entries', () => { for (const strategy of ['BREAKOUT_RETEST', 'VWAP_RECLAIM_REJECTION', 'TREND_PULLBACK'] as const) {
  const e = evaluate(strategy, candles(60), at('10:15'), defaults);
  assert.equal(e.valid, false);
  assert.ok(e.missing.length);
  assert.ok(e.score <= 90);
  assert.ok(e.reasons.every(r => typeof r === 'string'));
} });
test('bullish/bearish breakouts require a prior crossing and expanded volume', () => { const prior = candles(3); prior[0].close = 99; prior[1].close = 101; prior[1].volume = 150; assert.equal(breakoutIndex(prior, 100, true, 1.1), 1); prior[1].volume = 50; assert.equal(breakoutIndex(prior, 100, true, 1.1), -1); prior[0].close = 101; prior[1].close = 99; prior[1].volume = 150; assert.equal(breakoutIndex(prior, 100, false, 1.1), 1); });
test('retest holds reject false breaks beyond configured invalidation tolerance', () => { const bar = { ...candles(1)[0], low: 99, high: 104, close: 103 }; assert.equal(retestHolds(bar, 100, true, 2), true); assert.equal(retestHolds({ ...bar, low: 95 }, 100, true, 2), false); assert.equal(retestHolds({ ...bar, high: 101, close: 97 }, 100, false, 2), true); assert.equal(retestHolds({ ...bar, high: 105, close: 97 }, 100, false, 2), false); });
test('VWAP reclaim/rejection use each closed candle own session VWAP and reject missing volume', () => { assert.equal(vwapCrossIndex([{ close: 99, vwap: 100 }, { close: 101, vwap: 100 }], true), 1); assert.equal(vwapCrossIndex([{ close: 101, vwap: 100 }, { close: 99, vwap: 100 }], false), 1); assert.equal(vwapCrossIndex([{ close: 99, vwap: null }, { close: 101, vwap: 100 }], true), -1); assert.equal(vwapCrossIndex([{ close: 101, vwap: 100 }, { close: 102, vwap: 100 }], true), -1); });
test('trend pullback can pass all closed-candle structure/volume/confirmation checks', () => { const rows: Candle[] = []; for (let day = 10; day <= 16; day++) {
  const start = Date.parse(`2026-09-${day}T09:15:00+05:30`);
  for (let i = 0; i < 375; i++) {
    const k = rows.length, p = 20000 + k * .22 + 28 * Math.sin(k * Math.PI / 45);
    rows.push({ time: new Date(start + i * 60000).toISOString(), open: p, high: p + 3, low: p - 3, close: p + 1, volume: 1000 });
  }
} const e = evaluate('TREND_PULLBACK', rows.slice(0, 2266), new Date(rows[2266].time), { ...defaults, minimumVolumeRatio: 1, safetyBuffer: 1, minimumLevelDistance: 5 }); assert.equal(e.valid, true); assert.ok(e.checks.filter(c=>c.required).every(c => c.pass)); assert.equal(e.side, 'BUY'); assert.ok(e.trade!.stopLoss < e.trade!.entry); assert.ok(e.trade!.target1 > e.trade!.entry); });

test('option liquidity rejects missing depth, wide spread, stale/unknown timestamps and invalid lot sizes',()=>{const now=Date.now(),option={ltp:100,bid:99,ask:100,volume:2000,lotSize:65,timestamp:now,timestampTrusted:true};assert.equal(optionLiquidityPass(option,defaults,now),true);for(const change of [{bid:NaN},{ask:110},{timestamp:now-defaults.staleMs-1},{timestampTrusted:false},{lotSize:0},{volume:10}])assert.equal(optionLiquidityPass({...option,...change},defaults,now),false);});

function trendFixture() {
  const rows: Candle[]=[];
  for(let day=10;day<=16;day++)for(let i=0;i<375;i++) {
    const k=rows.length,p=20000+k*.22+28*Math.sin(k*Math.PI/45);
    rows.push({time:new Date(Date.parse(`2026-09-${day}T09:15:00+05:30`)+i*60000).toISOString(),open:p,high:p+3,low:p-3,close:p+1,volume:0});
  }
  return rows;
}
test('bullish and bearish trend pullbacks confirm without fabricated index volume/VWAP',()=>{
  const rows=trendFixture().slice(0,2266), at=new Date(Date.parse(rows.at(-1)!.time)+60000);
  const settings={...defaults,minimumVolumeRatio:1,safetyBuffer:1,minimumLevelDistance:5};
  const ema=evaluate('TREND_PULLBACK',rows,at,settings).timeframes.setup.ema20!;
  rows[2260].low=ema+1;
  for(const long of [true,false]) {
    const input=long?rows:rows.map(c=>({...c,open:50000-c.open,close:50000-c.close,high:50000-c.low,low:50000-c.high}));
    const e=evaluate('TREND_PULLBACK',input,at,settings);
    assert.equal(e.valid,true,JSON.stringify(e.missing));assert.equal(e.side,long?'BUY':'SELL');assert.ok(e.score>=70);assert.equal(e.timeframes.setup.vwap,null);
  }
});

function setupFixture(kind: string){const rows: Candle[]=[];for(let day=14;day<=15;day++)for(let i=0;i<375;i++){let p=20000+20*Math.sin(i*Math.PI/30);rows.push({time:new Date(Date.parse(`2026-09-${day}T09:15:00+05:30`)+i*60000).toISOString(),open:p,high:p+10,low:p-10,close:p+1,volume:kind==='VWAP'?1000:0});}for(let i=0;i<75;i++){let c={time:new Date(Date.parse('2026-09-16T09:15:00+05:30')+i*60000).toISOString(),open:20000,high:20010,low:19990,close:20000,volume:kind==='VWAP'?1000:0};if(kind==='BREAK'){if(i<15)c.high=20100;if(i>=65&&i<70)Object.assign(c,{open:20095,high:20115,low:20090,close:20110});if(i>=70)Object.assign(c,{open:20110+(i-70),high:20123,low:i>=72?20102:20100,close:20115+(i-70)});}else {if(i>=60&&i<65)Object.assign(c,{open:20000,high:20005,low:19985,close:19990});if(i>=65&&i<70)Object.assign(c,{open:19995,high:20015,low:19990,close:20010});if(i>=70)Object.assign(c,{open:20008+(i-70),high:20035,low:i>=72?20002:19999,close:20018+(i-70)});}rows.push(c);}return rows;}
for (const [kind,strategy] of [['BREAK','BREAKOUT_RETEST'],['VWAP','VWAP_RECLAIM_REJECTION']] as const) {
  for(const long of [true,false]) test(`${strategy} ${long?'CALL':'PUT'} requires confirmed break/reclaim plus retest`,()=> {
    const rows=setupFixture(kind);
    const input=long?rows:rows.map(c=>({...c,open:40000-c.open,close:40000-c.close,high:40000-c.low,low:40000-c.high}));
    const e=evaluate(strategy,input,at('10:30'),{...defaults,safetyBuffer:1,minimumLevelDistance:5});
    assert.equal(e.valid,true,JSON.stringify(e.missing));assert.equal(e.side,long?'BUY':'SELL');assert.ok(e.score>=70);
    assert.ok(e.checks.filter(c=>c.required).every(c=>c.pass));
    if(kind==='BREAK') assert.equal(e.regime,'RANGE');
  });
}
test('middle of a range has no level retest and cannot authorize an entry',()=> {
 const rows=setupFixture('BREAK');for(const c of rows.slice(-10))Object.assign(c,{open:20000,high:20005,low:19995,close:20001});
 for(const strategy of defaults.enabledStrategies)assert.equal(evaluate(strategy,rows,at('10:30'),defaults).valid,false);
});
for(const long of [true,false]) test(`range ${long?'support bounce CALL':'resistance rejection PUT'} needs a level and 3M reversal`,()=>{
  const rows=setupFixture('BREAK');
  for(const [i,bar] of rows.slice(-10).entries())Object.assign(bar,i<5?{open:20000,high:20005,low:19990,close:19995}:{open:19992+i-5,high:20004,low:i>=7?19995:19990,close:19998+i-5});
  const input=long?rows:rows.map(c=>({...c,open:40000-c.open,close:40000-c.close,high:40000-c.low,low:40000-c.high}));
  const e=evaluate('RANGE_REVERSAL',input,at('10:30'),{...defaults,safetyBuffer:1,minimumLevelDistance:5});
  assert.equal(e.valid,true,JSON.stringify(e.missing));assert.equal(e.side,long?'BUY':'SELL');assert.equal(e.regime,'RANGE');
});
test('the same breakout retains its setup fingerprint across another retest candle',()=>{
  const rows=setupFixture('BREAK'),settings={...defaults,safetyBuffer:1,minimumLevelDistance:5};
  const first=evaluate('BREAKOUT_RETEST',rows,at('10:30'),settings);
  const last=rows.at(-1)!;
  for(let i=1;i<=5;i++)rows.push({...last,time:new Date(Date.parse(last.time)+i*60000).toISOString(),low:20102,high:20129,close:20124});
  const next=evaluate('BREAKOUT_RETEST',rows,at('10:35'),settings);
  assert.equal(first.setupId,next.setupId);
});

test('shared timeframe inputs are rebuilt when source candles change at the same evaluation time',()=> {
 const rows=setupFixture('BREAK'),settings={...defaults,safetyBuffer:1,minimumLevelDistance:5};
 assert.equal(evaluateAll(rows,at('10:30'),settings).find(e=>e.strategy==='BREAKOUT_RETEST')!.valid,true);
 for(const bar of rows.slice(-10))Object.assign(bar,{open:20000,high:20005,low:19995,close:20001});
 assert.ok(evaluateAll(rows,at('10:30'),settings).every(e=>!e.valid));
});
