import {test} from 'node:test';
import * as assert from 'node:assert/strict';
import {optionRiskLevels,rankOptions} from './nifty-option-engine';
test('execution quality outranks cheap premium and strike distance breaks liquidity ties',()=>{
 const cheap={strike:22500,spreadPercent:5,volume:1000,premium:1};
 const liquid={strike:22100,spreadPercent:.5,volume:5000,premium:100};
 const atm={...liquid,strike:22000};
 assert.deepEqual(rankOptions([cheap,liquid,atm],22000),[atm,liquid,cheap]);
});
test('option risk mapping produces exact 1R, 2R and 3R levels',()=>{
 assert.deepEqual(optionRiskLevels(100,20,3),{riskPerUnit:20,stopLoss:80,targets:[120,140,160]});
});
