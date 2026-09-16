import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { BadGatewayException, InternalServerErrorException } from '@nestjs/common';
import { StocksController } from './stocks.controller';

const context = { logger: { log() {}, error() {} }, context: () => undefined };
const diagnosed = (failure: Error) => (StocksController.prototype as any).diagnosed.call(context, 'TopBuyService.getTopBuy', 'GET', async () => { throw failure; });

test('known provider errors preserve their HTTP status instead of turning into a generic 500', async () => {
  const error = new BadGatewayException('Market data temporarily unavailable');
  await assert.rejects(diagnosed(error), value => value === error && error.getStatus() === 502);
});

test('unexpected endpoint errors keep their stack in server logs, not in the browser response', async () => {
  await assert.rejects(diagnosed(new Error('internal database details')), value => {
    assert.ok(value instanceof InternalServerErrorException);
    assert.deepEqual(value.getResponse(), { statusCode: 500, message: 'The request could not be completed. Please retry shortly.', error: 'Internal Server Error' });
    return true;
  });
});
