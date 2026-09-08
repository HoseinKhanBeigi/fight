/**
 * Confirmation layer. Evaluates price response AFTER a pre-move snapshot.
 * Must never feed back into the pre-move score.
 */

import { safeDiv } from "./math.js";

export const CONFIRM_STATES = {
  PENDING: "PENDING",
  UPSIDE_MOVE_CONFIRMED: "UPSIDE_MOVE_CONFIRMED",
  DOWNSIDE_MOVE_CONFIRMED: "DOWNSIDE_MOVE_CONFIRMED",
  UPSIDE_PRESSURE_FAILED: "UPSIDE_PRESSURE_FAILED",
  DOWNSIDE_PRESSURE_FAILED: "DOWNSIDE_PRESSURE_FAILED",
  SELLER_ABSORPTION: "SELLER_ABSORPTION",
  BUYER_ABSORPTION: "BUYER_ABSORPTION",
  NO_SIGNAL: "NO_SIGNAL",
};

function bps(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0) return 0;
  return ((to - from) / from) * 10_000;
}

export class PriceResponseEngine {
  constructor({ minHorizonSec = 5, confirmHorizonSec = 30 } = {}) {
    this.minHorizonSec = minHorizonSec;
    this.confirmHorizonSec = confirmHorizonSec;
    this.open = null;
    this.last = {
      state: CONFIRM_STATES.NO_SIGNAL,
      signalState: null,
      signalTs: null,
      displacementBps: 0,
      efficiency: null,
      horizonSec: 0,
      why: "No pre-move signal to confirm yet.",
    };
  }

  clear() {
    this.open = null;
    this.last = {
      state: CONFIRM_STATES.NO_SIGNAL,
      signalState: null,
      signalTs: null,
      displacementBps: 0,
      efficiency: null,
      horizonSec: 0,
      why: "Cleared.",
    };
  }

  /**
   * Arm a new evaluation when pre-move emits a directional state.
   * Snapshot is the pre-move output at T (no future data).
   */
  observePreMove(snapshot) {
    const state = snapshot?.state;
    if (!state || state === "NO_PRESSURE" || state === "LOW_CONFIDENCE" || state === "BALANCED") {
      return;
    }
    if (
      this.open &&
      snapshot.t - this.open.t < 2 &&
      this.open.state === state
    ) {
      return;
    }
    this.open = {
      t: snapshot.t,
      price: snapshot.price,
      state,
      up: snapshot.up,
      down: snapshot.down,
      imbalance: snapshot.imbalance,
      askSurvival: snapshot.askSurvival,
      bidSurvival: snapshot.bidSurvival,
      askReplenish: snapshot.askReplenish,
      bidReplenish: snapshot.bidReplenish,
      askDefense: snapshot.askDefense,
      bidDefense: snapshot.bidDefense,
    };
    this.last = {
      ...this.last,
      state: CONFIRM_STATES.PENDING,
      signalState: state,
      signalTs: snapshot.t,
      why: `Waiting for price response after ${state.replace(/_/g, " ")}.`,
    };
  }

