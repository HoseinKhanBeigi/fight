/**
 * 15-minute path labeling.
 *
 * Uses only ticks with t > T and t <= T + horizon.
 * First-barrier classification walks the path in time order.
 */

import { BARRIERS, BARRIER_KEYS, FIRST_BARRIER, HORIZON_SEC, PREDICTION } from "./constants.js";
import { signedBps } from "./math.js";

function ticksAfter(ticks, t0, horizonSec) {
  const t1 = t0 + horizonSec;
  const out = [];
  for (const row of ticks || []) {
    if (!row || !Number.isFinite(row.t) || !Number.isFinite(row.price)) continue;
    if (row.t <= t0) continue;
    if (row.t > t1) continue;
    out.push(row);
  }
  return out;
}

function firstHit(priceAtT, barrier, ticks, side) {
  const target =
    side === "up" ? priceAtT * (1 + barrier) : priceAtT * (1 - barrier);
  for (const row of ticks) {
    if (side === "up" && row.price >= target) return row.t;
    if (side === "down" && row.price <= target) return row.t;
  }
  return null;
}

function firstBarrier(priceAtT, barrier, ticks) {
  const upT = firstHit(priceAtT, barrier, ticks, "up");
  const downT = firstHit(priceAtT, barrier, ticks, "down");
  if (upT == null && downT == null) return FIRST_BARRIER.NEITHER;
  if (upT == null) return FIRST_BARRIER.DOWN_FIRST;
  if (downT == null) return FIRST_BARRIER.UP_FIRST;
  if (upT < downT) return FIRST_BARRIER.UP_FIRST;
  if (downT < upT) return FIRST_BARRIER.DOWN_FIRST;
  // Same timestamp (gap through both): use the tick's direction from the price just before it.
  const hitIndex = ticks.findIndex((r) => r.t === upT);
  const hit = hitIndex >= 0 ? ticks[hitIndex] : null;
  const from = hitIndex > 0 ? ticks[hitIndex - 1].price : priceAtT;
  if (hit && hit.price >= from) return FIRST_BARRIER.UP_FIRST;
  return FIRST_BARRIER.DOWN_FIRST;
}

/**
 * @param {object} args
 * @param {number} args.t0 signal time (seconds)
 * @param {number} args.priceAtT
 * @param {Array<{t:number, price:number}>} args.ticks
 * @param {number} [args.horizonSec]
 * @param {"UP"|"DOWN"|"NO_EDGE"} [args.prediction]
 * @param {number} [args.now] if provided and now < t0+horizon, returns null (pending)
 */
export function labelPath({
  t0,
  priceAtT,
  ticks,
  horizonSec = HORIZON_SEC,
  prediction = PREDICTION.NO_EDGE,
  now = null,
  maxGapSec = 90,
}) {
  if (!Number.isFinite(priceAtT) || priceAtT <= 0 || !Number.isFinite(t0)) return null;
  if (now != null && now + 1e-9 < t0 + horizonSec) return null;

  const path = ticksAfter(ticks, t0, horizonSec);

  // Largest hole in the observed path, including the edges of the window.
  let gap = 0;
  let prevT = t0;
  for (const row of path) {
    gap = Math.max(gap, row.t - prevT);
    prevT = row.t;
  }
  gap = Math.max(gap, t0 + horizonSec - prevT);
  const coverage = gap > maxGapSec ? "GAPPY" : "FULL";
  const last = path.length ? path[path.length - 1].price : priceAtT;
  const return15m = (last - priceAtT) / priceAtT;

  let peak = priceAtT;
  let trough = priceAtT;
  let timeToMaxUp = null;
  let timeToMaxDown = null;
  for (const row of path) {
    if (row.price > peak) {
      peak = row.price;
      timeToMaxUp = row.t - t0;
    }
    if (row.price < trough) {
      trough = row.price;
      timeToMaxDown = row.t - t0;
    }
  }

  const maxUp15m = (peak - priceAtT) / priceAtT;
  const maxDown15m = (trough - priceAtT) / priceAtT;

  const dir = prediction === PREDICTION.UP ? 1 : prediction === PREDICTION.DOWN ? -1 : 0;
  let mfePct;
  let maePct;
  let maeMfeBasis;
  if (dir > 0) {
    mfePct = maxUp15m;
    maePct = Math.abs(maxDown15m);
    maeMfeBasis = "BULLISH";
  } else if (dir < 0) {
    mfePct = -maxDown15m;
    maePct = Math.abs(maxUp15m);
    maeMfeBasis = "BEARISH";
  } else {
    mfePct = maxUp15m;
    maePct = Math.abs(maxDown15m);
    maeMfeBasis = "UNSIGNED";
  }

  const times = {};
  const hits = {};
  const first = {};
  for (const key of BARRIER_KEYS) {
    const b = BARRIERS[key];
    const upAt = firstHit(priceAtT, b, path, "up");
    const downAt = firstHit(priceAtT, b, path, "down");
    const suffix = key.slice(1);
    times[`TimeToUp${suffix}`] = upAt == null ? null : upAt - t0;
    times[`TimeToDown${suffix}`] = downAt == null ? null : downAt - t0;
    hits[`HitUp${suffix}`] = upAt != null;
    hits[`HitDown${suffix}`] = downAt != null;
    first[`firstBarrier${suffix}`] = firstBarrier(priceAtT, b, path);
  }

  let timeToTarget = null;
  if (prediction === PREDICTION.UP) timeToTarget = times.TimeToUp050;
  else if (prediction === PREDICTION.DOWN) timeToTarget = times.TimeToDown050;

  return {
    horizonSec,
    tickCount: path.length,
    maxGapSec: gap,
    coverage,
    return15m,
    return15mBps: signedBps(return15m),
    maxUp15m,
    maxDown15m,
    maxUp15mBps: signedBps(maxUp15m),
    maxDown15mBps: signedBps(maxDown15m),
    timeToMaxUp,
    timeToMaxDown,
    MFE: mfePct,
    MAE: maePct,
    MFE_bps: signedBps(mfePct),
    MAE_bps: signedBps(maePct),
    maeMfeBasis,
    timeToTarget,
    ...hits,
    ...times,
    ...first,
    firstBarrier025: first.firstBarrier025,
    firstBarrier050: first.firstBarrier050,
    firstBarrier100: first.firstBarrier100,
  };
}

export function outcomePending(t0, horizonSec = HORIZON_SEC, now) {
  return now + 1e-9 < t0 + horizonSec;
}

export { ticksAfter };
