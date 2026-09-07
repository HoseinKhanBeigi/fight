/**
 * Market-state classification with signal persistence.
 * Distinguishes TRUE SWEEP vs PULL+BREAK vs ABSORPTION.
 */

export const STATES = {
  BUYERS_WINNING: "BUYERS WINNING",
  SELLERS_WINNING: "SELLERS WINNING",
  ASK_ABSORPTION: "ASK ABSORPTION",
  BID_ABSORPTION: "BID ABSORPTION",
  TRUE_ASK_SWEEP: "TRUE ASK SWEEP",
  TRUE_BID_SWEEP: "TRUE BID SWEEP",
  ASK_WALL_PULLED: "ASK WALL PULLED",
  BID_WALL_PULLED: "BID WALL PULLED",
  ASK_STACKING: "ASK STACKING",
  BID_STACKING: "BID STACKING",
  ASK_CANCEL_SURGE: "ASK CANCELLATION SURGE",
  BID_CANCEL_SURGE: "BID CANCELLATION SURGE",
  ASK_PULLED_PATH: "ASK PULLED — UPSIDE PATH OPEN",
  BID_PULLED_PATH: "BID PULLED — DOWNSIDE PATH OPEN",
  BALANCED: "BALANCED",
  NEUTRAL: "NEUTRAL",
};

export class MarketClassifier {
  constructor(config) {
    this.config = config;
    this.currentState = STATES.NEUTRAL;
    this.pendingState = null;
    this.pendingSince = 0;
    this.buyBattle = this._emptyBattle("buy");
    this.sellBattle = this._emptyBattle("sell");
  }

  _emptyBattle(kind) {
    return {
      kind,
      aggressiveVolume: 0,
      passiveLiquidity: 0,
      executed: 0,
      cancelled: 0,
      refill: 0,
      executionRatio: 0,
      cancellationRatio: 0,
      refillRatio: 0,
      attackScore: 0,
      result: STATES.NEUTRAL,
    };
  }

  /**
   * @param {object} ctx
   */
  update(ctx) {
    const {
      now,
      flowWindows,
      liqWindows,
      book,
      walls,
      tickSize,
      priceChangeTicks5s,
    } = ctx;

    const w = 60;
    const flow = flowWindows[w] || flowWindows[300] || Object.values(flowWindows)[0];
    const liq = liqWindows[w] || liqWindows[300] || Object.values(liqWindows)[0];
    if (!flow || !liq) return this.currentState;

    const eps = this.config.epsilon;
    const askLiq = book.totalNearLiquidity("ask", 10);
    const bidLiq = book.totalNearLiquidity("bid", 10);

    // Buy side battle: aggressive buyers vs passive sellers (asks)
    const buyRemoved = Math.max(liq.askRemoved, eps);
    this.buyBattle = {
      kind: "buy",
      aggressiveVolume: flow.aggressiveBuyVolume,
      passiveLiquidity: askLiq,
      executed: liq.askExec,
      cancelled: liq.askCancel,
      refill: liq.askRefill,
      executionRatio: liq.askExec / buyRemoved,
      cancellationRatio: liq.askCancel / buyRemoved,
      refillRatio: liq.askRefill / Math.max(liq.askExec, eps),
      attackScore: flow.aggressiveBuyVolume / Math.max(askLiq, eps),
      result: STATES.NEUTRAL,
    };

    // Sell side battle: aggressive sellers vs passive buyers (bids)
    const sellRemoved = Math.max(liq.bidRemoved, eps);
    this.sellBattle = {
      kind: "sell",
      aggressiveVolume: flow.aggressiveSellVolume,
      passiveLiquidity: bidLiq,
      executed: liq.bidExec,
      cancelled: liq.bidCancel,
      refill: liq.bidRefill,
      executionRatio: liq.bidExec / sellRemoved,
      cancellationRatio: liq.bidCancel / sellRemoved,
      refillRatio: liq.bidRefill / Math.max(liq.bidExec, eps),
      attackScore: flow.aggressiveSellVolume / Math.max(bidLiq, eps),
      result: STATES.NEUTRAL,
    };

    this.buyBattle.result = this._classifySideBattle(this.buyBattle, "ask", {
      priceChangeTicks5s,
      wall: walls.largestAskWall,
      cancelImbalance: liq.cancelImbalance,
    });
    this.sellBattle.result = this._classifySideBattle(this.sellBattle, "bid", {
      priceChangeTicks5s,
      wall: walls.largestBidWall,
      cancelImbalance: liq.cancelImbalance,
    });

    const candidate = this._pickGlobalState({
      buy: this.buyBattle,
      sell: this.sellBattle,
      liq,
      flow,
      walls,
      priceChangeTicks5s,
    });

    this._persist(candidate, now);
    return this.currentState;
  }