  /**
   * Evaluate using data available at `now` relative to a past signal.
   */
  evaluate({ now, priceNow, askSurvival, bidSurvival, askReplenish, bidReplenish }) {
    if (!this.open || !Number.isFinite(this.open.price) || !Number.isFinite(priceNow)) {
      return this.last;
    }
    const elapsed = now - this.open.t;
    if (elapsed < this.minHorizonSec) {
      this.last = {
        ...this.last,
        state: CONFIRM_STATES.PENDING,
        displacementBps: bps(this.open.price, priceNow),
        horizonSec: Math.round(elapsed * 10) / 10,
        why: `Pending (${elapsed.toFixed(1)}s since ${this.open.state.replace(/_/g, " ")}).`,
      };
      return this.last;
    }

    const move = bps(this.open.price, priceNow);
    const upBias =
      this.open.state.includes("UPSIDE") ||
      this.open.state.includes("UPPER") ||
      this.open.state.includes("UP_PRESSURE");
    const downBias =
      this.open.state.includes("DOWNSIDE") ||
      this.open.state.includes("LOWER") ||
      this.open.state.includes("DOWN_PRESSURE");
    const directional = upBias ? move : downBias ? -move : 0;
    const effort = Math.max(this.open.up, this.open.down, 1);
    const efficiency = Math.max(
      0,
      Math.min(100, Math.round(safeDiv(Math.max(0, directional) * 10, Math.max(8, effort * 0.08))))
    );

    const askHeld =
      (askSurvival ?? 50) >= (this.open.askSurvival ?? 50) - 5 &&
      (askReplenish ?? 50) >= (this.open.askReplenish ?? 50) + 8;
    const bidHeld =
      (bidSurvival ?? 50) >= (this.open.bidSurvival ?? 50) - 5 &&
      (bidReplenish ?? 50) >= (this.open.bidReplenish ?? 50) + 8;

    let state = CONFIRM_STATES.PENDING;
    let why = "";

    if (upBias) {
      if (move >= 6 && (askSurvival ?? 50) <= (this.open.askSurvival ?? 50) - 8) {
        state = CONFIRM_STATES.UPSIDE_MOVE_CONFIRMED;
        why = `Price displaced ${move.toFixed(1)} bps up and ask defense did not hold.`;
      } else if (Math.abs(move) < 3 && askHeld) {
        state = CONFIRM_STATES.SELLER_ABSORPTION;
        why = `Upside displacement is weak (${move.toFixed(1)} bps) while asks replenish/survive.`;
      } else if (elapsed >= this.confirmHorizonSec && move < 3) {
        state = CONFIRM_STATES.UPSIDE_PRESSURE_FAILED;
        why = `After ${elapsed.toFixed(0)}s price has not expanded up (${move.toFixed(1)} bps).`;
      }
    } else if (downBias) {
      if (move <= -6 && (bidSurvival ?? 50) <= (this.open.bidSurvival ?? 50) - 8) {
        state = CONFIRM_STATES.DOWNSIDE_MOVE_CONFIRMED;
        why = `Price displaced ${move.toFixed(1)} bps down and bid defense did not hold.`;
      } else if (Math.abs(move) < 3 && bidHeld) {
        state = CONFIRM_STATES.BUYER_ABSORPTION;
        why = `Downside displacement is weak (${move.toFixed(1)} bps) while bids replenish/survive.`;
      } else if (elapsed >= this.confirmHorizonSec && move > -3) {
        state = CONFIRM_STATES.DOWNSIDE_PRESSURE_FAILED;
        why = `After ${elapsed.toFixed(0)}s price has not expanded down (${move.toFixed(1)} bps).`;
      }
    }

    if (state === CONFIRM_STATES.PENDING && elapsed >= this.confirmHorizonSec) {
      if (upBias && move >= 6) {
        state = CONFIRM_STATES.UPSIDE_MOVE_CONFIRMED;
        why = `Price displaced ${move.toFixed(1)} bps up after ${this.open.state.replace(/_/g, " ")}.`;
      } else if (downBias && move <= -6) {
        state = CONFIRM_STATES.DOWNSIDE_MOVE_CONFIRMED;
        why = `Price displaced ${move.toFixed(1)} bps down after ${this.open.state.replace(/_/g, " ")}.`;
      }
    }

    this.last = {
      state,
      signalState: this.open.state,
      signalTs: this.open.t,
      displacementBps: Math.round(move * 10) / 10,
      efficiency: Number.isFinite(efficiency) ? Math.max(0, Math.min(100, efficiency)) : null,
      horizonSec: Math.round(elapsed * 10) / 10,
      why: why || `Still evaluating (${elapsed.toFixed(1)}s, ${move.toFixed(1)} bps).`,
    };

    if (state !== CONFIRM_STATES.PENDING && elapsed >= this.confirmHorizonSec) {
      this.open = null;
    }

    return this.last;
  }
}
