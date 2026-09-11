/**
 * Smart aggression + defense alerts for the focused OrderFlowMonitor symbol.
 *
 * Layer 1 (RAW) stays in aggression-watch.js — this module adds:
 *   Layer 2 — battle / opposing passive defense
 *   Layer 3 — price response / outcome
 *
 * Emits fewer, richer alerts with cooldown, persistence, and hysteresis.
 */

import { SmartAlertBacktest } from "./smart-alert-backtest.js";

export const ALERT_TYPES = {
  RAW_BUY_AGGRESSION: "RAW_BUY_AGGRESSION",
  RAW_SELL_AGGRESSION: "RAW_SELL_AGGRESSION",
  BUYERS_BREAKING_ASKS: "BUYERS_BREAKING_ASKS",
  SELLERS_BREAKING_BIDS: "SELLERS_BREAKING_BIDS",
  SELLER_ABSORPTION: "SELLER_ABSORPTION",
  BUYER_ABSORPTION: "BUYER_ABSORPTION",
  UPSIDE_LIQUIDITY_VACUUM: "UPSIDE_LIQUIDITY_VACUUM",
  DOWNSIDE_LIQUIDITY_VACUUM: "DOWNSIDE_LIQUIDITY_VACUUM",
  UP_CONTROL_SHIFT: "UP_CONTROL_SHIFT",
  DOWN_CONTROL_SHIFT: "DOWN_CONTROL_SHIFT",
  SELLER_DEFENSE_WEAKENING: "SELLER_DEFENSE_WEAKENING",
  BUYER_DEFENSE_WEAKENING: "BUYER_DEFENSE_WEAKENING",
  NO_RESULT_HIGH_EFFORT: "NO_RESULT_HIGH_EFFORT",
  HIGH_EFFORT_LOW_RESULT: "HIGH_EFFORT_LOW_RESULT",
};

const PRIORITY = {
  INFO: "INFO",
  IMPORTANT: "IMPORTANT",
  CRITICAL: "CRITICAL",
};

const DEFAULTS = {
  battleWindowSec: 60,
  histMax: 40, // ~10s at 250ms
  crossoverPersistMs: 2500,
  cooldownMs: {
    INFO: 8_000,
    IMPORTANT: 12_000,
    CRITICAL: 15_000,
  },
  reenterSpreadDelta: 12,
  attackHigh: 70,
  attackMod: 55,
  defenseWeak: 45,
  defenseStrong: 65,
  effHigh: 55,
  effLow: 35,
  spreadBreak: 10,
  weakenDefDrop: 12,
  weakenAtkRise: 4,
  highEffortUsd: 5_000_000,
  highEffortPower: 85,
};

