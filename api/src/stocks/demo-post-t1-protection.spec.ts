import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { PaperTradingService } from './paper-trading.service';
import { PaperOrderExecutionService } from './paper-order-execution.service';
import { PrismaService } from '../prisma.service';
import { MarketPricesService } from './market-prices.service';

function harness(side = 'BUY', portfolio = 'STRATEGY', protectedStopLoss: number|null = 97) {
  const order: any = { id:'order',userId:'user',instrumentKey:'NSE_EQ|TEST',symbol:'TEST',portfolio,status:'OPEN',side,
    quantity:100,entryPrice:100,entryTime:new Date('2026-10-05T12:00:00+05:30'),currentPrice:100,
    stopLoss:side==='BUY'?90:110,target:side==='BUY'?120:80,postT1ProtectionActive:true,protectedStopLoss };
  const exits: any[] = [];
  const prisma: any = { paperOrder:{findMany:async()=>order.status === 'OPEN' ? [order] : [],findFirst:async()=>order,update:async({data}:any)=>Object.assign(order,data),updateMany:async({data}:any)=>{Object.assign(order,data);return {count:1};}},
    paperTradingAccount:{findMany:async()=>[{portfolio,enabled:true,allowAiWait:true}]} };
  const prices = new MarketPricesService();
  const service = new PaperTradingService(prisma as PrismaService,new PaperOrderExecutionService(),prices);
  (service as any).close = async (...args:any[]) => { exits.push(args); order.status='CLOSED'; };
  return {service,order,exits,prices};
}
const noon = (seconds=0) => new Date(new Date('2026-10-05T12:10:00+05:30').getTime()+seconds*1000);
test('BUY and SELL ignore legacy protection and exit at the strategy stop even with AI wait enabled', async () => {
  for (const side of ['BUY', 'SELL']) {
    for (const protectedStop of [null, 85, 102, 115]) {
      const h = harness(side, 'STRATEGY', protectedStop);
      h.order.postT1ProtectionState = JSON.stringify({ protectedStopUpdatedAt: noon(60).toISOString() });
      for (const price of side === 'BUY' ? [101, 99, 95, 90.01] : [99, 101, 105, 109.99]) {
        await h.service.processTick('user', h.order.instrumentKey, price, noon());
        assert.equal(h.exits.length, 0);
      }
      const stop = side === 'BUY' ? 90 : 110;
      await h.service.processTick('user', h.order.instrumentKey, stop, noon());
      await h.service.processTick('user', h.order.instrumentKey, stop, noon(1));
      assert.equal(h.exits.length, 1);
      assert.equal(h.exits[0][1], stop);
      assert.equal(h.exits[0][2], 'STOP LOSS');
      assert.equal(h.order.quantity, 100);
    }
  }
});

test('BUY and SELL gaps exit at the observed price after crossing the strategy stop', async () => {
  for (const side of ['BUY', 'SELL']) {
    const h = harness(side);
    const price = side === 'BUY' ? 89 : 111;
    await h.service.processTick('user', h.order.instrumentKey, price, noon());
    assert.equal(h.exits[0][1], price);
    assert.equal(h.exits[0][2], 'STOP LOSS');
  }
});

test('BUY and SELL still exit at Target 3 regardless of legacy protected stop', async () => {
  for (const side of ['BUY', 'SELL']) {
    const h = harness(side, 'STRATEGY', side === 'BUY' ? 121 : 79);
    await h.service.processTick('user', h.order.instrumentKey, h.order.target, noon());
    assert.equal(h.exits[0][2], 'TARGET');
  }
});

test('end of day and manual exit retain their existing flow', async () => {
  const h = harness();
  await h.service.processTick('user', h.order.instrumentKey, 100, new Date('2026-10-05T15:20:00+05:30'));
  assert.equal(h.exits[0][2], 'End of Day Auto Exit');
  const manual = harness();
  manual.prices.accept('user', manual.order.instrumentKey, 105, Date.now());
  assert.equal(await manual.service.manualExit('user', manual.order.id), true);
  assert.equal(manual.exits[0][2], 'MANUAL EXIT');
});
