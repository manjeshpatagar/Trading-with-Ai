import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { ServiceUnavailableException } from '@nestjs/common';
import { ScannerService } from './scanner.service';

const instrument = { instrumentKey: 'NSE_EQ|TEST', symbol: 'TEST', exchange: 'NSE', active: true, company: 'Test', sector: 'NSE Equity', token: '1', isin: 'TEST' };
function scanner(stored: any[], download: () => Promise<any[]>) {
  const database = {
    nseInstrument: {
      findMany: async () => [...stored],
      upsert: async ({ create }: any) => { stored.push(create); return create; },
    },
    $transaction: async (items: any[]) => Promise.all(items),
  };
  return new ScannerService({ nseEquityInstruments: download } as never, {} as never, {} as never, {} as never, {} as never, {} as never, database as never, {} as never, {} as never, {} as never) as any;
}

test('saved instrument metadata is immediately available while a shared download is pending', async () => {
  let fail!: (error: Error) => void;
  let downloads = 0;
  const service = scanner([instrument], () => { downloads++; return new Promise((_, reject) => { fail = reject; }); });
  const result = await Promise.all([service.syncInstruments(), service.syncInstruments()]);
  assert.deepEqual(result, [[instrument], [instrument]]);
  assert.equal(downloads, 1);
  const refresh = service.instrumentRefresh;
  fail(new Error('timeout of 30000ms exceeded'));
  await assert.rejects(refresh, ServiceUnavailableException);
  assert.deepEqual(await service.syncInstruments(), [instrument]);
  assert.equal(downloads, 1, 'provider failure has a retry cooldown');
});

test('cold starts fail clearly without manufacturing instruments or signals, then recover', async () => {
  let downloads = 0;
  const service = scanner([], async () => {
    if (++downloads === 1) throw new Error('Provider unavailable');
    return [{ instrument_key: 'NSE_EQ|TEST', trading_symbol: 'TEST', exchange: 'NSE', instrument_type: 'EQ', name: 'Test' }];
  });
  await assert.rejects(service.syncInstruments(), ServiceUnavailableException);
  await assert.rejects(service.syncInstruments(), ServiceUnavailableException);
  assert.equal(downloads, 1);
  service.nextInstrumentRefreshAt = 0;
  const rows = await service.syncInstruments();
  assert.equal(rows[0].instrumentKey, 'NSE_EQ|TEST');
  await service.syncInstruments();
  assert.equal(downloads, 2, 'successful metadata refresh is reused, not rewritten on each scan');
});
