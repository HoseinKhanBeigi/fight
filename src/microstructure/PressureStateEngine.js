/**
 * Pre-move state machine with hysteresis.
 * Context labels only — never BUY/SELL/LONG/SHORT.
 */

import { signed } from "./math.js";

export const PRE_MOVE_STATES = {
  NO_PRESSURE: "NO_PRESSURE",
  BALANCED: "BALANCED",
  COMPRESSION: "COMPRESSION",
  UPSIDE_PRESSURE_BUILDING: "UPSIDE_PRESSURE_BUILDING",
  DOWNSIDE_PRESSURE_BUILDING: "DOWNSIDE_PRESSURE_BUILDING",
  STRONG_UPSIDE_PRESSURE: "STRONG_UPSIDE_PRESSURE",
  STRONG_DOWNSIDE_PRESSURE: "STRONG_DOWNSIDE_PRESSURE",
  UPSIDE_LIQUIDITY_VACUUM_FORMING: "UPSIDE_LIQUIDITY_VACUUM_FORMING",
  DOWNSIDE_LIQUIDITY_VACUUM_FORMING: "DOWNSIDE_LIQUIDITY_VACUUM_FORMING",
  UPPER_DEFENSE_WEAKENING: "UPPER_DEFENSE_WEAKENING",
  LOWER_DEFENSE_WEAKENING: "LOWER_DEFENSE_WEAKENING",
  TWO_SIDED_PRESSURE: "TWO_SIDED_PRESSURE",
  TRANSIENT_SPIKE: "TRANSIENT_SPIKE",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  MULTI_TIMEFRAME_UP_PRESSURE: "MULTI_TIMEFRAME_UP_PRESSURE",
  MULTI_TIMEFRAME_DOWN_PRESSURE: "MULTI_TIMEFRAME_DOWN_PRESSURE",
};

export class PressureStateEngine {
  constructor(hysteresis = {}) {
    this.h = {
      strongEnter: 80,
      strongExit: 65,
      buildingEnter: 58,
      buildingExit: 48,
      minPersistenceMs: 1500,
      cooldownMs: 800,
      transientMaxSec: 4,
      ...hysteresis,
    };
    this.committed = PRE_MOVE_STATES.NO_PRESSURE;
    this.pending = null;
    this.pendingSince = 0;
    this.lastCommitTs = 0;
    this.strongUp = false;
    this.strongDown = false;
  }

  clear() {
    this.committed = PRE_MOVE_STATES.NO_PRESSURE;
    this.pending = null;
    this.pendingSince = 0;
    this.lastCommitTs = 0;
    this.strongUp = false;
    this.strongDown = false;
  }

  /**
   * Classify a candidate, then apply hysteresis / cooldown.
   */
  classify(nowMs, candidate, confidence) {
    if (confidence < 35) {
      return this._commit(nowMs, PRE_MOVE_STATES.LOW_CONFIDENCE, true);
    }

    const desired = candidate;
    if (desired === this.committed) {
      this.pending = null;
      return this.committed;
    }

    const now = nowMs;
    if (now - this.lastCommitTs < this.h.cooldownMs && this.committed !== PRE_MOVE_STATES.LOW_CONFIDENCE) {
      return this.committed;
    }

    if (this.pending !== desired) {
      this.pending = desired;
      this.pendingSince = now;
      return this.committed;
    }

    if (now - this.pendingSince < this.h.minPersistenceMs) {
      return this.committed;
    }

    return this._commit(now, desired, false);
  }

  _commit(now, state, immediate) {
    if (!immediate && state === this.committed) return state;
    this.committed = state;
    this.pending = null;
    this.lastCommitTs = now;
    if (state === PRE_MOVE_STATES.STRONG_UPSIDE_PRESSURE) this.strongUp = true;
    if (state === PRE_MOVE_STATES.STRONG_DOWNSIDE_PRESSURE) this.strongDown = true;
    if (state !== PRE_MOVE_STATES.STRONG_UPSIDE_PRESSURE) this.strongUp = false;
    if (state !== PRE_MOVE_STATES.STRONG_DOWNSIDE_PRESSURE) this.strongDown = false;
    return state;
  }

