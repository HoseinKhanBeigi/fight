/**
 * Evaluation metrics, buckets, ablation, correlation, and time splits.
 * Percentages are never reported without a sample count.
 */

import {
  ABLATION_GROUPS,
  CONFIDENCE_BUCKETS,
  FIRST_BARRIER,
  MIN_SAMPLES_FOR_RATE,
  MODEL_IDS,
  PREDICTION,
  REDUNDANCY_CORR,
  SCORE_BUCKETS,
  SESSIONS,
} from "./constants.js";
import {
  mean,
  median,
  pearson,
  quantile,
  stdev,
  wilsonInterval,
} from "./math.js";
import { BARRIERS, BARRIER_KEYS } from "./constants.js";
import { hitVsBarrier, scoreAblation } from "./scores.js";
import { getStrategy } from "./strategy.js";

/**
 * Overlapping 15m windows are not independent observations, so the interval is
 * widened by using an effective sample size n / overlapFactor.
 */
function rate(hits, n, min = MIN_SAMPLES_FOR_RATE, overlapFactor = 1) {
  if (!n) {
    return { value: null, n: 0, nEff: 0, label: "INSUFFICIENT DATA", ci: { lo: null, hi: null } };
  }
  const value = hits / n;
  const nEff = Math.max(1, Math.floor(n / Math.max(overlapFactor, 1)));
  return {
    value,
    n,
    nEff,
    label: nEff < min ? "INSUFFICIENT DATA" : null,
    ci: wilsonInterval(value * nEff, nEff),
  };
}

function pct(x) {
  return x == null ? null : x * 100;
}

function emptyCounts() {
  return { n: 0, upFirst: 0, downFirst: 0, neither: 0 };
}

export function summarizeRows(rows, { model = "FULL_MICROSTRUCTURE_MODEL", minSamples = MIN_SAMPLES_FOR_RATE } = {}) {
  const labelled = (rows || []).filter((r) => r?.outcome);
  // Paths with a large hole may have missed a barrier touch entirely.
  const completed = labelled.filter((r) => r.outcome.coverage !== "GAPPY");
  const excludedGappy = labelled.length - completed.length;
  const independence = overlapOf(completed);
  const overlapFactor = independence.overlapFactor;
  const nAll = completed.length;
  let upFirst = 0;
  let downFirst = 0;
  let neither = 0;
  let hits = 0;
  let directional = 0;
  let tpUp = 0;
  let predUp = 0;
  let actualUp = 0;
  let tpDown = 0;
  let predDown = 0;
  let actualDown = 0;
  let fp = 0;
  let decisive = 0;
  let decisiveHits = 0;
  const ret = [];
  const signedRet = [];
  const mfe = [];
  const mae = [];
  const ttt = [];

  for (const r of completed) {
    const barrier = r.outcome.firstBarrier050;
    if (barrier === FIRST_BARRIER.UP_FIRST) {
      upFirst += 1;
      actualUp += 1;
    } else if (barrier === FIRST_BARRIER.DOWN_FIRST) {
      downFirst += 1;
      actualDown += 1;
    } else {
      neither += 1;
    }

    const pred =
      model === "FULL_MICROSTRUCTURE_MODEL"
        ? r.prediction?.label
        : r.prediction?.models?.[model]?.prediction;
    if (pred === PREDICTION.UP || pred === PREDICTION.DOWN) {
      directional += 1;
      if (pred === PREDICTION.UP) predUp += 1;
      if (pred === PREDICTION.DOWN) predDown += 1;
      const hit = hitVsBarrier(pred, barrier);
      if (hit) hits += 1;
      else fp += 1;
      if (barrier !== FIRST_BARRIER.NEITHER) {
        decisive += 1;
        if (hit) decisiveHits += 1;
      }
      if (pred === PREDICTION.UP && barrier === FIRST_BARRIER.UP_FIRST) tpUp += 1;
      if (pred === PREDICTION.DOWN && barrier === FIRST_BARRIER.DOWN_FIRST) tpDown += 1;
    }

    if (Number.isFinite(r.outcome.return15m)) {
      ret.push(r.outcome.return15m);
      if (pred === PREDICTION.DOWN) signedRet.push(-r.outcome.return15m);
      else if (pred === PREDICTION.UP) signedRet.push(r.outcome.return15m);
    }
    if (Number.isFinite(r.outcome.MFE)) mfe.push(r.outcome.MFE);
    if (Number.isFinite(r.outcome.MAE)) mae.push(r.outcome.MAE);
    if (Number.isFinite(r.outcome.timeToTarget)) ttt.push(r.outcome.timeToTarget);
  }

  const avgMfe = mean(mfe);
  const avgMae = mean(mae);
  const hitRate = rate(hits, directional, minSamples, overlapFactor);

  return {
    model,
    sampleCount: nAll,
    directionalCount: directional,
    excludedGappy,
    independence,
    UP_FIRST: rate(upFirst, nAll, minSamples, overlapFactor),
    DOWN_FIRST: rate(downFirst, nAll, minSamples, overlapFactor),
    NEITHER: rate(neither, nAll, minSamples, overlapFactor),
    overallHitRate: hitRate,
    hitRateExNeither: rate(decisiveHits, decisive, minSamples, overlapFactor),
    precisionUp: rate(tpUp, predUp, minSamples, overlapFactor),
    recallUp: rate(tpUp, actualUp, minSamples, overlapFactor),
    precisionDown: rate(tpDown, predDown, minSamples, overlapFactor),
    recallDown: rate(tpDown, actualDown, minSamples, overlapFactor),
    falsePositiveRate: rate(fp, directional, minSamples, overlapFactor),
    averageReturn15m: mean(ret),
    medianReturn15m: median(ret),
    averageSignedReturn15m: mean(signedRet),
    returnStdev: stdev(ret),
    averageMFE: avgMfe,
    averageMAE: avgMae,
    mfeMaeRatio: avgMae && avgMae > 0 && avgMfe != null ? avgMfe / avgMae : null,
    averageTimeToTarget: mean(ttt),
    insufficient: hitRate.label === "INSUFFICIENT DATA" || nAll < minSamples,
  };
}

