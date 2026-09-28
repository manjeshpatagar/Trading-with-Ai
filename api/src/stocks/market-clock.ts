const ZONE = 'Asia/Kolkata';

export type EodMarketStatus = 'OPEN' | 'CLOSING SOON' | 'AUTO EXIT RUNNING' | 'MARKET CLOSED';

function parts(at: Date) {
  const values = new Intl.DateTimeFormat('en-CA', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(at);
  return Object.fromEntries(values.map((part) => [part.type, part.value]));
}

export function marketClock(at = new Date(), autoExitRunning = false, session: 'STANDARD' | 'STRATEGY_DEMO' = 'STANDARD') {
  const value = parts(at);
  const secondOfDay = Number(value.hour) * 3600 + Number(value.minute) * 60 + Number(value.second);
  const open = 9 * 3600 + 15 * 60;
  const tradingStart = 9 * 3600 + 20 * 60;
  const strategyDemo = session === 'STRATEGY_DEMO';
  const lastEntry = 15 * 3600 + (strategyDemo ? 20 : 15) * 60;
  const closingSoon = 15 * 3600 + (strategyDemo ? 15 : 20) * 60;
  const autoExit = 15 * 3600 + (strategyDemo ? 20 : 25) * 60;
  const weekday = value.weekday;
  const tradingDay = !['Sat', 'Sun'].includes(weekday);
  let status: EodMarketStatus = 'MARKET CLOSED';
  if (autoExitRunning) status = 'AUTO EXIT RUNNING';
  else if (tradingDay && secondOfDay >= open && secondOfDay < closingSoon) status = 'OPEN';
  else if (tradingDay && secondOfDay >= closingSoon && secondOfDay < autoExit) status = 'CLOSING SOON';
  const tradingDate = `${value.year}-${value.month}-${value.day}`;
  const autoExitAt = new Date(`${tradingDate}T15:${strategyDemo ? '20' : '25'}:00+05:30`);
  let nextSession = new Date(`${tradingDate}T09:15:00+05:30`);
  if (secondOfDay >= open || !tradingDay) {
    do nextSession = new Date(nextSession.getTime() + 24 * 60 * 60_000);
    while (['Sat', 'Sun'].includes(parts(nextSession).weekday));
  }
  return {
    timezone: ZONE,
    status,
    tradingDate,
    serverTime: at.toISOString(),
    autoExitAt: autoExitAt.toISOString(),
    nextSessionAt: nextSession.toISOString(),
    beforeTradingStart: secondOfDay < tradingStart,
    openingProtection: tradingDay && secondOfDay >= open && secondOfDay < tradingStart,
    canEnter: tradingDay && secondOfDay >= tradingStart && secondOfDay < lastEntry,
    canScan: tradingDay && secondOfDay >= open && secondOfDay < 15 * 3600 + 30 * 60,
    closingSoon: tradingDay && secondOfDay >= closingSoon && secondOfDay < autoExit,
    shouldAutoExit: tradingDay && secondOfDay >= autoExit,
    secondsUntilAutoExit: tradingDay && secondOfDay < autoExit ? autoExit - secondOfDay : 0,
  };
}

/** AI Trade Strategy demo session; broker and other portfolio hours are unchanged. */
export function strategyDemoClock(at = new Date(), autoExitRunning = false) {
  return marketClock(at, autoExitRunning, 'STRATEGY_DEMO');
}
