/**
 * Pressure velocity / acceleration / trend from the pressure history ring.
 * Lookbacks use timestamps ≤ T only.
 */

import { round1 } from "./math.js";

function valueAtLookback(history, now, lookbackSec, field) {
  if (!history?.length) return null;
  const target = now - lookbackSec;
  let past = history[0][field];
  let found = false;
  for (const row of history) {
    if (row.t >= target) {
      past = row[field];
      found = true;
      break;
    }
    past = row[field];
    found = true;
  }
  return found && Number.isFinite(past) ? past : null;
}

function trendLabel(velocity, lookbackSec) {
  const per10 = lookbackSec > 0 ? (velocity * 10) / lookbackSec : velocity;
  if (per10 >= 12) return "RISING_FAST";
  if (per10 >= 4) return "RISING";
  if (per10 <= -12) return "FALLING_FAST";
  if (per10 <= -4) return "FALLING";
  return "STABLE";
}

export class PressureAccelerationEngine {
  constructor(velocityWindows = [5, 10, 30, 60, 300]) {
    this.velocityWindows = velocityWindows;
  }

  /**
   * @param {Array<{t:number, up:number, down:number}>} history prior points only
   * @param {number} now
   * @param {number} up
   * @param {number} down
   */
  measure(history, now, up, down) {
    const byWindow = {};
    for (const w of this.velocityWindows) {
      const upThen = valueAtLookback(history, now, w, "up");
      const downThen = valueAtLookback(history, now, w, "down");
      const upVel = upThen == null ? 0 : up - upThen;
      const downVel = downThen == null ? 0 : down - downThen;
      byWindow[w] = {
        upVelocity: round1(upVel),
        downVelocity: round1(downVel),
        upTrend: trendLabel(upVel, w),
        downTrend: trendLabel(downVel, w),
      };
    }

    const v10 = byWindow[10] || byWindow[5] || { upVelocity: 0, downVelocity: 0 };
    const prevUpVel = this._previousVelocity(history, now, 10, "up");
    const prevDownVel = this._previousVelocity(history, now, 10, "down");

    const upAcc = round1(v10.upVelocity - prevUpVel);
    const downAcc = round1(v10.downVelocity - prevDownVel);

    return {
      byWindow,
      upVelocity: v10.upVelocity,
      downVelocity: v10.downVelocity,
      upAcceleration: upAcc,
      downAcceleration: downAcc,
      upTrend: v10.upTrend || trendLabel(v10.upVelocity, 10),
      downTrend: v10.downTrend || trendLabel(v10.downVelocity, 10),
      lookbackSec: 10,
    };
  }

  _previousVelocity(history, now, lookbackSec, field) {
    if (!history?.length) return 0;
    const prevNow = now - lookbackSec;
    const currentThen = valueAtLookback(history, prevNow, 0, field);
    const older = valueAtLookback(history, prevNow, lookbackSec, field);
    if (currentThen == null || older == null) return 0;
    return currentThen - older;
  }
}

export function pressureAt(history, now, lookbackSec, field) {
  return valueAtLookback(history, now, lookbackSec, field);
}

export { trendLabel };