/**
 * How many overlapping snapshots share the same 15m window, from the median
 * spacing between consecutive signals.
 */
function overlapOf(rows) {
  if (rows.length < 2) {
    return { spacingSec: null, overlapFactor: 1, effectiveSampleCount: rows.length };
  }
  const ts = rows.map((r) => r.timestamp).sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i] - ts[i - 1];
    if (d > 0) gaps.push(d);
  }
  const spacing = median(gaps);
  const horizon = rows[0]?.outcome?.horizonSec ?? 900;
  const overlapFactor =
    spacing && spacing > 0 ? Math.min(rows.length, Math.max(1, Math.round(horizon / spacing))) : 1;
  return {
    spacingSec: spacing,
    overlapFactor,
    effectiveSampleCount: Math.max(1, Math.floor(rows.length / overlapFactor)),
  };
}

export function bucketRows(rows, buckets, valueFn, model) {
  return buckets.map((b) => {
    const subset = rows.filter((r) => {
      const v = valueFn(r);
      return v != null && v >= b.lo && v < b.hi;
    });
    const s = summarizeRows(subset, { model });
    return {
      id: b.id,
      lo: b.lo,
      hi: b.hi,
      sampleCount: s.sampleCount,
      UP_FIRST: s.UP_FIRST,
      DOWN_FIRST: s.DOWN_FIRST,
      NEITHER: s.NEITHER,
      overallHitRate: s.overallHitRate,
      averageReturn15m: s.averageReturn15m,
      averageMFE: s.averageMFE,
      averageMAE: s.averageMAE,
      insufficient: s.insufficient,
    };
  });
}

export function byRegime(rows, model) {
  const keys = ["TREND", "RANGE", "COMPRESSION", "HIGH_VOLATILITY", "LOW_VOLATILITY"];
  const out = {};
  for (const key of keys) {
    const subset = rows.filter((r) => r.context?.regime?.tags?.includes(key) || r.context?.regime?.primary === key);
    out[key] = summarizeRows(subset, { model });
  }
  return out;
}