function bandHigh(b) {
  return b === "HIGH" || b === "EXTREME" || b === "VERY_HIGH";
}
function bandLow(b) {
  return b === "LOW" || b === "VERY_LOW" || b === "UNKNOWN";
}
function bandExtreme(b) {
  return b === "EXTREME";
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pickBattle(snap, windowSec) {
  const pack =
    snap?.battlesByWindow?.[windowSec] ||
    snap?.battlesByWindow?.[String(windowSec)] ||
    snap?.battlesByWindow?.[60] ||
    null;
  return pack || null;
}

function sideCtx(card, isBuy) {
  if (!card) return null;
  const a = card.attack || {};
  const d = card.defense || {};
  const r = card.response || {};
  return {
    isBuy,
    attackPower: num(a.power),
    defensePower: num(d.power),
    battleSpread: num(card.battleSpread),
    aggressiveVolume: num(a.aggressiveVolume),
    attackPercentile: num(a.percentile),
    cancelBand: d.cancelBand || "UNKNOWN",
    refillBand: d.refillBand || "UNKNOWN",
    consumeBand: d.consumeBand || "UNKNOWN",
    survival: num(d.survival),
    withdrawal: num(d.withdrawal),
    cancelled: num(d.cancelled),
    replenished: num(d.replenished),
    consumed: num(d.consumed),
    netWithdrawal: num(d.netWithdrawal),
    efficiency: num(r.efficiency),
    priceMoveBps: num(r.priceMoveBps),
    absorptionScore: num(r.absorptionScore),
    state: String(card.state || ""),
    passiveState: String(card.passiveState || ""),
    attackDq: a.dataQuality || null,
    defenseDq: d.dataQuality || null,
  };
}

function titleFor(type) {
  return String(type || "").replace(/_/g, " ");
}

function messageFor(type, ctx) {
  const atk = ctx.attackPower != null ? Math.round(ctx.attackPower) : "—";
  const def = ctx.defensePower != null ? Math.round(ctx.defensePower) : "—";
  const sp = ctx.battleSpread;
  const spr = sp == null ? "—" : (sp > 0 ? "+" : "") + Math.round(sp);
  switch (type) {
    case ALERT_TYPES.BUYERS_BREAKING_ASKS:
      return `Attack ${atk} · Ask defense ${def} · Spread ${spr}`;
    case ALERT_TYPES.SELLERS_BREAKING_BIDS:
      return `Attack ${atk} · Bid defense ${def} · Spread ${spr}`;
    case ALERT_TYPES.SELLER_ABSORPTION:
      return `Buy attack ${atk} absorbed · Ask defense ${def} · Eff ${ctx.efficiency ?? "—"}`;
    case ALERT_TYPES.BUYER_ABSORPTION:
      return `Sell attack ${atk} absorbed · Bid defense ${def} · Eff ${ctx.efficiency ?? "—"}`;
    case ALERT_TYPES.UPSIDE_LIQUIDITY_VACUUM:
      return `Ask defense collapsing · resistance thinning`;
    case ALERT_TYPES.DOWNSIDE_LIQUIDITY_VACUUM:
      return `Bid defense collapsing · support thinning`;
    case ALERT_TYPES.UP_CONTROL_SHIFT:
      return `Buy attack crossed ask defense · Spread ${spr}`;
    case ALERT_TYPES.DOWN_CONTROL_SHIFT:
      return `Sell attack crossed bid defense · Spread ${spr}`;
    case ALERT_TYPES.SELLER_DEFENSE_WEAKENING:
      return `Ask defense falling while buy attack holds · Spread ${spr}`;
    case ALERT_TYPES.BUYER_DEFENSE_WEAKENING:
      return `Bid defense falling while sell attack holds · Spread ${spr}`;
    case ALERT_TYPES.NO_RESULT_HIGH_EFFORT:
    case ALERT_TYPES.HIGH_EFFORT_LOW_RESULT:
      return ctx.isBuy
        ? `High buy effort · weak price response (eff ${ctx.efficiency ?? "—"})`
        : `High sell effort · weak price response (eff ${ctx.efficiency ?? "—"})`;
    default:
      return titleFor(type);
  }
}

function priorityFor(type) {
  if (
    type === ALERT_TYPES.BUYERS_BREAKING_ASKS ||
    type === ALERT_TYPES.SELLERS_BREAKING_BIDS ||
    type === ALERT_TYPES.UP_CONTROL_SHIFT ||
    type === ALERT_TYPES.DOWN_CONTROL_SHIFT
  ) {
    return PRIORITY.CRITICAL;
  }
  if (
    type === ALERT_TYPES.SELLER_DEFENSE_WEAKENING ||
    type === ALERT_TYPES.BUYER_DEFENSE_WEAKENING ||
    type === ALERT_TYPES.UPSIDE_LIQUIDITY_VACUUM ||
    type === ALERT_TYPES.DOWNSIDE_LIQUIDITY_VACUUM ||
    type === ALERT_TYPES.SELLER_ABSORPTION ||
    type === ALERT_TYPES.BUYER_ABSORPTION ||
    type === ALERT_TYPES.NO_RESULT_HIGH_EFFORT ||
    type === ALERT_TYPES.HIGH_EFFORT_LOW_RESULT
  ) {
    return PRIORITY.IMPORTANT;
  }
  return PRIORITY.INFO;
}

/**
 * Build durable snapshot fields for backtesting / UI.
 */
export function buildAlertSnapshot({
  type,
  priority,
  symbol,
  timeframeSec,
  price,
  ctx,
  confidence,
  nowMs,
  extras = {},
}) {
  const isBuy = !!ctx.isBuy;
  return {
    id: `${symbol}-${type}-${nowMs}`,
    ts: nowMs,
    timestamp: nowMs,
    symbol,
    label: symbol?.replace(/USDT$/i, "") || symbol,
    timeframe: timeframeSec,
    timeframeSec,
    layer: "smart",
    alertType: type,
    type,
    priority,
    side: isBuy ? "buy" : "sell",
    title: titleFor(type),
    message: messageFor(type, ctx),
    confidence,
    price: price ?? null,
    AggressiveBuyPower: isBuy ? ctx.attackPower : null,
    AggressiveSellPower: isBuy ? null : ctx.attackPower,
    PassiveSellerDefense: isBuy ? ctx.defensePower : null,
    PassiveBuyerDefense: isBuy ? null : ctx.defensePower,
    BattleSpread: ctx.battleSpread,
    attackPower: ctx.attackPower,
    defensePower: ctx.defensePower,
    battleSpread: ctx.battleSpread,
    Cancellation: ctx.cancelBand,
    Withdrawal: ctx.withdrawal,
    Consumption: ctx.consumeBand,
    Replenishment: ctx.refillBand,
    Survival: ctx.survival,
    cancelBand: ctx.cancelBand,
    refillBand: ctx.refillBand,
    consumeBand: ctx.consumeBand,
    survival: ctx.survival,
    PriceEfficiency: ctx.efficiency,
    PriceDisplacement: ctx.priceMoveBps,
    efficiency: ctx.efficiency,
    priceMoveBps: ctx.priceMoveBps,
    State: ctx.state || type,
    state: ctx.state || type,
    aggressiveVolume: ctx.aggressiveVolume,
    attackPercentile: ctx.attackPercentile,
    ...extras,
  };
}

export class SmartAlertEngine {
  constructor(opts = {}) {
    this.cfg = { ...DEFAULTS, ...opts };
    this.onAlert = opts.onAlert || null;
    /** @type {Array<object>} */
    this.hist = [];
    /** @type {Map<string, { since:number, lastAlertAt:number, lastSpread:number|null, active:boolean }>} */
    this.track = new Map();
    this.crossUpSince = null;
    this.crossDownSince = null;
    this.recent = [];
    this.backtest = new SmartAlertBacktest({
      horizons: [1, 5, 10, 30, 60, 300],
    });
    this.lastSymbol = null;
  }

  clear() {
    this.hist = [];
    this.track.clear();
    this.crossUpSince = null;
    this.crossDownSince = null;
    this.recent = [];
    this.backtest.clear();
  }

  /**
   * @param {object} snap monitor.snapshot()
   * @returns {object[]} newly emitted alerts
   */
  evaluate(snap) {
    const nowMs = Date.now();
    const now = nowMs / 1000;
    const symbol = String(snap?.symbol || "").toUpperCase();
    if (!symbol) return [];

    if (this.lastSymbol && this.lastSymbol !== symbol) this.clear();
    this.lastSymbol = symbol;

    const price = num(snap.price ?? snap.bestBid ?? snap.bestAsk);
    if (Number.isFinite(price) && price > 0) {
      this.backtest.tick(now, price);
    }

    const tradesReady = !!(snap.flowWindows && Object.keys(snap.flowWindows).length);
    const bookStale = !!snap.staleBook || snap.ready === false;
    const missingTrades = !tradesReady && !snap.ready;

    if (missingTrades) {
      return [];
    }

    const w = this.cfg.battleWindowSec;
    const pack = pickBattle(snap, w);
    const buy = sideCtx(pack?.buy, true);
    const sell = sideCtx(pack?.sell, false);
    if (!buy && !sell) return [];

    this._pushHist(nowMs, buy, sell);

    const flow = snap.flowWindows?.[w] || snap.flowWindows?.[String(w)] || {};
    const buyUsd = notional(flow.aggressiveBuyVolume, price);
    const sellUsd = notional(flow.aggressiveSellVolume, price);

    /** @type {object[]} */
    const candidates = [];

    if (buy) {
      candidates.push(
        ...this._classifySide(buy, {
          nowMs,
          bookStale,
          aggUsd: buyUsd,
          priceAvailable: Number.isFinite(price),
        })
      );
    }
    if (sell) {
      candidates.push(
        ...this._classifySide(sell, {
          nowMs,
          bookStale,
          aggUsd: sellUsd,
          priceAvailable: Number.isFinite(price),
        })
      );
    }

    // Crossover control-shift (needs hist persistence)
    const cross = this._crossoverAlerts(buy, sell, nowMs);
    candidates.push(...cross);

    // Defense weakening from hist
    const weaken = this._defenseWeakenAlerts(buy, sell, nowMs);
    candidates.push(...weaken);

    const emitted = [];
    // Prefer critical > important; one per side family max per tick
    const ranked = candidates.sort(
      (a, b) => priorityRank(b.priority) - priorityRank(a.priority)
    );
    const usedFamilies = new Set();

    for (const c of ranked) {
      const family = `${alertFamily(c.type)}:${c.ctx.isBuy ? "buy" : "sell"}`;
      if (usedFamilies.has(family)) continue;
      if (!this._shouldEmit(c.type, c.priority, c.ctx, nowMs)) continue;

      const confidence = bookStale || c.lowConfidence ? "LOW_CONFIDENCE" : "OK";
      const alert = buildAlertSnapshot({
        type: c.type,
        priority: c.priority,
        symbol,
        timeframeSec: w,
        price,
        ctx: c.ctx,
        confidence,
        nowMs,
        extras: {
          triggerUsd: c.aggUsd ?? notional(c.ctx.aggressiveVolume, price),
          windowSec: w,
        },
      });

      this._markEmitted(c.type, c.ctx, nowMs);
      this.recent = [alert, ...this.recent].slice(0, 40);
      this.backtest.pushAlert({
        t: now,
        price,
        type: c.type,
        side: alert.side,
        priority: c.priority,
        spread: c.ctx.battleSpread,
        attack: c.ctx.attackPower,
        defense: c.ctx.defensePower,
      });
      emitted.push(alert);
      usedFamilies.add(family);
      if (this.onAlert) this.onAlert(alert);
    }

    return emitted;
  }

  statusSnapshot() {
    return {
      recent: this.recent.slice(0, 12),
      backtest: this.backtest.summary(),
      battleWindowSec: this.cfg.battleWindowSec,
      histLen: this.hist.length,
    };
  }

  _pushHist(nowMs, buy, sell) {
    this.hist.push({
      t: nowMs,
      buyAtk: buy?.attackPower,
      askDef: buy?.defensePower,
      upSpread: buy?.battleSpread,
      sellAtk: sell?.attackPower,
      bidDef: sell?.defensePower,
      downSpread: sell?.battleSpread,
    });
    while (this.hist.length > this.cfg.histMax) this.hist.shift();
  }

  _classifySide(ctx, { nowMs, bookStale, aggUsd, priceAvailable }) {
    const out = [];
    const cfg = this.cfg;
    const atk = ctx.attackPower;
    const def = ctx.defensePower;
    const spread = ctx.battleSpread;
    const eff = ctx.efficiency;
    const surv = ctx.survival;

    if (atk == null) return out;

    const lowConf =
      bookStale ||
      ctx.attackDq === "LOW_CONFIDENCE" ||
      ctx.defenseDq === "LOW_CONFIDENCE";

    const attackHigh = atk >= cfg.attackHigh;
    const attackMod = atk >= cfg.attackMod;
    const defWeak = def != null && def <= cfg.defenseWeak;
    const defStrong = def != null && def >= cfg.defenseStrong;
    const cancelHi = bandHigh(ctx.cancelBand);
    const refillHi = bandHigh(ctx.refillBand) || bandExtreme(ctx.refillBand);
    const refillLo = bandLow(ctx.refillBand);
    const consumeHi = bandHigh(ctx.consumeBand);
    const survLo = surv != null && surv <= 45;
    const survHi = surv != null && surv >= 60;
    const withdrawHi =
      (ctx.withdrawal != null && ctx.withdrawal >= 55) ||
      (ctx.netWithdrawal != null && ctx.netWithdrawal > 0 && cancelHi);
    const effHi = eff != null && eff >= cfg.effHigh;
    const effLo = eff != null && eff <= cfg.effLow;
    const spreadBreak = spread != null && spread >= cfg.spreadBreak;
    const state = ctx.state || "";

    // Vacuum — defense collapsing (aggression can be only moderate)
    if (
      def != null &&
      (state.includes("VACUUM") ||
        (cancelHi && withdrawHi && survLo && refillLo && defWeak && attackMod))
    ) {
      out.push({
        type: ctx.isBuy
          ? ALERT_TYPES.UPSIDE_LIQUIDITY_VACUUM
          : ALERT_TYPES.DOWNSIDE_LIQUIDITY_VACUUM,
        priority: PRIORITY.IMPORTANT,
        ctx,
        aggUsd,
        lowConfidence: lowConf,
      });
    }

    // Breaking — strong attack, weak defense, price confirms
    if (
      attackHigh &&
      defWeak &&
      spreadBreak &&
      (effHi || spread >= 20) &&
      (cancelHi || consumeHi || withdrawHi) &&
      (refillLo || survLo)
    ) {
      out.push({
        type: ctx.isBuy
          ? ALERT_TYPES.BUYERS_BREAKING_ASKS
          : ALERT_TYPES.SELLERS_BREAKING_BIDS,
        priority: PRIORITY.CRITICAL,
        ctx,
        aggUsd,
        lowConfidence: lowConf,
      });
    }

    // Absorption — only when price response available and weak
    if (
      priceAvailable &&
      !bookStale &&
      attackHigh &&
      defStrong &&
      (refillHi || survHi) &&
      effLo
    ) {
      out.push({
        type: ctx.isBuy ? ALERT_TYPES.SELLER_ABSORPTION : ALERT_TYPES.BUYER_ABSORPTION,
        priority: PRIORITY.IMPORTANT,
        ctx,
        aggUsd,
        lowConfidence: lowConf,
      });
    }

    // High effort / low result
    if (
      priceAvailable &&
      !bookStale &&
      atk >= cfg.highEffortPower &&
      effLo &&
      (aggUsd == null || aggUsd >= cfg.highEffortUsd * 0.25 || atk >= 90)
    ) {
      out.push({
        type: ALERT_TYPES.NO_RESULT_HIGH_EFFORT,
        priority: PRIORITY.IMPORTANT,
        ctx,
        aggUsd,
        lowConfidence: lowConf,
      });
    }

    // Map explicit battle state if strong and not already covered
    if (state === "BUYERS_WINNING" && ctx.isBuy && attackHigh && spreadBreak) {
      out.push({
        type: ALERT_TYPES.BUYERS_BREAKING_ASKS,
        priority: PRIORITY.CRITICAL,
        ctx,
        aggUsd,
        lowConfidence: lowConf,
      });
    }
    if (state === "SELLERS_WINNING" && !ctx.isBuy && attackHigh && spreadBreak) {
      out.push({
        type: ALERT_TYPES.SELLERS_BREAKING_BIDS,
        priority: PRIORITY.CRITICAL,
        ctx,
        aggUsd,
        lowConfidence: lowConf,
      });
    }

    void nowMs;
    return out;
  }

  _crossoverAlerts(buy, sell, nowMs) {
    const out = [];
    const need = this.cfg.crossoverPersistMs;
    const thr = this.cfg.spreadBreak;

    if (buy?.attackPower != null && buy?.defensePower != null && buy.battleSpread != null) {
      const crossed = buy.attackPower > buy.defensePower && buy.battleSpread >= thr;
      if (crossed) {
        if (this.crossUpSince == null) this.crossUpSince = nowMs;
        if (nowMs - this.crossUpSince >= need) {
          out.push({
            type: ALERT_TYPES.UP_CONTROL_SHIFT,
            priority: PRIORITY.CRITICAL,
            ctx: buy,
            aggUsd: null,
            lowConfidence: false,
          });
        }
      } else {
        this.crossUpSince = null;
      }
    }

    if (sell?.attackPower != null && sell?.defensePower != null && sell.battleSpread != null) {
      const crossed = sell.attackPower > sell.defensePower && sell.battleSpread >= thr;
      if (crossed) {
        if (this.crossDownSince == null) this.crossDownSince = nowMs;
        if (nowMs - this.crossDownSince >= need) {
          out.push({
            type: ALERT_TYPES.DOWN_CONTROL_SHIFT,
            priority: PRIORITY.CRITICAL,
            ctx: sell,
            aggUsd: null,
            lowConfidence: false,
          });
        }
      } else {
        this.crossDownSince = null;
      }
    }

    return out;
  }

  _defenseWeakenAlerts(buy, sell, nowMs) {
    const out = [];
    if (this.hist.length < 8) return out;
    const older = this.hist[Math.max(0, this.hist.length - 12)];
    const mid = this.hist[Math.max(0, this.hist.length - 6)];
    const cur = this.hist[this.hist.length - 1];
    const cfg = this.cfg;

    if (
      buy &&
      older.askDef != null &&
      cur.askDef != null &&
      older.buyAtk != null &&
      cur.buyAtk != null &&
      older.askDef - cur.askDef >= cfg.weakenDefDrop &&
      cur.buyAtk - older.buyAtk >= -2 &&
      (cur.buyAtk >= cfg.attackMod || (mid.buyAtk != null && mid.buyAtk >= cfg.attackMod)) &&
      cur.upSpread != null &&
      older.upSpread != null &&
      cur.upSpread - older.upSpread >= 8
    ) {
      out.push({
        type: ALERT_TYPES.SELLER_DEFENSE_WEAKENING,
        priority: PRIORITY.IMPORTANT,
        ctx: buy,
        aggUsd: null,
        lowConfidence: false,
      });
    }

    if (
      sell &&
      older.bidDef != null &&
      cur.bidDef != null &&
      older.sellAtk != null &&
      cur.sellAtk != null &&
      older.bidDef - cur.bidDef >= cfg.weakenDefDrop &&
      cur.sellAtk - older.sellAtk >= -2 &&
      (cur.sellAtk >= cfg.attackMod || (mid.sellAtk != null && mid.sellAtk >= cfg.attackMod)) &&
      cur.downSpread != null &&
      older.downSpread != null &&
      cur.downSpread - older.downSpread >= 8
    ) {
      out.push({
        type: ALERT_TYPES.BUYER_DEFENSE_WEAKENING,
        priority: PRIORITY.IMPORTANT,
        ctx: sell,
        aggUsd: null,
        lowConfidence: false,
      });
    }

    void nowMs;
    return out;
  }

  _shouldEmit(type, priority, ctx, nowMs) {
    const key = type;
    const row = this.track.get(key) || {
      since: nowMs,
      lastAlertAt: 0,
      lastSpread: null,
      active: false,
    };
    const cd = this.cfg.cooldownMs[priority] || 12_000;
    if (nowMs - row.lastAlertAt < cd) {
      // Allow re-alert if spread expands materially while same state active
      if (
        row.active &&
        ctx.battleSpread != null &&
        row.lastSpread != null &&
        ctx.battleSpread - row.lastSpread >= this.cfg.reenterSpreadDelta
      ) {
        return true;
      }
      return false;
    }
    return true;
  }

  _markEmitted(type, ctx, nowMs) {
    this.track.set(type, {
      since: nowMs,
      lastAlertAt: nowMs,
      lastSpread: ctx.battleSpread ?? null,
      active: true,
    });
  }
}

function notional(qty, price) {
  const q = Number(qty);
  const p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0) return null;
  return q * p;
}

