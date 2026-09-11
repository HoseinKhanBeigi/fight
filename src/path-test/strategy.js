/**
 * Frozen strategy versions for path-test scoring.
 *
 * A formula / weight / threshold / feature-set change MUST mint a new version.
 * Never rewrite historical snapshots onto a newer version.
 */

import {
  ABLATION_GROUPS,
  BARRIERS,
  CONTEXT_FEATURE_KEYS,
  CORE_FEATURE_KEYS,
  HORIZON_SEC,
  MIN_SAMPLES_FOR_RATE,
} from "./constants.js";

const FEATURE_SET_V1 = Object.freeze([
  ...CORE_FEATURE_KEYS,
  ...CONTEXT_FEATURE_KEYS,
]);

/**
 * Baseline (unoptimized) weights for PREMOVE_V1.0.
 * Signs match the spec. Magnitudes are placeholders for later calibration.
 */
const UPSIDE_WEIGHTS_V1 = Object.freeze({
  AggressiveBuyPower: 1.0,
  PassiveSellerDefense: -0.85,
  AskCancellation: 0.7,
  AskReplenishment: -0.6,
  AskConsumption: 0.7,
  AskSurvival: -0.6,
  UpsideBattleSpread: 0.8,
  UpPressure: 1.0,
  UpPressureAcceleration: 0.5,
  BookImbalance: 0.45,
  UpsideBookContext: 0.4,
});

const DOWNSIDE_WEIGHTS_V1 = Object.freeze({
  AggressiveSellPower: 1.0,
  PassiveBuyerDefense: -0.85,
  BidCancellation: 0.7,
  BidReplenishment: -0.6,
  BidConsumption: 0.7,
  BidSurvival: -0.6,
  DownsideBattleSpread: 0.8,
  DownPressure: 1.0,
  DownPressureAcceleration: 0.5,
  BookImbalance: -0.45,
  DownsideBookContext: 0.4,
});

export const STRATEGY_PREMOVE_V1_0 = Object.freeze({
  version: "PREMOVE_V1.0",
  name: "MICROSTRUCTURE_PATH_V1",
  featureSet: FEATURE_SET_V1,
  weights: Object.freeze({
    upside: UPSIDE_WEIGHTS_V1,
    downside: DOWNSIDE_WEIGHTS_V1,
  }),
  thresholds: Object.freeze({
    /** |DirectionalScore| below this → NO_EDGE. Calibratable; not a final edge claim. */
    noEdgeAbsScore: 15,
    minSamples: MIN_SAMPLES_FOR_RATE,
  }),
  normalizationConfig: Object.freeze({
    methods: Object.freeze(["rolling_percentile", "rolling_zscore", "median_mad"]),
    minSamples: 8,
    maxSamples: 480,
    scale: Object.freeze([0, 100]),
    causal: true,
  }),
  horizonSec: HORIZON_SEC,
  barriers: BARRIERS,
  primaryBarrier: "b050",
  ablationGroups: ABLATION_GROUPS,
  optimizeWeights: false,
});

export const STRATEGIES = Object.freeze({
  "PREMOVE_V1.0": STRATEGY_PREMOVE_V1_0,
});

export function getStrategy(version = "PREMOVE_V1.0") {
  const s = STRATEGIES[version];
  if (!s) {
    throw new Error(`Unknown strategy version: ${version}`);
  }
  return s;
}

export function strategyFingerprint(strategy) {
  return JSON.stringify({
    version: strategy.version,
    weights: strategy.weights,
    thresholds: strategy.thresholds,
    normalizationConfig: strategy.normalizationConfig,
    featureSet: strategy.featureSet,
    horizonSec: strategy.horizonSec,
    barriers: strategy.barriers,
    primaryBarrier: strategy.primaryBarrier,
  });
}