export function bySession(rows, model) {
  const out = { ASIA: null, EUROPE: null, US: null, hourly: [] };
  for (const sess of Object.values(SESSIONS)) {
    out[sess] = summarizeRows(
      rows.filter((r) => r.context?.session === sess),
      { model }
    );
  }
  for (let h = 0; h < 24; h++) {
    out.hourly.push({
      hour: h,
      ...summarizeRows(
        rows.filter((r) => r.context?.hour === h),
        { model }
      ),
    });
  }
  const byDow = [];
  for (let d = 0; d < 7; d++) {
    byDow.push({
      dayOfWeek: d,
      ...summarizeRows(
        rows.filter((r) => r.context?.dayOfWeek === d),
        { model }
      ),
    });
  }
  out.dayOfWeek = byDow;
  return out;
}

export function comparisonTable(rows, minSamples = MIN_SAMPLES_FOR_RATE) {
  return MODEL_IDS.map((model) => {
    const s = summarizeRows(rows, { model, minSamples });
    return {
      model,
      n: s.directionalCount,
      sampleCount: s.sampleCount,
      hitRate: s.overallHitRate,
      UP_FIRST: s.UP_FIRST,
      DOWN_FIRST: s.DOWN_FIRST,
      NEITHER: s.NEITHER,
      averageMFE: s.averageMFE,
      averageMAE: s.averageMAE,
    };
  });
}

export function ablationReport(rows, strategy = getStrategy()) {
  const full = summarizeRows(rows, { model: "FULL_MICROSTRUCTURE_MODEL" });
  return ABLATION_GROUPS.map((group) => {
    let hits = 0;
    let n = 0;
    for (const r of rows) {
      if (!r.outcome) continue;
      const scored = scoreAblation(r.features?.normalized, group, strategy);
      if (scored.prediction === PREDICTION.NO_EDGE) continue;
      n += 1;
      if (hitVsBarrier(scored.prediction, r.outcome.firstBarrier050)) hits += 1;
    }
    const ablated = rate(hits, n);
    const delta =
      full.overallHitRate.value != null && ablated.value != null
        ? full.overallHitRate.value - ablated.value
        : null;
    return {
      group,
      n,
      hitRate: ablated,
      fullHitRate: full.overallHitRate,
      deltaVsFull: delta,
      effect: delta == null ? "UNKNOWN" : delta > 0.005 ? "HELPS" : delta < -0.005 ? "HURTS" : "NEUTRAL",
    };
  });
}

export function correlationReport(rows) {
  const keys = [
    "AskCancellation",
    "AskReplenishment",
    "AskSurvival",
    "AskConsumption",
    "PassiveSellerDefense",
    "AggressiveBuyPower",
    "UpPressure",
    "UpPressureAcceleration",
    "UpsideBattleSpread",
    "BookImbalance",
    "BidCancellation",
    "BidReplenishment",
    "BidSurvival",
    "PassiveBuyerDefense",
    "AggressiveSellPower",
    "DownPressure",
  ];
  const series = {};
  for (const k of keys) series[k] = [];
  for (const r of rows) {
    const n = r.features?.normalized;
    if (!n) continue;
    for (const k of keys) series[k].push(n[k]);
  }
  const pairs = [];
  const redundant = [];
  for (let i = 0; i < keys.length; i++) {
    for (let j = i + 1; j < keys.length; j++) {
      const r = pearson(series[keys[i]], series[keys[j]]);
      if (r == null) continue;
      const row = { a: keys[i], b: keys[j], r };
      pairs.push(row);
      if (Math.abs(r) >= REDUNDANCY_CORR) redundant.push(row);
    }
  }
  pairs.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));
  return { pairs: pairs.slice(0, 24), redundant };
}