  /**
   * Pick the raw candidate before hysteresis.
   */
  candidate(ctx) {
    const {
      up,
      down,
      imbalance,
      upTrend,
      downTrend,
      upAcc,
      downAcc,
      upPers,
      downPers,
      askDefense,
      bidDefense,
      upAttack,
      downAttack,
      upBook,
      downBook,
      alignmentLabel,
      confidence,
    } = ctx;

    if (confidence < 35) return PRE_MOVE_STATES.LOW_CONFIDENCE;

    const upElev = up >= this.h.buildingEnter;
    const downElev = down >= this.h.buildingEnter;
    const upStrongNow = this.strongUp ? up >= this.h.strongExit : up >= this.h.strongEnter;
    const downStrongNow = this.strongDown ? down >= this.h.strongExit : down >= this.h.strongEnter;

    const vacuumUp =
      upBook >= 72 &&
      askDefense >= 68 &&
      upAttack < 62;
    const vacuumDown =
      downBook >= 72 &&
      bidDefense >= 68 &&
      downAttack < 62;

    const transientUp =
      up >= this.h.strongEnter &&
      (upPers.label === "TRANSIENT" || upPers.durationSeconds < this.h.transientMaxSec);
    const transientDown =
      down >= this.h.strongEnter &&
      (downPers.label === "TRANSIENT" || downPers.durationSeconds < this.h.transientMaxSec);

    if ((transientUp || transientDown) && Math.abs(imbalance) >= 20) {
      return PRE_MOVE_STATES.TRANSIENT_SPIKE;
    }

    if (alignmentLabel === "MULTI_TIMEFRAME_UP_PRESSURE" && upElev) {
      if (upStrongNow && upPers.persistence >= 55 && upAcc >= 0) {
        return PRE_MOVE_STATES.STRONG_UPSIDE_PRESSURE;
      }
    }
    if (alignmentLabel === "MULTI_TIMEFRAME_DOWN_PRESSURE" && downElev) {
      if (downStrongNow && downPers.persistence >= 55 && downAcc >= 0) {
        return PRE_MOVE_STATES.STRONG_DOWNSIDE_PRESSURE;
      }
    }

    if (vacuumUp && !vacuumDown) return PRE_MOVE_STATES.UPSIDE_LIQUIDITY_VACUUM_FORMING;
    if (vacuumDown && !vacuumUp) return PRE_MOVE_STATES.DOWNSIDE_LIQUIDITY_VACUUM_FORMING;

    if (
      upStrongNow &&
      upPers.persistence >= 55 &&
      upAcc >= 0 &&
      askDefense >= 60 &&
      imbalance >= 18
    ) {
      return PRE_MOVE_STATES.STRONG_UPSIDE_PRESSURE;
    }
    if (
      downStrongNow &&
      downPers.persistence >= 55 &&
      downAcc >= 0 &&
      bidDefense >= 60 &&
      imbalance <= -18
    ) {
      return PRE_MOVE_STATES.STRONG_DOWNSIDE_PRESSURE;
    }

    const upBuilding =
      upElev &&
      (upTrend === "RISING" || upTrend === "RISING_FAST") &&
      askDefense >= 45 &&
      (upAttack >= 45 || upBook >= 55);
    const downBuilding =
      downElev &&
      (downTrend === "RISING" || downTrend === "RISING_FAST") &&
      bidDefense >= 45 &&
      (downAttack >= 45 || downBook >= 55);

    if (upBuilding && !downBuilding && imbalance > 8) {
      return PRE_MOVE_STATES.UPSIDE_PRESSURE_BUILDING;
    }
    if (downBuilding && !upBuilding && imbalance < -8) {
      return PRE_MOVE_STATES.DOWNSIDE_PRESSURE_BUILDING;
    }

    if (askDefense >= 70 && up >= 40 && imbalance >= 0 && !downElev) {
      return PRE_MOVE_STATES.UPPER_DEFENSE_WEAKENING;
    }
    if (bidDefense >= 70 && down >= 40 && imbalance <= 0 && !upElev) {
      return PRE_MOVE_STATES.LOWER_DEFENSE_WEAKENING;
    }

    if (upElev && downElev && Math.abs(imbalance) < 12) {
      const defensesHold = askDefense < 55 && bidDefense < 55;
      if (defensesHold) return PRE_MOVE_STATES.COMPRESSION;
      return PRE_MOVE_STATES.TWO_SIDED_PRESSURE;
    }

    if (up < 40 && down < 40 && Math.abs(imbalance) < 10) {
      return PRE_MOVE_STATES.NO_PRESSURE;
    }

    if (Math.abs(imbalance) < 10) return PRE_MOVE_STATES.BALANCED;

    if (imbalance > 0 && upElev) return PRE_MOVE_STATES.UPSIDE_PRESSURE_BUILDING;
    if (imbalance < 0 && downElev) return PRE_MOVE_STATES.DOWNSIDE_PRESSURE_BUILDING;

    return PRE_MOVE_STATES.BALANCED;
  }
}

/**
 * Build factual WHY bullets from feature contributions and deltas.
 */
