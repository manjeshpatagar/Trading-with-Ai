export type StatusFilterDefinition = { statuses: string[]; exitReasons: string[] };

const FILTERS: Record<string, StatusFilterDefinition> = {
  TRADE_COMPLETED: { statuses: ['COMPLETED'], exitReasons: ['COMPLETED'] },
  COMPLETED: { statuses: ['COMPLETED'], exitReasons: ['COMPLETED'] },
  STOP_LOSS_HIT: {
    statuses: ['STOP_LOSS', 'STOP_LOSS_HIT', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'],
    exitReasons: ['STOP LOSS', 'STOP_LOSS', 'STOP_LOSS_HIT', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'],
  },
  STOPLOSS_HIT: {
    statuses: ['STOP_LOSS', 'STOP_LOSS_HIT', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'],
    exitReasons: ['STOP LOSS', 'STOP_LOSS', 'STOP_LOSS_HIT', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'],
  },
  TARGET_HIT: {
    statuses: ['TARGET', 'TARGET_HIT', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT'],
    exitReasons: ['TARGET', 'TARGET HIT', 'TARGET_HIT', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT'],
  },
  AI_EXIT: { statuses: ['AI_EXIT'], exitReasons: ['AI EXIT', 'AI_EXIT'] },
  MANUAL_EXIT: { statuses: ['MANUAL_EXIT'], exitReasons: ['MANUAL EXIT', 'MANUAL_EXIT'] },
};

export function statusFilterDefinition(value?: string | null): StatusFilterDefinition | null {
  const normalized = String(value ?? 'ALL').trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');
  if (normalized === 'ALL') return null;
  return FILTERS[normalized] ?? { statuses: [normalized], exitReasons: [normalized, normalized.replaceAll('_', ' ')] };
}

export function matchesStatusFilter(
  trade: { status?: string | null; exitReason?: string | null; eventTypes?: string[] },
  value?: string | null,
) {
  const filter = statusFilterDefinition(value);
  if (!filter) return true;
  const normalized = (input?: string | null) => String(input ?? '').trim().toUpperCase();
  return filter.statuses.map(normalized).includes(normalized(trade.status))
    || filter.exitReasons.map(normalized).includes(normalized(trade.exitReason))
    || (trade.eventTypes ?? []).some((event) => filter.exitReasons.map(normalized).includes(normalized(event)));
}
