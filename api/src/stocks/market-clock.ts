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

export function marketClock(at = new Date(), autoExitRunning = false) {
  const value = parts(at);
  const secondOfDay = Number(value.hour) * 3600 + Number(value.minute) * 60 + Number(value.second);
  const open = 9 * 3600 + 15 * 60;
  const lastEntry = 15 * 3600 + 15 * 60;
  const closingSoon = 15 * 3600 + 20 * 60;
  const autoExit = 15 * 3600 + 25 * 60;
  const weekday = value.weekday;
  const tradingDay = !['Sat', 'Sun'].includes(weekday);
  let status: EodMarketStatus = 'MARKET CLOSED';
  if (autoExitRunning) status = 'AUTO EXIT RUNNING';
  else if (tradingDay && secondOfDay >= open && secondOfDay < closingSoon) status = 'OPEN';
  else if (tradingDay && secondOfDay >= closingSoon && secondOfDay < autoExit) status = 'CLOSING SOON';
  const tradingDate = `${value.year}-${value.month}-${value.day}`;
  const autoExitAt = new Date(`${tradingDate}T15:25:00+05:30`);
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
    canEnter: tradingDay && secondOfDay >= open && secondOfDay < lastEntry,
    closingSoon: tradingDay && secondOfDay >= closingSoon && secondOfDay < autoExit,
    shouldAutoExit: tradingDay && secondOfDay >= autoExit,
    secondsUntilAutoExit: tradingDay && secondOfDay < autoExit ? autoExit - secondOfDay : 0,
  };
}