export function buildWhy(state, ctx) {
  const why = [];
  const {
    up,
    down,
    upPrev,
    downPrev,
    features,
    prevFeatures,
    contribUp,
    contribDown,
    upPers,
    downPers,
    askDefense,
    bidDefense,
    upAttack,
    downAttack,
    upBook,
    downBook,
    percentiles,
    confidence,
  } = ctx;

  const pct = (key) =>
    percentiles?.[key] == null ? null : Math.round(percentiles[key] * 100);

  const delta = (key) => {
    const a = features?.[key];
    const b = prevFeatures?.[key];
    if (a == null || b == null) return null;
    return Math.round(a) - Math.round(b);
  };

  const lineChange = (label, key) => {
    const d = delta(key);
    const now = features?.[key];
    if (now == null) return;
    if (d != null && Math.abs(d) >= 6) {
      why.push(`${label} ${Math.round(now - d)} → ${Math.round(now)}`);
    }
  };

  const linePct = (label, key) => {
    const p = pct(key);
    if (p == null) return;
    why.push(`${label} is at the ${p}th percentile`);
  };

  if (confidence < 40) {
    why.push(`Confidence ${Math.round(confidence)}/100 — data quality is degraded`);
  }

  if (state.includes("UPSIDE") || state.includes("UPPER") || state === "TRANSIENT_SPIKE") {
    lineChange("Buy aggression", "BuyAggressionPower");
    linePct("Ask withdrawal", "AskWithdrawal");
    lineChange("Ask survival", "AskSurvival");
    lineChange("Ask replenishment", "AskReplenishment");
    if (features?.AskDepthThinness >= 60) {
      const p = pct("AskDepth");
      why.push(
        p != null
          ? `Near-touch / ask depth is thin (depth ${p}th percentile)`
          : `Ask depth thinness ${Math.round(features.AskDepthThinness)}/100`
      );
    }
    if (upPers?.elevated) {
      why.push(
        `UpPressure persisted above ${upPers.threshold ?? 70} for ${upPers.durationSeconds}s`
      );
    }
    why.push(`UpPressure ${up}/100 vs DownPressure ${down}/100`);
    if (upAttack != null) why.push(`Upside attack ${upAttack}/100 · book prep ${upBook}/100`);
    if (askDefense != null) why.push(`Ask defense weakening ${askDefense}/100`);
  }

  if (state.includes("DOWNSIDE") || state.includes("LOWER")) {
    lineChange("Sell aggression", "SellAggressionPower");
    linePct("Bid withdrawal", "BidWithdrawal");
    lineChange("Bid survival", "BidSurvival");
    lineChange("Bid replenishment", "BidReplenishment");
    if (downPers?.elevated) {
      why.push(
        `DownPressure persisted above ${downPers.threshold ?? 70} for ${downPers.durationSeconds}s`
      );
    }
    why.push(`DownPressure ${down}/100 vs UpPressure ${up}/100`);
    if (downAttack != null) why.push(`Downside attack ${downAttack}/100 · book prep ${downBook}/100`);
    if (bidDefense != null) why.push(`Bid defense weakening ${bidDefense}/100`);
  }

  if (state === "COMPRESSION" || state === "TWO_SIDED_PRESSURE" || state === "BALANCED") {
    why.push(`UpPressure ${up}/100 · DownPressure ${down}/100 · imbalance ${signed(up - down)}`);
    why.push(
      `Ask defense weakening ${askDefense}/100 · Bid defense weakening ${bidDefense}/100`
    );
  }

  if (state === "NO_PRESSURE") {
    why.push("Neither side shows elevated attack, book preparation, or defense weakening.");
  }

  if (state === "LOW_CONFIDENCE") {
    why.push("Trade feed, book health, or sample size is insufficient for a pressure call.");
  }

  // Ranked contribution debug lines
  const top = Object.entries(contribUp || {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4)
    .map(([k, v]) => `${k} ${signed(v, 1)}`);
  if (top.length && state.includes("UPSIDE")) {
    why.push(`Up contributions: ${top.join(", ")}`);
  }
  const topD = Object.entries(contribDown || {})
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 4)
    .map(([k, v]) => `${k} ${signed(v, 1)}`);
  if (topD.length && state.includes("DOWNSIDE")) {
    why.push(`Down contributions: ${topD.join(", ")}`);
  }

  if (upPrev != null && Math.abs(up - upPrev) >= 6) {
    why.push(`UpPressure ${upPrev} → ${up}`);
  }
  if (downPrev != null && Math.abs(down - downPrev) >= 6) {
    why.push(`DownPressure ${downPrev} → ${down}`);
  }

  return why.slice(0, 8);
}
