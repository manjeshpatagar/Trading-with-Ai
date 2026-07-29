export type ResolvedSignalStatus =
  | 'WAITING'
  | 'ENTRY_TRIGGERED'
  | 'RUNNING'
  | 'TARGET1_HIT'
  | 'TARGET2_HIT'
  | 'TARGET3_HIT'
  | 'STOPLOSS_HIT'
  | 'COMPLETED';

const normalize = (value: unknown) =>
  String(value ?? '').trim().toUpperCase().replaceAll('-', '_').replaceAll(' ', '_');

const FILTER_ALIASES: Record<string, ResolvedSignalStatus> = {
  WAITING: 'WAITING',
  ENTRY_TRIGGERED: 'ENTRY_TRIGGERED',
  RUNNING: 'RUNNING',
  TARGET_1: 'TARGET1_HIT',
  TARGET_1_HIT: 'TARGET1_HIT',
  TARGET1_HIT: 'TARGET1_HIT',
  TARGET_2: 'TARGET2_HIT',
  TARGET_2_HIT: 'TARGET2_HIT',
  TARGET2_HIT: 'TARGET2_HIT',
  TARGET_3: 'TARGET3_HIT',
  TARGET_3_HIT: 'TARGET3_HIT',
  TARGET3_HIT: 'TARGET3_HIT',
  STOP_LOSS: 'STOPLOSS_HIT',
  STOP_LOSS_HIT: 'STOPLOSS_HIT',
  STOPLOSS_HIT: 'STOPLOSS_HIT',
  TRADE_COMPLETED: 'COMPLETED',
  COMPLETED: 'COMPLETED',
};

const STOP_LOSS_VALUES = new Set([
  'STOP_LOSS',
  'STOP_LOSS_HIT',
  'STOPLOSS',
  'STOPLOSS_HIT',
  'STOPLOSS_TOUCHED',
  'STOPLOSS_CONFIRMED',
  'STOPLOSS_CONFIRMATION',
]);
const COMPLETION_VALUES = new Set([
  'COMPLETED',
  'CLOSED',
  'TARGET',
  'TARGET_HIT',
  'TARGET_1',
  'TARGET_2',
  'TARGET_3',
  'TARGET1_HIT',
  'TARGET2_HIT',
  'TARGET3_HIT',
  'STOP_LOSS',
  'STOP_LOSS_HIT',
  'STOPLOSS_HIT',
  'STOPLOSS_CONFIRMED',
  'MANUAL_EXIT',
  'MARKET_CLOSE',
  'MARKET_CLOSE_EXIT',
  'TRAILING_STOP',
  'AI_EXIT',
  'BREAK_EVEN',
  'BREAKEVEN',
]);

function collectLifecycleValues(value: unknown, key = '', output: string[] = [], seen = new Set<unknown>()) {
  if (value == null || seen.has(value)) return output;
  if (typeof value === 'string') {
    if (/status|reason|event|type|action|recommendation/i.test(key)) output.push(normalize(value));
    return output;
  }
  if (typeof value !== 'object') return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) collectLifecycleValues(item, key, output, seen);
  } else {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>))
      collectLifecycleValues(child, childKey, output, seen);
  }
  return output;
}

export function resolveSignalStatuses(trade: Record<string, unknown>) {
  const resolved = new Set<ResolvedSignalStatus>();
  const status = normalize(trade.status);
  const events = [
    ...((Array.isArray(trade.events) ? trade.events : []) as Array<Record<string, unknown>>),
    ...((Array.isArray(trade.tradeEvents) ? trade.tradeEvents : []) as Array<Record<string, unknown>>),
    ...((Array.isArray(trade.timeline) ? trade.timeline : []) as Array<Record<string, unknown>>),
    ...((trade.stopLossDecision && typeof trade.stopLossDecision === 'object' && Array.isArray((trade.stopLossDecision as Record<string, unknown>).timeline)
      ? (trade.stopLossDecision as { timeline: Array<Record<string, unknown>> }).timeline
      : [])),
  ];
  const eventTypes = events.map((event) => normalize(event.type ?? event.status ?? event.latestEvent));
  const allValues = new Set([status, ...eventTypes, ...collectLifecycleValues(trade)]);

  if (status === 'WAITING' || normalize(trade.latestEvent) === 'WAITING') resolved.add('WAITING');
  const entryWasTriggered = Boolean(trade.entryTriggeredAt) || allValues.has('ENTRY_TRIGGERED');
  const entryIsStillActive =
    status === 'ENTRY_TRIGGERED'
    && !trade.target1At
    && !trade.target2At
    && !trade.target3At
    && !trade.stopLossAt
    && !trade.completedAt
    && !allValues.has('MANUAL_EXIT');
  if (entryWasTriggered && entryIsStillActive) resolved.add('ENTRY_TRIGGERED');
  if (trade.runningAt || allValues.has('RUNNING') || ['RUNNING', 'TARGET1_HIT', 'TARGET2_HIT', 'TARGET3_HIT', 'COMPLETED', 'STOPLOSS_HIT', 'STOPLOSS_CONFIRMED'].includes(status)) resolved.add('RUNNING');
  if (trade.target1At || allValues.has('TARGET1_HIT') || allValues.has('TARGET_1_HIT')) resolved.add('TARGET1_HIT');
  if (trade.target2At || allValues.has('TARGET2_HIT') || allValues.has('TARGET_2_HIT')) resolved.add('TARGET2_HIT');
  if (trade.target3At || allValues.has('TARGET3_HIT') || allValues.has('TARGET_3_HIT')) resolved.add('TARGET3_HIT');
  if (trade.stopLossAt || [...allValues].some((value) => STOP_LOSS_VALUES.has(value))) resolved.add('STOPLOSS_HIT');
  if (trade.completedAt || [...allValues].some((value) => COMPLETION_VALUES.has(value)) || resolved.has('STOPLOSS_HIT')) resolved.add('COMPLETED');
  return resolved;
}

export function matchesStatusFilter(trade: Record<string, unknown>, value?: string | null) {
  const normalized = normalize(value || 'ALL');
  if (normalized === 'ALL') return true;
  const requested = FILTER_ALIASES[normalized];
  return requested ? resolveSignalStatuses(trade).has(requested) : normalize(trade.status) === normalized;
}

export function statusFilterDefinition(value?: string | null) {
  const normalized = normalize(value || 'ALL');
  if (normalized === 'ALL') return null;
  const requested = FILTER_ALIASES[normalized] ?? normalized;
  return { statuses: [requested], exitReasons: [requested, requested.replaceAll('_', ' ')] };
}
