/** MICROSTRUCTURE BACKTEST + FORWARD TEST V1 constants. */

export const HORIZON_SEC = 900;

export const BARRIERS = Object.freeze({
  b025: 0.0025,
  b050: 0.005,
  b100: 0.01,
});

export const BARRIER_KEYS = Object.freeze(["b025", "b050", "b100"]);

export const FIRST_BARRIER = Object.freeze({
  UP_FIRST: "UP_FIRST",
  DOWN_FIRST: "DOWN_FIRST",
  NEITHER: "NEITHER",
});

export const PREDICTION = Object.freeze({
  UP: "UP",
  DOWN: "DOWN",
  NO_EDGE: "NO_EDGE",
});

export const FEED_STATUS = Object.freeze({
  OK: "OK",
  STALE: "STALE",
  NO_DATA: "NO_DATA",
  DEGRADED: "DEGRADED",
});

/** Categorical engine states stored as strings — never as ordinal ranks. */
export const PATH_STATES = Object.freeze([
  "BALANCED",
  "UPSIDE_PRESSURE_BUILDING",
  "DOWNSIDE_PRESSURE_BUILDING",
  "BUYERS_WINNING",
  "SELLERS_WINNING",
  "SELLER_ABSORPTION",
  "BUYER_ABSORPTION",
  "UPSIDE_VACUUM",
  "DOWNSIDE_VACUUM",
  "COMPRESSION",
  "LOW_CONFIDENCE",
]);

export const REGIME_PRIMARY = Object.freeze(["TREND", "RANGE", "COMPRESSION"]);
export const REGIME_VOL = Object.freeze(["HIGH_VOLATILITY", "LOW_VOLATILITY", "NORMAL"]);

export const SESSIONS = Object.freeze({
  ASIA: "ASIA",
  EUROPE: "EUROPE",
  US: "US",
});

export const MODEL_IDS = Object.freeze([
  "RANDOM_DIRECTION",
  "LAST_15M_DIRECTION",
  "BUY_SELL_DELTA_ONLY",
  "AGGRESSION_ONLY",
  "BOOK_IMBALANCE_ONLY",
  "PREMOVE_PRESSURE_ONLY",
  "FULL_MICROSTRUCTURE_MODEL",
]);

export const ABLATION_GROUPS = Object.freeze([
  "Cancellation",
  "Replenishment",
  "Survival",
  "Consumption",
  "PressureAcceleration",
  "BookImbalance",
  "BattleSpread",
  "Pressure",
  "Attack",
  "Defense",
  "BookContext",
]);

export const CORE_FEATURE_KEYS = Object.freeze([
  "UpPressure",
  "DownPressure",
  "AggressiveBuyPower",
  "AggressiveSellPower",
  "PassiveSellerDefense",
  "PassiveBuyerDefense",
  "AskCancellation",
  "BidCancellation",
  "AskReplenishment",
  "BidReplenishment",
  "AskConsumption",
  "BidConsumption",
  "AskSurvival",
  "BidSurvival",
  "UpsideBattleSpread",
  "DownsideBattleSpread",
  "Confidence",
]);

export const CONTEXT_FEATURE_KEYS = Object.freeze([
  "realizedVolatility",
  "shortTermVolatility",
  "ATRNormalized",
  "rangePercentile",
  "NearAskDepth",
  "NearBidDepth",
  "BookImbalance",
  "UpPressureVelocity",
  "DownPressureVelocity",
  "UpPressureAcceleration",
  "DownPressureAcceleration",
  "AskChurn",
  "BidChurn",
  "UpsideBookContext",
  "DownsideBookContext",
]);

export const OPTIONAL_FUTURES_KEYS = Object.freeze([
  "OpenInterest",
  "OpenInterestChange",
  "FundingRate",
  "LongLiquidations",
  "ShortLiquidations",
  "LiquidationImbalance",
]);

export const OPTIONAL_EVENT_KEYS = Object.freeze([
  "HighImpactEventNearby",
  "MinutesToEvent",
  "MinutesSinceEvent",
]);

export const SCORE_BUCKETS = Object.freeze([
  { id: "0-10", lo: 0, hi: 10 },
  { id: "10-20", lo: 10, hi: 20 },
  { id: "20-30", lo: 20, hi: 30 },
  { id: "30-40", lo: 30, hi: 40 },
  { id: "40-50", lo: 40, hi: 50 },
  { id: "50+", lo: 50, hi: Infinity },
]);

export const CONFIDENCE_BUCKETS = Object.freeze([
  { id: "0-20", lo: 0, hi: 20 },
  { id: "20-40", lo: 20, hi: 40 },
  { id: "40-60", lo: 40, hi: 60 },
  { id: "60-80", lo: 60, hi: 80 },
  { id: "80-100", lo: 80, hi: 100.0001 },
]);

export const MIN_SAMPLES_FOR_RATE = 30;
export const REDUNDANCY_CORR = 0.8;
