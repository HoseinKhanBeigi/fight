/**
 * Frozen-formula scores for path-test v1.
 *
 * All model inputs are normalized 0–100. Raw values are never mixed into scores.
 * Confidence is a validity multiplier — it must not flip direction.
 */

import { FIRST_BARRIER, MODEL_IDS, PREDICTION } from "./constants.js";
import { clamp, combineWeighted, finite } from "./math.js";
import { getStrategy } from "./strategy.js";

function spreadTo100(spread) {
  const v = finite(spread);
  if (v == null) return null;
  return clamp(50 + v / 2, 0, 100);
}

function accelTo100(accel) {
  const v = finite(accel);
  if (v == null) return null;
  return clamp(50 + v, 0, 100);
}

function imbalanceTo100(imb) {
  const v = finite(imb);
  if (v == null) return null;
  // BookImbalance is typically -1..1. Also accept already-scaled -100..100 or 0..100.
  if (v >= 0 && v <= 100 && Math.abs(v) > 1.5) return clamp(v, 0, 100);
  if (v >= -100 && v <= 100 && Math.abs(v) > 1.5) return clamp(50 + v / 2, 0, 100);
  return clamp(50 + v * 50, 0, 100);
}

function hashSign(seed) {
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function confidenceFactor(confidence) {
  const c = finite(confidence);
  if (c == null) return null;
  return clamp(c / 100, 0, 1);
}

function predictFromScore(directionalScore, threshold) {
  const s = finite(directionalScore);
  if (s == null) return PREDICTION.NO_EDGE;
  if (Math.abs(s) < threshold) return PREDICTION.NO_EDGE;
  return s > 0 ? PREDICTION.UP : PREDICTION.DOWN;
}

function scoreFromSigned(signed, threshold) {
  const s = finite(signed);
  if (s == null) {
    return {
      directionalScore: null,
      prediction: PREDICTION.NO_EDGE,
      strength: null,
    };
  }
  const directionalScore = clamp(s, -100, 100);
  return {
    directionalScore,
    prediction: predictFromScore(directionalScore, threshold),
    strength: Math.abs(directionalScore),
  };
}

/**
 * Build 0–100 inputs for the full microstructure formula.
 * Percentile-normalized features are preferred; fallbacks stay null.
 */
export function modelInputs(normalized) {
  const n = normalized || {};
  const nearAsk = finite(n.NearAskDepth);
  const nearBid = finite(n.NearBidDepth);
  const upCtx =
    nearBid == null && nearAsk == null
      ? null
      : ((nearBid ?? 50) + (100 - (nearAsk ?? 50))) / 2;
  const downCtx =
    nearBid == null && nearAsk == null
      ? null
      : ((nearAsk ?? 50) + (100 - (nearBid ?? 50))) / 2;

  return {
    AggressiveBuyPower: finite(n.AggressiveBuyPower),
    AggressiveSellPower: finite(n.AggressiveSellPower),
    PassiveSellerDefense: finite(n.PassiveSellerDefense),
    PassiveBuyerDefense: finite(n.PassiveBuyerDefense),
    AskCancellation: finite(n.AskCancellation),
    BidCancellation: finite(n.BidCancellation),
    AskReplenishment: finite(n.AskReplenishment),
    BidReplenishment: finite(n.BidReplenishment),
    AskConsumption: finite(n.AskConsumption),
    BidConsumption: finite(n.BidConsumption),
    AskSurvival: finite(n.AskSurvival),
    BidSurvival: finite(n.BidSurvival),
    UpsideBattleSpread: finite(n.UpsideBattleSpread) ?? spreadTo100(n.UpsideBattleSpreadRaw),
    DownsideBattleSpread: finite(n.DownsideBattleSpread) ?? spreadTo100(n.DownsideBattleSpreadRaw),
    UpPressure: finite(n.UpPressure),
    DownPressure: finite(n.DownPressure),
    UpPressureAcceleration: finite(n.UpPressureAcceleration) ?? accelTo100(n.UpPressureAccelerationRaw),
    DownPressureAcceleration: finite(n.DownPressureAcceleration) ?? accelTo100(n.DownPressureAccelerationRaw),
    BookImbalance: finite(n.BookImbalance) ?? imbalanceTo100(n.BookImbalanceRaw),
    UpsideBookContext: finite(n.UpsideBookContext) ?? upCtx,
    DownsideBookContext: finite(n.DownsideBookContext) ?? downCtx,
    BuySellDelta: finite(n.BuySellDelta),
  };
}

export function scoreFullModel(normalized, strategy = getStrategy()) {
  const inputs = modelInputs(normalized);
  const up = combineWeighted(strategy.weights.upside, inputs);
  const down = combineWeighted(strategy.weights.downside, inputs);
  const upsideScore = up.score;
  const downsideScore = down.score;
  const directionalScore =
    upsideScore == null || downsideScore == null
      ? null
      : clamp(upsideScore - downsideScore, -100, 100);
  const conf = confidenceFactor(normalized?.Confidence);
  const strength =
    directionalScore == null || conf == null
      ? directionalScore == null
        ? null
        : Math.abs(directionalScore)
      : Math.abs(directionalScore) * conf;
  const threshold = strategy.thresholds.noEdgeAbsScore;
  return {
    model: "FULL_MICROSTRUCTURE_MODEL",
    upsideScore,
    downsideScore,
    directionalScore,
    confidence: finite(normalized?.Confidence),
    confidenceFactor: conf,
    finalDirectionalStrength: strength,
    prediction: predictFromScore(directionalScore, threshold),
    contributions: { up: up.contributions, down: down.contributions },
  };
}

function ablationInputs(normalized, group) {
  const inputs = { ...modelInputs(normalized) };
  const zero = (keys) => {
    for (const k of keys) inputs[k] = null;
  };
  switch (group) {
    case "Cancellation":
      zero(["AskCancellation", "BidCancellation"]);
      break;
    case "Replenishment":
      zero(["AskReplenishment", "BidReplenishment"]);
      break;
    case "Survival":
      zero(["AskSurvival", "BidSurvival"]);
      break;
    case "Consumption":
      zero(["AskConsumption", "BidConsumption"]);
      break;
    case "PressureAcceleration":
      zero(["UpPressureAcceleration", "DownPressureAcceleration"]);
      break;
    case "BookImbalance":
      zero(["BookImbalance"]);
      break;
    case "BattleSpread":
      zero(["UpsideBattleSpread", "DownsideBattleSpread"]);
      break;
    case "Pressure":
      zero(["UpPressure", "DownPressure"]);
      break;
    case "Attack":
      zero(["AggressiveBuyPower", "AggressiveSellPower"]);
      break;
    case "Defense":
      zero(["PassiveSellerDefense", "PassiveBuyerDefense"]);
      break;
    case "BookContext":
      zero(["UpsideBookContext", "DownsideBookContext"]);
      break;
    default:
      break;
  }
  return inputs;
}

export function scoreAblation(normalized, group, strategy = getStrategy()) {
  const inputs = ablationInputs(normalized, group);
  const up = combineWeighted(strategy.weights.upside, inputs);
  const down = combineWeighted(strategy.weights.downside, inputs);
  const directionalScore =
    up.score == null || down.score == null ? null : clamp(up.score - down.score, -100, 100);
  return {
    model: `FULL_MINUS_${group.toUpperCase()}`,
    group,
    directionalScore,
    prediction: predictFromScore(directionalScore, strategy.thresholds.noEdgeAbsScore),
  };
}

export function scoreBaselines(normalized, ctx = {}, strategy = getStrategy()) {
  const n = normalized || {};
  const thr = strategy.thresholds.noEdgeAbsScore;
  const seed = ctx.id || ctx.timestamp || "0";

  const random = hashSign(seed) % 2 === 0 ? PREDICTION.UP : PREDICTION.DOWN;

  const lastRet = finite(ctx.last15mReturn);
  const last15 = scoreFromSigned(lastRet == null ? null : clamp(lastRet * 20_000, -100, 100), thr);

  // BuySellDelta arrives as a 0–100 percentile; center it so low percentiles mean DOWN.
  const delta = finite(n.BuySellDelta);
  const buySell = scoreFromSigned(delta == null ? null : delta - 50, thr);

  const agg =
    finite(n.AggressiveBuyPower) != null && finite(n.AggressiveSellPower) != null
      ? finite(n.AggressiveBuyPower) - finite(n.AggressiveSellPower)
      : null;
  const aggression = scoreFromSigned(agg, thr);

  const imb = finite(n.BookImbalance) ?? imbalanceTo100(n.BookImbalanceRaw);
  const book = scoreFromSigned(imb == null ? null : imb - 50, thr);

  const press =
    finite(n.UpPressure) != null && finite(n.DownPressure) != null
      ? finite(n.UpPressure) - finite(n.DownPressure)
      : null;
  const pressure = scoreFromSigned(press, thr);

  return {
    RANDOM_DIRECTION: {
      model: "RANDOM_DIRECTION",
      directionalScore: random === PREDICTION.UP ? 1 : -1,
      prediction: random,
    },
    LAST_15M_DIRECTION: { model: "LAST_15M_DIRECTION", ...last15 },
    BUY_SELL_DELTA_ONLY: { model: "BUY_SELL_DELTA_ONLY", ...buySell },
    AGGRESSION_ONLY: { model: "AGGRESSION_ONLY", ...aggression },
    BOOK_IMBALANCE_ONLY: { model: "BOOK_IMBALANCE_ONLY", ...book },
    PREMOVE_PRESSURE_ONLY: { model: "PREMOVE_PRESSURE_ONLY", ...pressure },
  };
}

export function scoreSnapshot(normalized, ctx = {}, strategy = getStrategy()) {
  const full = scoreFullModel(normalized, strategy);
  const baselines = scoreBaselines(normalized, ctx, strategy);
  return {
    full,
    baselines,
    models: {
      ...baselines,
      FULL_MICROSTRUCTURE_MODEL: full,
    },
  };
}

export function hitVsBarrier(prediction, firstBarrier) {
  if (prediction === PREDICTION.NO_EDGE) return null;
  if (!firstBarrier || firstBarrier === FIRST_BARRIER.NEITHER) return false;
  if (prediction === PREDICTION.UP) return firstBarrier === FIRST_BARRIER.UP_FIRST;
  if (prediction === PREDICTION.DOWN) return firstBarrier === FIRST_BARRIER.DOWN_FIRST;
  return false;
}

export { MODEL_IDS, predictFromScore, spreadTo100, imbalanceTo100 };
