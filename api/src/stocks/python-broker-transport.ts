import axios, { AxiosRequestConfig } from 'axios';

/** Transport only: rate budgets, retries, order state and strategies stay in Node. */
export function pythonTransportConfig() {
  const value = process.env.PYTHON_MARKET_URL;
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('PYTHON_MARKET_URL must be a loopback HTTP origin');
  }
  const key = process.env.PYTHON_MARKET_KEY ?? '';
  if (key.length < 32) throw new Error('PYTHON_MARKET_KEY must contain at least 32 characters');
  return { origin: url.origin, key };
}

export async function pythonBrokerRequest(config: AxiosRequestConfig) {
  const transport = pythonTransportConfig();
  if (!transport) throw new Error('Python broker transport is not configured');
  return axios.post(`${transport.origin}/broker`, {
    method: String(config.method ?? 'GET').toUpperCase(), url: config.url,
    params: config.params, data: config.data, headers: config.headers,
    timeoutMs: config.timeout ?? 15_000,
  }, {
    headers: { 'X-Python-Market-Key': transport.key },
    timeout: (config.timeout ?? 15_000) + 1_000,
    maxRedirects: 0,
  });
}

export function pythonBrokerStream(url: string, accessToken: string) {
  const transport = pythonTransportConfig();
  return transport ? {
    url: `${transport.origin.replace(/^http:/, 'ws:')}/stream`,
    headers: { 'X-Python-Market-Key': transport.key, 'X-Broker-Stream-Url': url,
      'X-Broker-Authorization': `Bearer ${accessToken}` },
  } : { url, headers: { Authorization: `Bearer ${accessToken}`, Accept: '*/*' } };
}
