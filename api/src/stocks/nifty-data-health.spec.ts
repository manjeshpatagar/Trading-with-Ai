import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { niftyDataHealth } from './nifty-data-health';
import { aggregate, completeCandles } from './nifty-engine';
const start=Date.parse('2026-09-16T09:15:00+05:30');
const candles=Array.from({length:46},(_,i)=>({time:new Date(start+i*60000).toISOString(),open:100,high:101,low:99,close:100,volume:0}));
const now=start+45*60000+350;
test('live tick and synchronized 1M/3M/5M/15M candles permit strategy evaluation',()=>{
 const health=niftyDataHealth(candles,{timestamp:now-350,timestampTrusted:true},now,15000,true,'CONNECTED');
 assert.equal(health.status,'LIVE');assert.equal(health.tickAgeMs,350);assert.equal(health.newTradesEnabled,true);assert.ok(health.timeframes.every(t=>t.status==='LIVE'));
});
test('stale, untrusted, future ticks and missing candles disable new trades',()=>{
 for(const quote of [null,{timestamp:now-15001,timestampTrusted:true},{timestamp:now,timestampTrusted:false},{timestamp:now+2000,timestampTrusted:true}]) {
 const health=niftyDataHealth(candles,quote,now,15000,true,'DISCONNECTED');assert.equal(health.status,'DATA DELAYED');assert.equal(health.newTradesEnabled,false);
 }
 assert.equal(niftyDataHealth(candles.slice(0,15),{timestamp:now,timestampTrusted:true},now,15000,true,'CONNECTED').newTradesEnabled,false);
});
test('closed market takes priority over delayed quotes',()=>{
 const health=niftyDataHealth(candles,null,now,15000,false,'DISCONNECTED');assert.equal(health.status,'MARKET CLOSED');assert.equal(health.newTradesEnabled,false);
});
test('a missing source minute invalidates the whole timeframe bar; source order cannot change OHLC',()=>{
 const rows=candles.slice(0,15);assert.equal(completeCandles(rows,15,new Date(now)).length,1);
 assert.equal(completeCandles(rows.filter((_,i)=>i!==7),15,new Date(now)).length,0);
 assert.deepEqual(aggregate([...rows].reverse(),15),aggregate(rows,15));
});
