/**
 * How long directional pressure stays elevated — duration, continuity,
 * drops, average, and peak. Blocks one-tick spikes from looking persistent.
 */

import { clamp, score100 } from "./math.js";

export class PressurePersistenceEngine {
  constructor(opts = {}) {
    this.threshold = opts.elevatedThreshold ?? 70;
    this.buildingSec = opts.buildingSec ?? 8;
    this.persistentSec = opts.persistentSec ?? 20;
    this.veryPersistentSec = opts.veryPersistentSec ?? 45;
  }

  /**
   * @param {Array<{t:number, up:number, down:number}>} history
   * @param {number} now
   * @param {number} current  current pressure (not yet in history)
   * @param {'up'|'down'} side
   */
  measure(history, now, current, side) {
    const field = side === "down" ? "down" : "up";
    const rows = history?.length
      ? [...history, { t: now, [field]: current }]
      : [{ t: now, [field]: current }];

    const thresh = this.threshold;
    let duration = 0;
    let drops = 0;
    let elevatedSum = 0;
    let elevatedN = 0;
    let peak = current;
    let belowStreak = false;
    let contiguous = true;
    let lastT = now;

    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const v = Number(row[field]) || 0;
      if (v > peak) peak = v;
      const dt = Math.max(0, lastT - row.t);
      lastT = row.t;

      if (v >= thresh) {
        duration += dt;
        elevatedSum += v;
        elevatedN += 1;
        belowStreak = false;
      } else {
        if (elevatedN > 0) {
          drops += 1;
          belowStreak = true;
        }
        if (contiguous && elevatedN > 0) contiguous = false;
        if (now - row.t > this.veryPersistentSec * 2) break;
      }
    }

    const avg = elevatedN ? elevatedSum / elevatedN : current;
    const continuity = drops === 0 ? 1 : 1 / (1 + drops);
    const durationScore = score100(duration / this.veryPersistentSec);
    const avgScore = score100((avg - thresh + 10) / 40);
    const peakScore = score100((peak - thresh) / 30);
    const persistence = clamp(
      Math.round(
        0.4 * durationScore +
          0.25 * continuity * 100 +
          0.2 * avgScore +
          0.15 * peakScore
      ),
      0,
      100
    );

    let label = "TRANSIENT";
    if (duration >= this.veryPersistentSec && persistence >= 75) label = "VERY_PERSISTENT";
    else if (duration >= this.persistentSec && persistence >= 55) label = "PERSISTENT";
    else if (duration >= this.buildingSec || (current >= thresh && persistence >= 35))
      label = "BUILDING";
    else if (current < thresh) label = "TRANSIENT";

    return {
      persistence,
      durationSeconds: Math.round(duration * 10) / 10,
      drops,
      average: Math.round(avg),
      peak: Math.round(peak),
      label,
      elevated: current >= thresh,
    };
  }
}