export function timeSplits(rows, { train = 0.6, validation = 0.2, test = 0.2 } = {}) {
  const sorted = [...rows].filter((r) => r.outcome).sort((a, b) => a.timestamp - b.timestamp);
  const n = sorted.length;
  const iTrain = Math.floor(n * train);
  const iVal = iTrain + Math.floor(n * validation);
  const parts = {
    TRAIN: sorted.slice(0, iTrain),
    VALIDATION: sorted.slice(iTrain, iVal),
    TEST: sorted.slice(iVal),
  };
  return {
    n,
    fractions: { train, validation, test },
    TRAIN: summarizeRows(parts.TRAIN),
    VALIDATION: summarizeRows(parts.VALIDATION),
    TEST: summarizeRows(parts.TEST),
    ranges: {
      TRAIN: span(parts.TRAIN),
      VALIDATION: span(parts.VALIDATION),
      TEST: span(parts.TEST),
    },
  };
}

function span(rows) {
  if (!rows.length) return { from: null, to: null, n: 0 };
  return { from: rows[0].timestamp, to: rows[rows.length - 1].timestamp, n: rows.length };
}

/**
 * Walk-forward folds. Train and test windows never overlap.
 * V1 does not fit weights — folds only measure frozen-model stability.
 */
export function walkForward(rows, { trainSec = 90 * 24 * 3600, testSec = 30 * 24 * 3600 } = {}) {
  const sorted = [...rows].filter((r) => r.outcome).sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length < MIN_SAMPLES_FOR_RATE * 2) {
    return { folds: [], note: "INSUFFICIENT DATA" };
  }
  const t0 = sorted[0].timestamp;
  const tEnd = sorted[sorted.length - 1].timestamp;
  const spanSec = tEnd - t0;
  let tr = trainSec;
  let te = testSec;
  if (spanSec < trainSec + testSec) {
    tr = Math.max(60, spanSec * 0.6);
    te = Math.max(60, spanSec * 0.2);
  }
  const folds = [];
  let origin = t0;
  while (origin + tr + te <= tEnd + 1) {
    const trainFrom = origin;
    const trainTo = origin + tr;
    const testFrom = trainTo;
    const testTo = trainTo + te;
    const trainRows = sorted.filter((r) => r.timestamp >= trainFrom && r.timestamp < trainTo);
    const testRows = sorted.filter((r) => r.timestamp >= testFrom && r.timestamp < testTo);
    folds.push({
      train: span(trainRows),
      test: span(testRows),
      trainMetrics: summarizeRows(trainRows),
      testMetrics: summarizeRows(testRows),
    });
    origin += te;
    if (folds.length >= 24) break;
  }
  return { folds, trainSec: tr, testSec: te };
}

export function stabilityByPeriod(rows, periodSec = 3600) {
  const sorted = [...rows].filter((r) => r.outcome).sort((a, b) => a.timestamp - b.timestamp);
  if (!sorted.length) return [];
  const t0 = sorted[0].timestamp;
  const buckets = [];
  let i = 0;
  while (i < sorted.length) {
    const start = t0 + Math.floor((sorted[i].timestamp - t0) / periodSec) * periodSec;
    const end = start + periodSec;
    const chunk = [];
    while (i < sorted.length && sorted[i].timestamp < end) {
      chunk.push(sorted[i]);
      i += 1;
    }
    buckets.push({
      from: start,
      to: end,
      ...summarizeRows(chunk),
    });
  }
  return buckets;
}

export function scoreBuckets(rows) {
  return bucketRows(
    rows,
    SCORE_BUCKETS,
    (r) => Math.abs(r.prediction?.directionalScore ?? 0),
    "FULL_MICROSTRUCTURE_MODEL"
  );
}

export function confidenceBuckets(rows) {
  return bucketRows(
    rows,
    CONFIDENCE_BUCKETS,
    (r) => r.prediction?.confidence,
    "FULL_MICROSTRUCTURE_MODEL"
  );
}

/**
 * Where did price go against a signal before it worked?
 *
 * A stop placed inside the MAE distribution of winning signals turns labelled
 * wins into live losses, so stop placement needs the tail, not the mean.
 */