  _classifySideBattle(battle, passiveSide, { priceChangeTicks5s, wall }) {
    const cfg = this.config;
    const up = priceChangeTicks5s >= cfg.priceResponseTicks;
    const down = priceChangeTicks5s <= -cfg.priceResponseTicks;
    const flat = Math.abs(priceChangeTicks5s) < cfg.priceResponseTicks;

    if (wall && wall.status === "WALL_PULLED") {
      return passiveSide === "ask" ? STATES.ASK_WALL_PULLED : STATES.BID_WALL_PULLED;
    }

    // Absorption: strong aggression + high refill + liquidity remains + weak price response
    if (
      battle.attackScore >= 0.5 &&
      battle.refillRatio >= cfg.minimumRefillRatio &&
      battle.passiveLiquidity > 0 &&
      battle.executed > cfg.minimumCancelVolume &&
      flat
    ) {
      return passiveSide === "ask" ? STATES.ASK_ABSORPTION : STATES.BID_ABSORPTION;
    }

    // True sweep
    if (
      battle.executionRatio >= cfg.sweepExecutionRatio &&
      battle.cancellationRatio < 1 - cfg.sweepExecutionRatio &&
      battle.refillRatio < cfg.minimumRefillRatio &&
      ((passiveSide === "ask" && up) || (passiveSide === "bid" && down))
    ) {
      return passiveSide === "ask" ? STATES.TRUE_ASK_SWEEP : STATES.TRUE_BID_SWEEP;
    }

    // Pull + break
    if (
      battle.cancellationRatio >= cfg.pullCancelRatio &&
      ((passiveSide === "ask" && up) || (passiveSide === "bid" && down))
    ) {
      return passiveSide === "ask" ? STATES.ASK_PULLED_PATH : STATES.BID_PULLED_PATH;
    }

    if (battle.cancellationRatio >= cfg.cancelSurgeRatio && battle.cancelled > cfg.minimumCancelVolume) {
      return passiveSide === "ask" ? STATES.ASK_CANCEL_SURGE : STATES.BID_CANCEL_SURGE;
    }

    return STATES.NEUTRAL;
  }

  _pickGlobalState({ buy, sell, liq, flow, walls, priceChangeTicks5s }) {
    const priority = [
      buy.result,
      sell.result,
    ];

    for (const s of [
      STATES.TRUE_ASK_SWEEP,
      STATES.TRUE_BID_SWEEP,
      STATES.ASK_PULLED_PATH,
      STATES.BID_PULLED_PATH,
      STATES.ASK_WALL_PULLED,
      STATES.BID_WALL_PULLED,
      STATES.ASK_ABSORPTION,
      STATES.BID_ABSORPTION,
      STATES.ASK_CANCEL_SURGE,
      STATES.BID_CANCEL_SURGE,
    ]) {
      if (priority.includes(s)) return s;
    }

    if (walls.largestAskWall?.status === "WALL_PULLED") return STATES.ASK_WALL_PULLED;
    if (walls.largestBidWall?.status === "WALL_PULLED") return STATES.BID_WALL_PULLED;

    // Stacking dominance
    if (liq.askStack > liq.bidStack * 1.5 && liq.askStack > this.config.minimumStackVolume) {
      return STATES.ASK_STACKING;
    }
    if (liq.bidStack > liq.askStack * 1.5 && liq.bidStack > this.config.minimumStackVolume) {
      return STATES.BID_STACKING;
    }

    const delta = flow.netDelta;
    const total = flow.totalVolume;
    if (total > 0) {
      if (delta / total > 0.25 && priceChangeTicks5s > 0) return STATES.BUYERS_WINNING;
      if (delta / total < -0.25 && priceChangeTicks5s < 0) return STATES.SELLERS_WINNING;
      if (Math.abs(delta) / total < 0.1) return STATES.BALANCED;
    }

    return STATES.NEUTRAL;
  }

  _persist(candidate, now) {
    const persistS = this.config.signalPersistenceMs / 1000;
    if (candidate === this.currentState) {
      this.pendingState = null;
      return;
    }
    if (this.pendingState !== candidate) {
      this.pendingState = candidate;
      this.pendingSince = now;
      return;
    }
    if (now - this.pendingSince >= persistS) {
      this.currentState = candidate;
      this.pendingState = null;
    }
  }
}
