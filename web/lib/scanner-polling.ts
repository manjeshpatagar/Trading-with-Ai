/** Keep the scan cadence independent of websocket writes to the query cache. */
export function startScannerPolling(refresh: () => Promise<unknown>, intervalMs = 30_000) {
  let running = false;
  console.info('[scanner] polling.started', { intervalMs });
  const timer = setInterval(() => {
    if (running) {
      console.warn('[scanner] polling.waiting_for_request');
      return;
    }
    running = true;
    console.info('[scanner] polling.tick', { at: new Date().toISOString() });
    void Promise.resolve().then(refresh).catch((error) => {
      console.error('[scanner] polling.failed', { message: error instanceof Error ? error.message : String(error), retryInMs: intervalMs });
    }).finally(() => { running = false; });
  }, intervalMs);
  return () => {
    clearInterval(timer);
    console.info('[scanner] polling.stopped', { reason: 'page unmounted or session changed' });
  };
}
