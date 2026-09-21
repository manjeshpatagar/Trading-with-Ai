export type NiftyCandle = {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};
export type Indicator = {
  ema20: number | null;
  ema50: number | null;
  vwap: number | null;
  volumeRatio: number;
  direction: string;
  regime: string;
  momentum: number;
};
export type Evaluation = {
  strategy: string;
  side: string;
  regime: string;
  score: number;
  valid: boolean;
  available?: boolean;
  setupId: string;
  reasons: string[];
  missing: string[];
  invalidations: string[];
  checks: {
    name: string;
    pass: boolean;
    reason: string;
    weight: number;
    available?: boolean;
    required?: boolean;
  }[];
  trade: {
    entry: number;
    stopLoss: number;
    target1: number;
    target2: number;
    target3: number;
    risk: number;
    riskReward: number;
  } | null;
};
export type Settings = {
  primaryTimeframe: number;
  setupTimeframe: number;
  confirmationTimeframe: number;
  openingRangeMinutes: number;
  minimumScore: number;
  minimumRR: number;
  riskPercent: number;
  dailyLossPercent: number;
  maxTrades: number;
  maxConsecutiveLosses: number;
  capital: number;
  cutoff: string;
  squareOff: string;
  windows: string[][];
  staleMs: number;
  maximumSpreadPercent: number;
  minimumOptionVolume: number;
  minimumVolumeRatio: number;
  safetyBuffer: number;
  minimumLevelDistance: number;
  minimumSamples: number;
  requireHistoricalPerformance: boolean;
  moveToBreakeven: boolean;
  trailAfterT2: boolean;
  strikeOffset: number;
  expiryMinimumDays: number;
  optionStopPercent: number;
  optionTargetR: number;
  enabledStrategies: string[];
};
export type OptionContract = {
  instrumentKey: string;
  symbol: string;
  expiry: string;
  strike: number;
  type: string;
  lotSize: number;
  ltp: number;
  bid: number;
  ask: number;
  spreadPercent: number;
  volume: number;
  oi: number | null;
  iv: number | null;
  delta: number | null;
  timestamp: number;
  quantity: number;
  maximumRisk: number;
};
export type Performance = {
  frequency?: {strategy:string;sessionDays:number;validSetups:number;trades:number;averageSetupsPerDay:number;averageTradesPerDay:number}[];
  label: string;
  strategies: {
    strategy: string;
    sampleSize: number;
    sufficient: boolean;
    minimumSamples: number;
    winRate: number | null;
    expectancyR: number | null;
    profitFactor: number | null;
    averageR: number | null;
    maximumDrawdownR: number | null;
    target1HitPercent: number | null;
    target2HitPercent: number | null;
    target3HitPercent: number | null;
    stopLossPercent: number | null;
    averageHoldingMinutes: number | null;
  }[];
};
export type NiftyView = {
  dataHealth: { status: string; newTradesEnabled: boolean; latestTick: number | null; tickAgeMs: number | null; websocketStatus: string; stale: boolean; timeframes: {timeframe:number; latest:string|null; latestClosed:string|null; ageMs:number|null; closedAgeMs:number|null; status:string}[] };
  today: {opportunities:number; target:number; remaining:number; trades:number; maxTrades:number};
  waitFor: string[];
  optionDataDelayed?: boolean;
  serverTime: string;
  market: {
    timestampTrusted: boolean;
    ltp: number;
    close: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    volume: number;
    timestamp: number;
  } | null;
  session: {
    status: string;
    open: number | null;
    close: number | null;
    timezone: string;
    cutoff: string;
    squareOff: string;
  };
  stale: boolean;
  historicalObservation: {
    sampleSize: number;
    sufficient: boolean;
    winRate: number | null;
    expectancyR: number | null;
  } | null;
  settings: Settings;
  regime: string;
  timeframes: {
    direction: Indicator;
    setup: Indicator;
    confirmation: Indicator;
  } | null;
  levels: Record<string, number | null | boolean>;
  strategies: Evaluation[];
  setup: Evaluation | null;
  option: OptionContract | null;
  risk: {
    trades: number;
    consecutiveLosses: number;
    losses: number;
    reserved: number;
    remaining: number;
    maximumRisk: number;
    reasons: string[];
  };
  noTradeReasons: string[];
  performance: Performance;
};
export type Signal = {
  marketTimestamp: number | null;
  id: string;
  strategy: string;
  side: string;
  status: string;
  entryPrice: number;
  entryExecutedPrice: number | null;
  stopLoss: number;
  target1: number;
  target2: number;
  target3: number;
  aiScore: number;
  signalGeneratedAt: string;
  entryTriggeredAt: string | null;
  exitPrice: number | null;
  currentPrice: number;
  niftyContext: {
    inputs: string;
    reasons: string;
    invalidations: string;
    optionContract: string;
  };
  events: {
    type: string;
    eventTime: string;
    executedPrice: number;
  }[];
};
export type CandleResponse = {
  candles: NiftyCandle[];
  indicators: Indicator;
  overlays: Record<string, {
    time: string;
    value: number;
  }[]>;
};

/** An in-flight REST snapshot must not overwrite a newer accepted live tick. */
export function mergeNiftyMarket(incoming:NiftyView,current:NiftyView|undefined):NiftyView {
  return current?.market&&(!incoming.market||current.market.timestamp>incoming.market.timestamp)?{...incoming,market:current.market}:incoming;
}
export function markNiftySignals(rows:Signal[],market:NiftyView['market']):Signal[]{
  return market?rows.map(row=>row.exitPrice===null&&(row.marketTimestamp===null||market.timestamp>=row.marketTimestamp)?{...row,currentPrice:market.ltp,marketTimestamp:market.timestamp}:row):rows;
}
