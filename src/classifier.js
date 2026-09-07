/**
 * Market-state classification with signal persistence.
 * Distinguishes TRUE SWEEP vs PULL+BREAK vs ABSORPTION.
 */

export const STATES = {
  BUYERS_WINNING: "BUYERS WINNING",
  SELLERS_WINNING: "SELLERS WINNING",
  ASK_ABSORPTION: "ASK ABSORPTION",
  BID_ABSORPTION: "BID ABSORPTION",
  BUY_ABSORBED: "BUYERS ABSORBED",
  SELL_ABSORBED: "SELLERS ABSORBED",
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

/**
 * Absorption: aggression hits resting liquidity, size is executed, book refills,
 * and price does not follow — passive side is absorbing the aggressor.
 */
export function isAbsorption({
  attackScore,
  refillRatio,
  passiveLiquidity,
  executed,
  priceChangeTicks,
  config,
}) {
  const cfg = config;
  const flat = Math.abs(priceChangeTicks) < cfg.priceResponseTicks;
  return (
    attackScore >= 0.5 &&
    refillRatio >= cfg.minimumRefillRatio &&
    passiveLiquidity > 0 &&
    executed > cfg.minimumCancelVolume &&
    flat
  );
}

/** Four-side absorption flags for one fight window. */
export function absorptionFlags({
  aggressiveBuyVolume,
  aggressiveSellVolume,
  askLiquidity,
  bidLiquidity,
  askExec,
  bidExec,
  askRefill,
  bidRefill,
  priceChangeTicks,
  config,
}) {
  const eps = config.epsilon || 1e-9;
  const askAbsorb = isAbsorption({
    attackScore: aggressiveBuyVolume / Math.max(askLiquidity, eps),
    refillRatio: askRefill / Math.max(askExec, eps),
    passiveLiquidity: askLiquidity,
    executed: askExec,
    priceChangeTicks,
    config,
  });
  const bidAbsorb = isAbsorption({
    attackScore: aggressiveSellVolume / Math.max(bidLiquidity, eps),
    refillRatio: bidRefill / Math.max(bidExec, eps),
    passiveLiquidity: bidLiquidity,
    executed: bidExec,
    priceChangeTicks,
    config,
  });
  return {
    ask: askAbsorb,
    bid: bidAbsorb,
    aggressiveBuy: askAbsorb,
    aggressiveSell: bidAbsorb,
  };
}

export class MarketClassifier {
  constructor(config) {
    this.config = config;
    this.currentState = STATES.NEUTRAL;
    this.pendingState = null;
    this.pendingSince = 0;
    this.buyBattle = this._emptyBattle("buy");
    this.sellBattle = this._emptyBattle("sell");
    this.absorption = {
      ask: false,
      bid: false,
      aggressiveBuy: false,
      aggressiveSell: false,
    };
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
      absorbing: false,
      result: STATES.NEUTRAL,
      passiveLabel: null,
      aggressorLabel: null,
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
      priceChangeTicks5s,
      windowSec = 60,
    } = ctx;

    const w = windowSec;
    const flow =
      flowWindows[w] ||
      flowWindows[60] ||
      flowWindows[300] ||
      Object.values(flowWindows)[0];
    const liq =
      liqWindows[w] ||
      liqWindows[60] ||
      liqWindows[300] ||
      Object.values(liqWindows)[0];
    if (!flow || !liq) return this.currentState;

    const eps = this.config.epsilon;
    const askLiq = book.totalNearLiquidity("ask", 10);
    const bidLiq = book.totalNearLiquidity("bid", 10);
    const priceTicks = priceChangeTicks5s;

    const buyRemoved = Math.max(liq.askRemoved, eps);
    const buyRefillRatio = liq.askRefill / Math.max(liq.askExec, eps);
    this.buyBattle = {
      kind: "buy",
      aggressiveVolume: flow.aggressiveBuyVolume,
      passiveLiquidity: askLiq,
      executed: liq.askExec,
      cancelled: liq.askCancel,
      refill: liq.askRefill,
      executionRatio: liq.askExec / buyRemoved,
      cancellationRatio: liq.askCancel / buyRemoved,
      refillRatio: buyRefillRatio,
      attackScore: flow.aggressiveBuyVolume / Math.max(askLiq, eps),
      absorbing: false,
      result: STATES.NEUTRAL,
      passiveLabel: null,
      aggressorLabel: null,
    };

    const sellRemoved = Math.max(liq.bidRemoved, eps);
    const sellRefillRatio = liq.bidRefill / Math.max(liq.bidExec, eps);
    this.sellBattle = {
      kind: "sell",
      aggressiveVolume: flow.aggressiveSellVolume,
      passiveLiquidity: bidLiq,
      executed: liq.bidExec,
      cancelled: liq.bidCancel,
      refill: liq.bidRefill,
      executionRatio: liq.bidExec / sellRemoved,
      cancellationRatio: liq.bidCancel / sellRemoved,
      refillRatio: sellRefillRatio,
      attackScore: flow.aggressiveSellVolume / Math.max(bidLiq, eps),
      absorbing: false,
      result: STATES.NEUTRAL,
      passiveLabel: null,
      aggressorLabel: null,
    };

    this.absorption = absorptionFlags({
      aggressiveBuyVolume: flow.aggressiveBuyVolume,
      aggressiveSellVolume: flow.aggressiveSellVolume,
      askLiquidity: askLiq,
      bidLiquidity: bidLiq,
      askExec: liq.askExec,
      bidExec: liq.bidExec,
      askRefill: liq.askRefill,
      bidRefill: liq.bidRefill,
      priceChangeTicks: priceTicks,
      config: this.config,
    });

    this.buyBattle.absorbing = this.absorption.ask;
    this.sellBattle.absorbing = this.absorption.bid;
    if (this.absorption.ask) {
      this.buyBattle.passiveLabel = STATES.ASK_ABSORPTION;
      this.buyBattle.aggressorLabel = STATES.BUY_ABSORBED;
    }
    if (this.absorption.bid) {
      this.sellBattle.passiveLabel = STATES.BID_ABSORPTION;
      this.sellBattle.aggressorLabel = STATES.SELL_ABSORBED;
    }

    this.buyBattle.result = this._classifySideBattle(this.buyBattle, "ask", {
      priceChangeTicks5s: priceTicks,
      wall: walls.largestAskWall,
    });
    this.sellBattle.result = this._classifySideBattle(this.sellBattle, "bid", {
      priceChangeTicks5s: priceTicks,
      wall: walls.largestBidWall,
    });

    const candidate = this._pickGlobalState({
      buy: this.buyBattle,
      sell: this.sellBattle,
      liq,
      flow,
      walls,
      priceChangeTicks5s: priceTicks,
    });

    this._persist(candidate, now);
    return this.currentState;
  }

  _classifySideBattle(battle, passiveSide, { priceChangeTicks5s, wall }) {
    const cfg = this.config;
    const up = priceChangeTicks5s >= cfg.priceResponseTicks;
    const down = priceChangeTicks5s <= -cfg.priceResponseTicks;

    if (wall && wall.status === "WALL_PULLED") {
      return passiveSide === "ask" ? STATES.ASK_WALL_PULLED : STATES.BID_WALL_PULLED;
    }

    if (
      isAbsorption({
        attackScore: battle.attackScore,
        refillRatio: battle.refillRatio,
        passiveLiquidity: battle.passiveLiquidity,
        executed: battle.executed,
        priceChangeTicks: priceChangeTicks5s,
        config: cfg,
      })
    ) {
      return passiveSide === "ask" ? STATES.ASK_ABSORPTION : STATES.BID_ABSORPTION;
    }

    if (
      battle.executionRatio >= cfg.sweepExecutionRatio &&
      battle.cancellationRatio < 1 - cfg.sweepExecutionRatio &&
      battle.refillRatio < cfg.minimumRefillRatio &&
      ((passiveSide === "ask" && up) || (passiveSide === "bid" && down))
    ) {
      return passiveSide === "ask" ? STATES.TRUE_ASK_SWEEP : STATES.TRUE_BID_SWEEP;
    }

    if (
      battle.cancellationRatio >= cfg.pullCancelRatio &&
      ((passiveSide === "ask" && up) || (passiveSide === "bid" && down))
    ) {
      return passiveSide === "ask" ? STATES.ASK_PULLED_PATH : STATES.BID_PULLED_PATH;
    }

    if (
      battle.cancellationRatio >= cfg.cancelSurgeRatio &&
      battle.cancelled > cfg.minimumCancelVolume
    ) {
      return passiveSide === "ask" ? STATES.ASK_CANCEL_SURGE : STATES.BID_CANCEL_SURGE;
    }

    return STATES.NEUTRAL;
  }

  _pickGlobalState({ buy, sell, liq, flow, walls, priceChangeTicks5s }) {
    const priority = [buy.result, sell.result];

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
