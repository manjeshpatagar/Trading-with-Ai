import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { BadGatewayException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { Cache } from 'cache-manager';
import axios from 'axios';
import { gunzipSync } from 'node:zlib';
import { AuthService } from '../auth/auth.service';

const API = 'https://api.upstox.com';
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNITS = new Set(['minutes']);
const INTRADAY_INTERVALS = new Set([1, 3, 5, 15, 30]);

@Injectable()
export class UpstoxService {
  private readonly logger = new Logger(UpstoxService.name);

  constructor(private readonly auth: AuthService, @Inject(CACHE_MANAGER) private readonly cache: Cache) {}

  private async get(userId: string, path: string, params?: Record<string, string | number>) {
    const endpoint = `${API}${path}`;
    const accessToken = await this.auth.accessToken(userId);
    const requestHeaders = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer [REDACTED]' };
    const request = { endpoint, params: params ?? {}, headers: requestHeaders, accessTokenPresent: Boolean(accessToken) };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const startedAt = Date.now();
      try {
        this.logger.log(`Upstox request | attempt ${attempt + 1}/3: ${JSON.stringify(request)}`);
        const response = await axios.get(endpoint, { params, headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' }, timeout: 15_000 });
        this.logger.log(`Upstox response | endpoint: ${endpoint} | status: ${response.status} | response time: ${Date.now() - startedAt}ms | data: ${JSON.stringify(response.data)}`);
        return response.data;
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429 && attempt < 2) {
          const retryAfter = Number(error.response.headers?.['retry-after']);
          const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1_000 : 500 * 2 ** attempt;
          this.logger.warn(`Upstox rate limited | endpoint: ${endpoint} | retry count: ${attempt + 1} | retry after: ${delay}ms | response time: ${Date.now() - startedAt}ms`);
          await new Promise<void>((resolve) => setTimeout(resolve, delay));
          continue;
        }
        if (axios.isAxiosError(error)) {
          const responseBody: any = error.response?.data;
          const firstError = responseBody?.errors?.[0] ?? responseBody?.error ?? responseBody;
          const upstoxErrorCode = firstError?.errorCode ?? firstError?.error_code ?? firstError?.code ?? responseBody?.code ?? 'not_provided';
          const details = { endpoint, request: params ?? {}, requestHeaders, status: error.response?.status, responseBody, responseHeaders: error.response?.headers, exactUpstoxErrorCode: upstoxErrorCode, message: error.message, responseTimeMs: Date.now() - startedAt };
          this.logger.error(`Upstox request failed: ${JSON.stringify(details)}`, error.stack);
          if (error.response) throw new HttpException(responseBody ?? { status: 'error', message: error.message, errorCode: upstoxErrorCode }, error.response.status);
          throw new BadGatewayException({ status: 'error', message: error.message, errorCode: upstoxErrorCode });
        }
        this.logger.error(`Unexpected Upstox client failure for ${endpoint}`, error instanceof Error ? error.stack : undefined);
        throw new BadGatewayException(`Upstox client failure: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      throw new BadGatewayException(`Upstox request exhausted retries: ${endpoint}`);
    } catch (error) { throw error; }
  }

  private assertCandleRequest(instrumentKey: string, unit: string, interval: number, to: string, from: string) {
    if (!instrumentKey.includes('|')) throw new BadGatewayException('Invalid Upstox instrument_key');
    if (!UNITS.has(unit)) throw new BadGatewayException(`Invalid candle unit: ${unit}`);
    if (!Number.isInteger(interval) || interval < 1) throw new BadGatewayException(`Invalid candle interval: ${interval}`);
    if (!DATE.test(to) || !DATE.test(from) || from > to) throw new BadGatewayException('Candle dates must be YYYY-MM-DD with from_date on or before to_date');
    if (!INTRADAY_INTERVALS.has(interval)) throw new BadGatewayException('Only 1, 3, 5, 15 and 30 minute candles are supported');
  }

  private assertIntradayCandleRequest(instrumentKey: string, unit: string, interval: number) {
    if (!instrumentKey.includes('|')) throw new BadGatewayException('Invalid Upstox instrument_key');
    if (unit !== 'minutes') throw new BadGatewayException('Only minute candles are supported');
    if (!Number.isInteger(interval) || interval < 1) throw new BadGatewayException(`Invalid candle interval: ${interval}`);
    if (!INTRADAY_INTERVALS.has(interval)) throw new BadGatewayException('Only 1, 3, 5, 15 and 30 minute candles are supported');
  }

  async search(userId: string, query: string) {
    return this.get(userId, '/v2/instruments/search', { query });
  }

  async profile(userId: string) { return this.get(userId, '/v2/user/profile'); }

  async history(userId: string, instrumentKey: string, unit: string, interval: number, to: string, from: string) {
    this.assertCandleRequest(instrumentKey, unit, interval, to, from);
    const cacheKey = `upstox:history:${userId}:${instrumentKey}:${unit}:${interval}:${to}:${from}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) { this.logger.log(`Historical cache hit | instrument_key: ${instrumentKey} | timeframe: ${unit}/${interval}`); return cached; }
    this.logger.log(`Historical cache miss | instrument_key: ${instrumentKey} | timeframe: ${unit}/${interval}`);
    const path = `/v3/historical-candle/${encodeURIComponent(instrumentKey)}/${unit}/${interval}/${to}/${from}`;
    this.logger.log(`Upstox historical candle request | ${JSON.stringify({ symbol: 'resolved by instrument key', instrumentKey, interval, fromDate: from, toDate: to, completeRequestUrl: `${API}${path}`, requestHeaders: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: 'Bearer [REDACTED]' } })}`);
    const result: any = await this.get(userId, path);
    const candles = result?.data?.candles;
    this.logger.log(`Upstox historical candle success | ${JSON.stringify({ numberOfCandles: Array.isArray(candles) ? candles.length : 0, firstCandle: Array.isArray(candles) ? candles.at(-1) ?? null : null, lastCandle: Array.isArray(candles) ? candles.at(0) ?? null : null })}`);
    await this.cache.set(cacheKey, result, 60_000);
    return result;
  }

  async intraday(userId: string, instrumentKey: string, unit: string, interval: number) {
    // This endpoint has no date parameters.  Do not pass sentinel dates to a
    // historical validator: they previously made a valid intraday call look
    // like an invalid date-range request.
    this.assertIntradayCandleRequest(instrumentKey, unit, interval);
    return this.get(userId, `/v3/historical-candle/intraday/${encodeURIComponent(instrumentKey)}/${unit}/${interval}`);
  }

  async quote(userId: string, instrumentKey: string) {
    const cacheKey = `quote:${userId}:${instrumentKey}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;
    // Full Market Quote is currently a supported V2 endpoint; Upstox's newer
    // lightweight quote endpoints are V3 and exposed below.
    const result = await this.get(userId, '/v2/market-quote/quotes', { instrument_key: instrumentKey });
    await this.cache.set(cacheKey, result, 5_000);
    return result;
  }

  async ltp(userId: string, instrumentKey: string) {
    return this.get(userId, '/v3/market-quote/ltp', { instrument_key: instrumentKey });
  }

  async ohlc(userId: string, instrumentKey: string, interval: 'I1' | 'I30' = 'I1') {
    return this.get(userId, '/v3/market-quote/ohlc', { instrument_key: instrumentKey, interval });
  }

  async feedUrl(userId: string) {
    return this.get(userId, '/v3/feed/market-data-feed/authorize');
  }

  async exitIntradayPositions(userId: string) {
    const accessToken = await this.auth.accessToken(userId);
    const endpoint = `${API}/v2/order/positions/exit`;
    try {
      const response = await axios.post(endpoint, {}, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        timeout: 15_000,
      });
      this.logger.log(JSON.stringify({ event: 'upstox.eod.exit.accepted', userId, status: response.status, body: response.data }));
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error) && JSON.stringify(error.response?.data ?? {}).includes('UDAPI1111')) {
        return { status: 'success', data: { order_ids: [] }, summary: { total: 0, success: 0, error: 0 } };
      }
      throw error;
    }
  }

  async waitForOrders(userId: string, orderIds: string[]) {
    if (!orderIds.length) return;
    for (let poll = 0; poll < 10; poll += 1) {
      const details = await Promise.all(orderIds.map((orderId) => this.get(userId, '/v2/order/details', { order_id: orderId })));
      const statuses = details.map((detail: any) => String(detail?.data?.status ?? '').toLowerCase());
      if (statuses.some((status) => ['rejected', 'cancelled'].includes(status))) throw new Error(`Upstox rejected EOD exit order: ${JSON.stringify(details)}`);
      if (statuses.every((status) => status === 'complete')) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`Timed out waiting for Upstox EOD order confirmation: ${orderIds.join(',')}`);
  }

  async nseEquityInstruments() {
    const cacheKey = 'upstox:nse-equity-instruments';
    const cached = await this.cache.get<unknown[]>(cacheKey);
    if (cached) return cached;
    const url = 'https://assets.upstox.com/market-quote/instruments/exchange/NSE.json.gz';
    try {
      const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 30_000 });
      const data = JSON.parse(gunzipSync(Buffer.from(response.data)).toString('utf8')) as unknown[];
      await this.cache.set(cacheKey, data, 12 * 60 * 60 * 1000);
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Unable to download Upstox NSE instruments: ${message}`);
      throw new BadGatewayException(`Unable to download the live Upstox NSE instrument list: ${message}`);
    }
  }
}