export function excursionStats(rows, { minSamples = MIN_SAMPLES_FOR_RATE } = {}) {
  const usable = (rows || []).filter((r) => r?.outcome && r.outcome.coverage !== "GAPPY");
  const winners = { mae: [], mfe: [], tt: [] };
  const losers = { mae: [], mfe: [] };

  for (const r of usable) {
    const pred = r.prediction?.label;
    if (pred !== PREDICTION.UP && pred !== PREDICTION.DOWN) continue;
    const o = r.outcome;
    const bucket = hitVsBarrier(pred, o.firstBarrier050) ? winners : losers;
    if (Number.isFinite(o.MAE)) bucket.mae.push(o.MAE);
    if (Number.isFinite(o.MFE)) bucket.mfe.push(o.MFE);
    if (bucket === winners && Number.isFinite(o.timeToTarget)) winners.tt.push(o.timeToTarget);
  }

  const dist = (arr) => ({
    n: arr.length,
    p50: quantile(arr, 0.5),
    p75: quantile(arr, 0.75),
    p90: quantile(arr, 0.9),
    p95: quantile(arr, 0.95),
    max: arr.length ? Math.max(...arr) : null,
  });

  return {
    winners: { count: winners.mae.length, MAE: dist(winners.mae), MFE: dist(winners.mfe), timeToTarget: dist(winners.tt) },
    losers: { count: losers.mae.length, MAE: dist(losers.mae), MFE: dist(losers.mfe) },
    // A stop tighter than this would have cut off 10% of the signals that worked.
    suggestedStop: quantile(winners.mae, 0.9),
    insufficient: winners.mae.length < minSamples,
  };
}

/**
 * Exact stop/target evaluation from the recorded barrier crossing times.
 *
 * Unlike the first-barrier label, this answers the question a trade decision
 * layer actually asks: with this stop and this target, was the target reached
 * before the stop? Ties resolve against the trade.
 */
export function barrierGrid(rows, { minSamples = MIN_SAMPLES_FOR_RATE } = {}) {
  const usable = (rows || []).filter((r) => r?.outcome && r.outcome.coverage !== "GAPPY");
  const overlapFactor = overlapOf(usable).overlapFactor;
  const out = [];

  for (const stopKey of BARRIER_KEYS) {
    for (const targetKey of BARRIER_KEYS) {
      const stopPct = BARRIERS[stopKey];
      const targetPct = BARRIERS[targetKey];
      const rr = targetPct / stopPct;
      const s = stopKey.slice(1);
      const t = targetKey.slice(1);

      let wins = 0;
      let losses = 0;
      let timeouts = 0;
      const rMultiples = [];
      const timeToWin = [];

      for (const row of usable) {
        const pred = row.prediction?.label;
        if (pred !== PREDICTION.UP && pred !== PREDICTION.DOWN) continue;
        const o = row.outcome;
        const long = pred === PREDICTION.UP;
        const tTarget = long ? o[`TimeToUp${t}`] : o[`TimeToDown${t}`];
        const tStop = long ? o[`TimeToDown${s}`] : o[`TimeToUp${s}`];

        if (tTarget != null && (tStop == null || tTarget < tStop)) {
          wins += 1;
          rMultiples.push(rr);
          timeToWin.push(tTarget);
        } else if (tStop != null) {
          losses += 1;
          rMultiples.push(-1);
        } else {
          timeouts += 1;
          const signed = long ? o.return15m : -o.return15m;
          if (Number.isFinite(signed)) rMultiples.push(signed / stopPct);
        }
      }

      const n = wins + losses + timeouts;
      out.push({
        stop: stopPct,
        target: targetPct,
        rr,
        n,
        wins,
        losses,
        timeouts,
        winRate: rate(wins, n, minSamples, overlapFactor),
        expectancyR: mean(rMultiples),
        medianTimeToWin: median(timeToWin),
        insufficient: n < minSamples || Math.floor(n / overlapFactor) < minSamples,
      });
    }
  }
  return out;
}

export { rate, pct, emptyCounts };