function priorityRank(p) {
  if (p === PRIORITY.CRITICAL) return 3;
  if (p === PRIORITY.IMPORTANT) return 2;
  return 1;
}

function alertFamily(type) {
  if (
    type === ALERT_TYPES.BUYERS_BREAKING_ASKS ||
    type === ALERT_TYPES.UP_CONTROL_SHIFT ||
    type === ALERT_TYPES.SELLER_DEFENSE_WEAKENING
  ) {
    return "up-control";
  }
  if (
    type === ALERT_TYPES.SELLERS_BREAKING_BIDS ||
    type === ALERT_TYPES.DOWN_CONTROL_SHIFT ||
    type === ALERT_TYPES.BUYER_DEFENSE_WEAKENING
  ) {
    return "down-control";
  }
  if (type === ALERT_TYPES.SELLER_ABSORPTION) return "up-absorb";
  if (type === ALERT_TYPES.BUYER_ABSORPTION) return "down-absorb";
  if (
    type === ALERT_TYPES.HIGH_EFFORT_LOW_RESULT ||
    type === ALERT_TYPES.NO_RESULT_HIGH_EFFORT
  ) {
    return "effort";
  }
  if (type === ALERT_TYPES.UPSIDE_LIQUIDITY_VACUUM) return "up-vac";
  if (type === ALERT_TYPES.DOWNSIDE_LIQUIDITY_VACUUM) return "down-vac";
  return type;
}

export { PRIORITY };
