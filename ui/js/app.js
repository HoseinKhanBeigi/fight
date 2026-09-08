/**
 * Live order-flow dashboard (aggressive vs passive fight panel).
 */

import {
  BATTLE_CHART_MS,
  createBattleVizState,
  ingestBattleViz,
  ensureBattleVizShell,
  paintBattleViz,
  battleVizEvents,
} from "./battle-viz.js";

/** Same list as oderFlow `DEFAULT_WATCHLIST` + `EQUITY_PERP_WATCHLIST` */
const CRYPTO_WATCHLIST = [
  { symbol: "BTCUSDT", label: "BTC" },
  { symbol: "ETHUSDT", label: "ETH" },
  { symbol: "SOLUSDT", label: "SOL" },
  { symbol: "AVAXUSDT", label: "AVAX" },
  { symbol: "NEARUSDT", label: "NEAR" },
  { symbol: "DOTUSDT", label: "DOT" },
  { symbol: "LINKUSDT", label: "LINK" },
  { symbol: "SUIUSDT", label: "SUI" },
];
const EQUITY_WATCHLIST = [
  { symbol: "AAPLUSDT", label: "AAPL" },
  { symbol: "AMZNUSDT", label: "AMZN" },
  { symbol: "METAUSDT", label: "META" },
  { symbol: "MSFTUSDT", label: "MSFT" },
  { symbol: "GOOGLUSDT", label: "GOOGL" },
  { symbol: "TSLAUSDT", label: "TSLA" },
  { symbol: "AMDUSDT", label: "AMD" },
  { symbol: "NVDAUSDT", label: "NVDA" },
];
const WATCHLIST = [...CRYPTO_WATCHLIST, ...EQUITY_WATCHLIST];

/** Fight metric windows in seconds */
const INTERVALS = [
  { sec: 60, label: "1m" },
  { sec: 300, label: "5m" },
  { sec: 900, label: "15m" },
  { sec: 1800, label: "30m" },
  { sec: 2700, label: "45m" },
];


const ui = {
  symbol: "BTCUSDT",
  interval: 60,
  battleViz: null,
  battleVizPaintAt: 0,
  last: null,
  ticker24h: null,
  headerReady: false,
  switching: false,
};

function $(id) {
  return document.getElementById(id);
}

function fmt(n, d = 3) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const a = Math.abs(x);
  if (a >= 100) return x.toFixed(1);
  if (a >= 1) return x.toFixed(d);
  if (a >= 0.01) return x.toFixed(3);
  if (a === 0) return "";
  return x.toFixed(4);
}

/** USDT notional from base-asset qty × price */
function notional(qty, price) {
  const q = Number(qty);
  const p = Number(price);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0) return 0;
  return q * p;
}

/** Compact USD: $1.2K, $3.45M */
function fmtUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a < 1) return `${sign}$${a.toFixed(2)}`;
  if (a < 1000) return `${sign}$${a.toFixed(0)}`;
  if (a < 1_000_000) return `${sign}$${(a / 1000).toFixed(a < 10_000 ? 2 : 1)}K`;
  return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
}

function usdLine(qty, price) {
  const n = notional(qty, price);
  return `<b title="${fmt(qty)} base @ ${fmtPx(price)}">${fmtUsd(n)}</b><small>${fmt(qty)}</small>`;
}

/** Price band where a metric was observed, e.g. 76900 – 80500 */
function fmtRange(range) {
  if (!range || range.lo == null || range.hi == null) return "";
  const lo = Number(range.lo);
  const hi = Number(range.hi);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return "";
  if (Math.abs(hi - lo) < 1e-12) return fmtPx(lo);
  return `${fmtPx(lo)} – ${fmtPx(hi)}`;
}

function statLine(label, qty, price, range, cls = "", absorbTag = "") {
  const band = fmtRange(range);
  const tag = absorbTag
    ? `<em class="absorb-tag" title="Absorption estimate">${absorbTag}</em>`
    : "";
  return `<span class="${cls}${absorbTag ? " absorbing" : ""}">${label} ${usdLine(qty, price)}${
    tag
  }${band ? `<em class="px-band" title="Price window for this metric">${band}</em>` : ""}</span>`;
}

function battleShare(battle) {
  const attack = Math.min(Number(battle?.attackScore) || 0, 3) / 3;
  const exec = Math.max(0, Math.min(1, Number(battle?.executionRatio) || 0));
  const refill = Math.max(0, Math.min(1, Number(battle?.refillRatio) || 0));
  const force = Math.max(
    0.05,
    Math.min(0.95, 0.5 * attack + 0.35 * exec + 0.15 * (1 - refill))
  );
  return { force, resist: 1 - force };
}

function mergeRanges(a, b) {
  if (!a && !b) return null;
  if (!a) return b;
  if (!b) return a;
  return {
    lo: Math.min(a.lo, b.lo),
    hi: Math.max(a.hi, b.hi),
  };
}

/**
 * Classic compact Aggressive ↔ Passive summary (screenshot layout).
 * Added at top — does not replace detailed cards / charts below.
 */
function renderClassicFight(s) {
  const px = s.price ?? s.bestBid ?? s.bestAsk;
  const w = ui.interval;
  const flow =
    s.flowWindows?.[w] ||
    s.flowWindows?.[60] ||
    s.flowWindows?.[300] ||
    s.flowWindows?.[String(w)] ||
    {};
  const liq =
    s.liqWindows?.[w] ||
    s.liqWindows?.[60] ||
    s.liqWindows?.[300] ||
    s.liqWindows?.[String(w)] ||
    {};
  const abs =
    s.absorptionByWindow?.[w] ||
    s.absorptionByWindow?.[String(w)] ||
    s.absorption ||
    {};

  const buyAbsorbed =
    abs.askAbsorbedVolume ??
    abs.aggressiveBuyAbsorbedVolume ??
    Math.min(flow.aggressiveBuyVolume || 0, liq.askExec || 0, liq.askRefill || 0);
  const sellAbsorbed =
    abs.bidAbsorbedVolume ??
    abs.aggressiveSellAbsorbedVolume ??
    Math.min(flow.aggressiveSellVolume || 0, liq.bidExec || 0, liq.bidRefill || 0);

  const buy = {
    aggressiveVolume: flow.aggressiveBuyVolume ?? s.buyBattle?.aggressiveVolume ?? 0,
    passiveLiquidity: s.askLiquidity ?? s.buyBattle?.passiveLiquidity ?? 0,
    executed: liq.askExec ?? s.buyBattle?.executed ?? 0,
    cancelled: liq.askCancel ?? s.buyBattle?.cancelled ?? 0,
    refill: liq.askRefill ?? s.buyBattle?.refill ?? 0,
    absorbed: buyAbsorbed,
    result: s.buyBattle?.result || "NEUTRAL",
  };
  const sell = {
    aggressiveVolume: flow.aggressiveSellVolume ?? s.sellBattle?.aggressiveVolume ?? 0,
    passiveLiquidity: s.bidLiquidity ?? s.sellBattle?.passiveLiquidity ?? 0,
    executed: liq.bidExec ?? s.sellBattle?.executed ?? 0,
    cancelled: liq.bidCancel ?? s.sellBattle?.cancelled ?? 0,
    refill: liq.bidRefill ?? s.sellBattle?.refill ?? 0,
    absorbed: sellAbsorbed,
    result: s.sellBattle?.result || "NEUTRAL",
  };

  const buyMeter = {
    ...buy,
    executionRatio:
      (liq.askExec ?? 0) + (liq.askCancel ?? 0) > 0
        ? (liq.askExec ?? 0) / Math.max((liq.askExec ?? 0) + (liq.askCancel ?? 0), 1e-9)
        : s.buyBattle?.executionRatio ?? 0,
    refillRatio:
      (liq.askExec ?? 0) > 0
        ? (liq.askRefill ?? 0) / Math.max(liq.askExec, 1e-9)
        : s.buyBattle?.refillRatio ?? 0,
    attackScore: (flow.aggressiveBuyVolume ?? 0) / Math.max(s.askLiquidity || 0, 1e-9),
  };
  const sellMeter = {
    ...sell,
    executionRatio:
      (liq.bidExec ?? 0) + (liq.bidCancel ?? 0) > 0
        ? (liq.bidExec ?? 0) / Math.max((liq.bidExec ?? 0) + (liq.bidCancel ?? 0), 1e-9)
        : s.sellBattle?.executionRatio ?? 0,
    refillRatio:
      (liq.bidExec ?? 0) > 0
        ? (liq.bidRefill ?? 0) / Math.max(liq.bidExec, 1e-9)
        : s.sellBattle?.refillRatio ?? 0,
    attackScore: (flow.aggressiveSellVolume ?? 0) / Math.max(s.bidLiquidity || 0, 1e-9),
  };

  const b = battleShare(buyMeter);
  const se = battleShare(sellMeter);
  const tf = INTERVALS.find((it) => it.sec === w)?.label || `${w}s`;
  const buyResult = abs.ask ? "ASK ABSORPTION · BUYERS ABSORBED" : buy.result || "NEUTRAL";
  const sellResult = abs.bid ? "BID ABSORPTION · SELLERS ABSORBED" : sell.result || "NEUTRAL";
  const buyAbsorbRange = mergeRanges(liq.askExecRange, liq.askRefillRange);
  const sellAbsorbRange = mergeRanges(liq.bidExecRange, liq.bidRefillRange);

  return `
    <div class="classic-fight" aria-label="Classic aggressive vs passive summary">
      <div class="fight-card buy${abs.ask ? " is-absorbing" : ""}">
        <div class="flow">
          <span class="agg">Aggressive buyers</span>
          <span class="arrow">→</span>
          <span class="pas">Passive asks</span>
          <span class="tf">${tf} · USD</span>
        </div>
        <div class="fight-meter" title="Force (aggression) vs Resistance (resting asks)">
          <div class="force" style="width:${(b.force * 100).toFixed(0)}%"></div>
          <div class="resist" style="width:${(b.resist * 100).toFixed(0)}%"></div>
        </div>
        <div class="fight-stats">
          ${statLine("Aggressive", buy.aggressiveVolume, px, null, "", abs.aggressiveBuy ? "ABSORBED" : "")}
          ${statLine("Ask liq", buy.passiveLiquidity, px, s.askLiquidityRange, "pas", abs.ask ? "ABSORBING" : "")}
          ${statLine("Executed", buy.executed, px, liq.askExecRange, "exec")}
          ${statLine("Cancelled", buy.cancelled, px, liq.askCancelRange, "cancel")}
          ${statLine("Refilled", buy.refill, px, liq.askRefillRange, "refill")}
          ${statLine("Absorbed", buy.absorbed, px, buyAbsorbRange, "absorb", abs.ask ? "ACTIVE" : "")}
        </div>
        <div class="fight-result ${stateClass(buyResult)}">${buyResult}</div>
        <div class="fight-hint">Absorbed = min(aggression, executed, refilled) — size soaked by asks (est.).</div>
      </div>
      <div class="fight-card sell${abs.bid ? " is-absorbing" : ""}">
        <div class="flow">
          <span class="agg">Aggressive sellers</span>
          <span class="arrow">→</span>
          <span class="pas">Passive bids</span>
          <span class="tf">${tf} · USD</span>
        </div>
        <div class="fight-meter" title="Force (aggression) vs Resistance (resting bids)">
          <div class="force" style="width:${(se.force * 100).toFixed(0)}%"></div>
          <div class="resist" style="width:${(se.resist * 100).toFixed(0)}%"></div>
        </div>
        <div class="fight-stats">
          ${statLine("Aggressive", sell.aggressiveVolume, px, null, "", abs.aggressiveSell ? "ABSORBED" : "")}
          ${statLine("Bid liq", sell.passiveLiquidity, px, s.bidLiquidityRange, "pas", abs.bid ? "ABSORBING" : "")}
          ${statLine("Executed", sell.executed, px, liq.bidExecRange, "exec")}
          ${statLine("Cancelled", sell.cancelled, px, liq.bidCancelRange, "cancel")}
          ${statLine("Refilled", sell.refill, px, liq.bidRefillRange, "refill")}
          ${statLine("Absorbed", sell.absorbed, px, sellAbsorbRange, "absorb", abs.bid ? "ACTIVE" : "")}
        </div>
        <div class="fight-result ${stateClass(sellResult)}">${sellResult}</div>
        <div class="fight-hint">Absorbed = min(aggression, executed, refilled) — size soaked by bids (est.).</div>
      </div>
    </div>`;
}

function fmtPx(n) {
  if (n == null) return "—";
  const x = Number(n);
  if (x >= 1000) {
    return x.toLocaleString("en-US", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    });
  }
  if (x >= 1) {
    return x.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
  }
  return x.toLocaleString("en-US", {
    minimumFractionDigits: 4,
    maximumFractionDigits: 6,
  });
}

function stateClass(state = "") {
  const s = String(state).toUpperCase().replace(/_/g, " ");
  if (s.includes("ABSORB") || s.includes("DEFENDING")) return "state-absorb";
  if (
    s.includes("BUYERS WINNING") ||
    s.includes("UPSIDE") ||
    s.includes("ASK LIQUIDITY WITHDRAWING") ||
    s.includes("ASK CANCELLATION")
  )
    return "state-buy";
  if (
    s.includes("SELLERS WINNING") ||
    s.includes("DOWNSIDE") ||
    s.includes("BID LIQUIDITY WITHDRAWING") ||
    s.includes("BID CANCELLATION")
  )
    return "state-sell";
  if (s.includes("WALL") || s.includes("VACUUM")) return "state-wall";
  if (s.includes("LOW CONFIDENCE") || s.includes("NO MEANINGFUL")) return "state-neutral";
  return "state-neutral";
}

function connClass(c) {
  const x = String(c || "").toUpperCase();
  if (x === "LIVE") return "live";
  if (x === "DISCONNECTED") return "disconnected";
  return "reconnecting";
}

function fmtScore(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n)}/100`;
}

function fmtPctile(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const p = Number(n);
  const suf = p % 10 === 1 && p !== 11 ? "st" : p % 10 === 2 && p !== 12 ? "nd" : p % 10 === 3 && p !== 13 ? "rd" : "th";
  return `${p}${suf}`;
}

function fmtBps(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  return `${x >= 0 ? "+" : ""}${x.toFixed(1)} bps`;
}

function moneyOrNoData(qty, price) {
  if (qty == null || Number.isNaN(Number(qty))) return `<b class="nodata">NO DATA</b>`;
  return usdLine(qty, price);
}

/** Primary USD notional + optional secondary percentile / band. Never fakes $0 for missing. */
function moneyPrimary(qty, price, { percentile = null, band = null, signed = false, snapshot = false } = {}) {
  if (qty == null || Number.isNaN(Number(qty))) return `<b class="nodata">NO DATA</b>`;
  const n = notional(qty, price);
  let money = fmtUsd(n);
  if (signed && n > 0) money = `+${money}`;
  const bits = [];
  if (percentile != null && Number.isFinite(Number(percentile))) bits.push(`${fmtPctile(percentile)} percentile`);
  else if (band && band !== "UNKNOWN") bits.push(band);
  if (snapshot) bits.push("current depth");
  const tip = `${fmt(qty)} base @ ${fmtPx(price)}`;
  return `<b title="${tip}">${money}</b>${bits.length ? `<small>${bits.join(" · ")}</small>` : ""}`;
}

function row(label, valueHtml) {
  return `<div class="battle-row"><span class="k">${label}</span><span class="v">${valueHtml}</span></div>`;
}

function section(title, body) {
  return `<div class="battle-sec"><div class="battle-sec-title">${title}</div>${body}</div>`;
}

function prettyState(state = "") {
  return String(state || "NEUTRAL").replace(/_/g, " ");
}

/**
 * Display-only passive profile state (uses existing percentile / passiveState context).
 * Does not alter battle engine classification.
 */
function passiveProfileState(card, isBuy) {
  const d = card?.defense || {};
  const q = d.dataQuality || card?.passiveState;
  if (q === "NO_DATA" || card?.passiveState === "NO_DATA") return "NO_DATA";
  if (q === "STALE" || card?.passiveState === "STALE") return "STALE";
  if (q === "LOW_CONFIDENCE" || card?.passiveState === "LOW_CONFIDENCE") return "LOW_CONFIDENCE";

  const ps = String(card?.passiveState || "");
  const cancelP = Number(d.cancelPercentile);
  const refillP = Number(d.refillPercentile);
  const churn = String(d.churnLabel || "");

  if (ps === "ASK_CANCELLATION_SURGE" || ps === "BID_CANCELLATION_SURGE") {
    return isBuy ? "ASK_CANCELLATION_DOMINANT" : "BID_CANCELLATION_DOMINANT";
  }
  if (ps === "ASK_REPLENISHMENT_SURGE" || ps === "BID_REPLENISHMENT_SURGE") {
    return isBuy ? "ASK_REPLENISHMENT_DOMINANT" : "BID_REPLENISHMENT_DOMINANT";
  }
  if (
    (churn === "HIGH_CHURN" || churn === "EXTREME_CHURN") &&
    Number.isFinite(cancelP) &&
    Number.isFinite(refillP) &&
    cancelP >= 70 &&
    refillP >= 70
  ) {
    return isBuy ? "ASK_HIGH_CHURN" : "BID_HIGH_CHURN";
  }
  if (ps === "ASK_LIQUIDITY_WITHDRAWING" || ps === "BID_LIQUIDITY_WITHDRAWING") return ps;
  if (ps === "ASK_LIQUIDITY_BUILDING" || ps === "BID_LIQUIDITY_BUILDING") return ps;
  if (ps === "ASK_LIQUIDITY_STABLE") return "ASK_LIQUIDITY_STABLE";
  if (ps === "BID_LIQUIDITY_STABLE") return "BIDS_HOLDING";
  if (ps === "ASK_SURVIVING") return "ASK_LIQUIDITY_STABLE";
  if (ps === "BID_SURVIVING") return "BIDS_HOLDING";
  if (ps) return ps;
  return isBuy ? "ASK_LIQUIDITY_STABLE" : "BIDS_HOLDING";
}

/** Cancelled / Refilled composition only — Consumed has its own shape. */
function passiveActivityBar(d) {
  if (d?.cancelled == null && d?.replenished == null) return "";
  const c = Number.isFinite(Number(d.cancelled)) ? Math.max(0, Number(d.cancelled)) : 0;
  const r = Number.isFinite(Number(d.replenished)) ? Math.max(0, Number(d.replenished)) : 0;
  const tot = c + r;
  if (tot <= 0) {
    return `<div class="plp-bar empty" title="No cancel/refill activity in window"></div>`;
  }
  const pc = (c / tot) * 100;
  const pr = (r / tot) * 100;
  return `
    <div class="plp-bar" title="Cancelled ${pc.toFixed(0)}% · Refilled ${pr.toFixed(0)}%">
      <i class="cancel" style="width:${pc}%"></i>
      <i class="refill" style="width:${pr}%"></i>
    </div>
    <div class="plp-bar-legend">
      <span class="cancel">Cancelled</span>
      <span class="refill">Refilled</span>
    </div>`;
}

/**
 * Net Withdrawal when NewAdded (stacked) is unavailable / unused.
 * Net Change = stacked + refilled − cancelled − consumed when stacked is present.
 */
function passiveNetRow(d, px) {
  const cancelled = d.cancelled;
  const replenished = d.replenished;
  const consumed = d.consumed;
  const stacked = d.stacked;
  const hasNewAdded = stacked != null && Number(stacked) > 0;

  // NewAdded / stack not available → Net Withdrawal = Cancelled − Refilled
  if (!hasNewAdded) {
    if (cancelled == null || replenished == null) {
      return row("Net Withdrawal", `<b class="nodata">NO DATA</b>`);
    }
    const net = Number(cancelled) - Number(replenished);
    if (!Number.isFinite(net)) return row("Net Withdrawal", `<b class="nodata">NO DATA</b>`);
    if (net >= 0) return row("Net Withdrawal", moneyPrimary(net, px));
    return row("Net Addition", moneyPrimary(Math.abs(net), px, { signed: true }));
  }

  // Incomplete inputs → do not invent Net Change
  if (cancelled == null || replenished == null || consumed == null) {
    return row("Net Change", `<b class="nodata">NO DATA</b>`);
  }
  const net =
    d.behavioralNetChange != null
      ? Number(d.behavioralNetChange)
      : Number(stacked) + Number(replenished) - Number(cancelled) - Number(consumed);
  if (!Number.isFinite(net)) return row("Net Change", `<b class="nodata">NO DATA</b>`);
  return row("Net Change", moneyPrimary(net, px, { signed: true }));
}

function clampScore(n, fallback = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(0, Math.min(100, x));
}

/**
 * Separate bridge shape: Aggressive flow vs Consumed resting liquidity.
 * Sits between Passive Liquidity and Absorption (Response).
 * Consumed ≠ Aggressive — they are related but separately measured.
 */
function consumedShape(card, px, sideClass) {
  const a = card?.attack || {};
  const d = card?.defense || {};
  const isBuy = sideClass === "buy";
  const aggLabel = isBuy ? "Aggressive Buy" : "Aggressive Sell";
  const consLabel = isBuy ? "Ask Consumed" : "Bid Consumed";

  const aggQty = a.aggressiveVolume;
  const consQty = d.consumed;
  const missingAgg = aggQty == null || Number.isNaN(Number(aggQty));
  const missingCons = consQty == null || Number.isNaN(Number(consQty));

  const aggUsd = missingAgg ? null : notional(aggQty, px);
  const consUsd = missingCons ? null : notional(consQty, px);
  const maxUsd = Math.max(aggUsd || 0, consUsd || 0, 1e-9);
  const aggPct = missingAgg ? 0 : Math.round(((aggUsd || 0) / maxUsd) * 100);
  const consPct = missingCons ? 0 : Math.round(((consUsd || 0) / maxUsd) * 100);

  let ratioHtml = `<b class="nodata">NO DATA</b>`;
  let read = "WAITING";
  let readClass = "wait";
  if (!missingAgg && !missingCons) {
    const ratio = (consUsd || 0) / Math.max(aggUsd || 0, 1e-9);
    ratioHtml = `<b>${(ratio * 100).toFixed(0)}%</b><small>consumed / aggressive</small>`;
    if ((aggUsd || 0) <= 0 && (consUsd || 0) <= 0) {
      read = "NO FLOW";
      readClass = "wait";
    } else if (ratio >= 1.15) {
      read = "CONSUMED > ATTACK";
      readClass = "cons-lead";
    } else if (ratio >= 0.85) {
      read = "MATCHED HIT";
      readClass = "matched";
    } else if (ratio >= 0.45) {
      read = "PARTIAL HIT";
      readClass = "partial";
    } else {
      read = "LOW HIT · THIN FILL";
      readClass = "thin";
    }
  } else if (missingAgg && missingCons) {
    read = "NO DATA";
  } else if (missingCons) {
    read = "CONSUMED MISSING";
  } else {
    read = "ATTACK MISSING";
  }

  const bubble = (kind, label, usd, pct, missing) => {
    const size = missing ? 36 : 34 + Math.round((pct / 100) * 28);
    return `
      <div class="cons-bubble ${kind}" style="width:${size}px;height:${size}px" title="${label}">
        <span class="cons-bubble-lab">${kind === "agg" ? "ATK" : "CON"}</span>
      </div>
      <div class="cons-meta">
        <span>${label}</span>
        ${missing ? `<b class="nodata">NO DATA</b>` : `<b>${fmtUsd(usd)}</b>`}
        ${
          !missing && d.consumePercentile != null && kind === "cons"
            ? `<small>${fmtPctile(d.consumePercentile)} percentile</small>`
            : !missing && a.percentile != null && kind === "agg"
              ? `<small>${fmtPctile(a.percentile)} percentile</small>`
              : ""
        }
      </div>`;
  };

  return `
    <div class="battle-sec cons-sec">
      <div class="battle-sec-title">Consumed · Aggressive → Resting</div>
      <div class="cons-shape" aria-label="Aggressive versus consumed liquidity">
        <div class="cons-pair">
          ${bubble("agg", aggLabel, aggUsd, aggPct, missingAgg)}
          <div class="cons-vs">→</div>
          ${bubble("cons", consLabel, consUsd, consPct, missingCons)}
        </div>
        <div class="cons-bars">
          <div class="cons-bar-row">
            <span>Aggressive</span>
            <div class="cons-track"><i class="agg" style="width:${aggPct}%"></i></div>
          </div>
          <div class="cons-bar-row">
            <span>Consumed</span>
            <div class="cons-track"><i class="cons" style="width:${consPct}%"></i></div>
          </div>
        </div>
        <div class="cons-ratio">${row("Hit ratio", ratioHtml)}</div>
        <div class="cons-read ${readClass}">${read}</div>
        <div class="cons-note">Aggressive = tape · Consumed = resting liquidity removed by trades · not the same metric</div>
      </div>
    </div>`;
}

/**
 * Visual: Attack → Defense → Response.
 * Node size = stage strength; arrow weight = pressure transfer;
 * verdict says which stage currently dominates the outcome.
 */
function flowShape(card, sideClass) {
  const a = card.attack || {};
  const d = card.defense || {};
  const r = card.response || {};
  const isBuy = sideClass === "buy";

  const attack = clampScore(a.power, 50);
  const defense = clampScore(
    0.6 * (d.survival ?? 50) + 0.4 * (100 - (d.withdrawal ?? 50)),
    50
  );
  const responsePush = clampScore(r.efficiency, 50); // price follows attack
  const responseHold = clampScore(r.absorptionScore, 50); // defense soaks attack
  const response = Math.max(responsePush, responseHold);

  // Pressure transfer along the chain
  const hit = (attack / 100) * (1 - defense / 100); // attack getting through defense
  const soak = (attack / 100) * (defense / 100); // attack meeting resistance
  const toPrice = hit * (responsePush / 100);
  const absorbed = soak * (responseHold / 100);

  let verdict = "BALANCED FLOW";
  let verdictClass = "flow-balanced";
  if (responseHold >= 60 && defense >= 55 && attack >= 45) {
    verdict = isBuy ? "DEFENSE HOLDS · SELLERS ABSORB" : "DEFENSE HOLDS · BUYERS ABSORB";
    verdictClass = "flow-defense";
  } else if (responsePush >= 55 && attack >= 55 && defense <= 50) {
    verdict = isBuy ? "ATTACK BREAKS THROUGH · BUYERS" : "ATTACK BREAKS THROUGH · SELLERS";
    verdictClass = "flow-attack";
  } else if (defense >= 65 && attack < 50) {
    verdict = "DEFENSE DOMINANT";
    verdictClass = "flow-defense";
  } else if (attack >= 65 && defense < 45) {
    verdict = "ATTACK DOMINANT";
    verdictClass = "flow-attack";
  } else if (responsePush >= 60) {
    verdict = "RESPONSE FAVORS ATTACK";
    verdictClass = "flow-attack";
  } else if (responseHold >= 60) {
    verdict = "RESPONSE FAVORS DEFENSE";
    verdictClass = "flow-defense";
  }

  const stages = [
    { key: "attack", label: "ATTACK", score: attack },
    { key: "defense", label: "DEFENSE", score: defense },
    { key: "response", label: "RESPONSE", score: response },
  ];
  const strongest = stages.reduce((b, x) => (x.score > b.score ? x : b), stages[0]);

  const node = (key, label, score) => {
    const size = 28 + (score / 100) * 22;
    const active = strongest.key === key ? " active" : "";
    return `
      <div class="flow-node ${key}${active}" style="--s:${score};width:${size}px;height:${size}px" title="${label} ${score}/100">
        <span class="flow-node-score">${score}</span>
        <span class="flow-node-label">${label}</span>
      </div>`;
  };

  const arrow = (weight, kind) => {
    const w = Math.max(2, Math.round(2 + weight * 10));
    return `<div class="flow-arrow ${kind}" style="--w:${w}px" title="${kind} ${(weight * 100).toFixed(0)}%">
      <span class="flow-arrow-line"></span>
      <span class="flow-arrow-head"></span>
    </div>`;
  };

  return `
    <div class="flow-shape" aria-label="Attack defense response flow">
      <div class="flow-chain">
        ${node("attack", "ATTACK", attack)}
        ${arrow(Math.max(hit, soak), hit >= soak ? "pierce" : "press")}
        ${node("defense", "DEFENSE", defense)}
        ${arrow(Math.max(toPrice, absorbed), toPrice >= absorbed ? "follow" : "soak")}
        ${node("response", "RESPONSE", response)}
      </div>
      <div class="flow-bars">
        <div class="flow-bar attack" style="width:${attack}%"><span>A ${attack}</span></div>
        <div class="flow-bar defense" style="width:${defense}%"><span>D ${defense}</span></div>
        <div class="flow-bar response" style="width:${response}%"><span>R ${response}</span></div>
      </div>
      <div class="flow-verdict ${verdictClass}">
        <span class="flow-strongest">Strongest: ${strongest.label}</span>
        <span class="flow-read">${verdict}</span>
      </div>
    </div>
  `;
}

/** Format a value that is already USD notional (not base qty). */
function usdOrNoData(n) {
  if (n == null || Number.isNaN(Number(n))) return `<b class="nodata">NO DATA</b>`;
  return `<b>${fmtUsd(Number(n))}</b>`;
}

function multiVenuePanel(s) {
  const mv = s?.multiVenue;
  if (!mv?.venues) return "";
  const order = mv.venueOrder || Object.keys(mv.venues);
  const rows = order
    .map((id) => {
      const v = mv.venues[id];
      if (!v) return "";
      const st = !v.supported
        ? "unsupported"
        : v.ready
          ? "live"
          : v.stale
            ? "stale"
            : "wait";
      return `
        <div class="mv-venue ${st}">
          <div class="mv-name">${v.label}</div>
          <div class="mv-side"><span>Ask</span><b>${v.askUsd == null ? "—" : fmtUsd(v.askUsd)}</b></div>
          <div class="mv-side"><span>Bid</span><b>${v.bidUsd == null ? "—" : fmtUsd(v.bidUsd)}</b></div>
          <div class="mv-st">${prettyState(v.status || st)}</div>
        </div>`;
    })
    .join("");

  const live = mv.total?.venuesLive ?? 0;
  const cfg = mv.total?.venuesConfigured ?? 0;

  return `
    <div class="mv-panel" aria-label="Multi-venue liquidity sum">
      <div class="mv-head">
        <div class="mv-title">All-venue liquidity</div>
        <div class="mv-sub">${mv.base || s.symbol || ""} · top ${mv.levels || 20} · ${live}/${cfg} live</div>
        <div class="mv-totals">
          <div class="mv-total ask">
            <span>Σ Ask</span>
            <b>${mv.total?.askUsd == null ? "—" : fmtUsd(mv.total.askUsd)}</b>
          </div>
          <div class="mv-total bid">
            <span>Σ Bid</span>
            <b>${mv.total?.bidUsd == null ? "—" : fmtUsd(mv.total.bidUsd)}</b>
          </div>
        </div>
      </div>
      <div class="mv-grid">${rows}</div>
      <div class="mv-note">Sum of near-touch USD depth across Binance + OKX + Bybit + Hyperliquid. Battle metrics stay Binance-primary.</div>
    </div>`;
}

function renderBattleCard(card, px, sideClass, titleAgg, titlePas, tf, multiVenue = null) {
  if (!card) {
    return `<div class="fight-card ${sideClass}"><div class="flow">${titleAgg}</div><div class="fight-hint">Waiting for battle metrics…</div></div>`;
  }
  const a = card.attack || {};
  const d = card.defense || {};
  const r = card.response || {};
  const L = card.labels || {};
  const isBuy = sideClass === "buy";
  const absorbing = (r.absorptionScore || 0) >= 65;
  const aggLabel = isBuy ? "Aggressive Buy" : "Aggressive Sell";
  const depthPct =
    d.features?.depth != null && Number.isFinite(Number(d.features.depth))
      ? Number(d.features.depth)
      : null;
  const allUsd = isBuy ? multiVenue?.total?.askUsd : multiVenue?.total?.bidUsd;
  const liveN = multiVenue?.total?.venuesLive;

  const attackBody = [
    row(aggLabel, moneyPrimary(a.aggressiveVolume, px, { percentile: a.percentile, band: a.percentileBand })),
  ].join("");

  const passiveBody = [
    row(
      "Current (Binance)",
      moneyPrimary(d.currentLiquidity, px, {
        percentile: depthPct,
        snapshot: true,
      })
    ),
    row(
      "Current (All venues)",
      allUsd == null
        ? `<b class="nodata">NO DATA</b>`
        : `${usdOrNoData(allUsd)}<small>${liveN || 0} venues · current depth</small>`
    ),
    row(
      "Cancelled",
      moneyPrimary(d.cancelled, px, { percentile: d.cancelPercentile, band: d.cancelBand })
    ),
    row(
      "Refilled",
      moneyPrimary(d.replenished, px, { percentile: d.refillPercentile, band: d.refillBand })
    ),
    passiveNetRow(d, px),
  ].join("");

  const profileState = passiveProfileState(card, isBuy);
  const profileStateClass =
    profileState === "NO_DATA" || profileState === "STALE" || profileState === "LOW_CONFIDENCE"
      ? "plp-state warn"
      : profileState.includes("WITHDRAW") || profileState.includes("CANCELLATION")
        ? "plp-state bad"
        : profileState.includes("BUILD") ||
            profileState.includes("REPLENISH") ||
            profileState.includes("HOLD") ||
            profileState.includes("STABLE")
          ? "plp-state good"
          : "plp-state";

  const responseBody = [
    row(
      "Absorbed",
      r.estimatedAbsorbedFlow == null
        ? `<b class="nodata">NO DATA</b>`
        : `${moneyPrimary(r.estimatedAbsorbedFlow, px)}<small>est. USD soaked</small>`
    ),
    row(
      "Absorption score",
      r.absorptionScore == null
        ? `<b class="nodata">NO DATA</b>`
        : `<b class="absorb">${fmtScore(r.absorptionScore)}</b><small>0–100 strength</small>`
    ),
    row(L.efficiency || "Price Efficiency", `<b>${fmtScore(r.efficiency)}</b>`),
    row("Price Move", `<b>${fmtBps(r.priceMoveBps)}</b>`),
  ].join("");

  const evidence = (card.evidence || [])
    .map((e) => `<li><span>${e.k}</span><b>${e.v}</b></li>`)
    .join("");

  return `
    <div class="fight-card ${sideClass}${absorbing ? " is-absorbing" : ""}">
      <div class="flow">
        <span class="agg">${titleAgg}</span>
        <span class="arrow">→</span>
        <span class="pas">${titlePas}</span>
        <span class="tf">${tf} · USD</span>
      </div>
      ${flowShape(card, sideClass)}
      ${section("Attack", attackBody)}
      <div class="battle-sec plp">
        <div class="battle-sec-title">Passive Liquidity</div>
        ${passiveActivityBar(d)}
        ${passiveBody}
        <div class="${profileStateClass}">${prettyState(profileState)}</div>
      </div>
      ${consumedShape(card, px, sideClass)}
      ${section("Response · Absorption", responseBody)}
      <div class="fight-result ${stateClass(card.state)}">${prettyState(card.state)}</div>
      <div class="fight-why">${card.why || ""}</div>
      ${
        evidence
          ? `<details class="fight-evidence"><summary>Why / evidence</summary><ul>${evidence}</ul></details>`
          : ""
      }
    </div>
  `;
}

/**
 * Presence maps:
 * 1) Opposing book: Agg buyers vs Asks · Agg sellers vs Bids
 * 2) Same-side: Agg buyers vs Passive bids · Agg sellers vs Passive asks
 * 3) Whole two-side: (Agg buyers + Passive bids) vs (Agg sellers + Passive asks)
 */
function sidePresenceShape(s, w, px) {
  const flow =
    s.flowWindows?.[w] ||
    s.flowWindows?.[60] ||
    s.flowWindows?.[String(w)] ||
    {};
  const pack = s.battlesByWindow?.[w] || s.battlesByWindow?.[String(w)] || {};
  const aggBuy = Number(flow.aggressiveBuyVolume ?? pack.buy?.attack?.aggressiveVolume) || 0;
  const aggSell = Number(flow.aggressiveSellVolume ?? pack.sell?.attack?.aggressiveVolume) || 0;
  const passAsk = Number(s.askLiquidity ?? pack.buy?.defense?.currentLiquidity) || 0;
  const passBid = Number(s.bidLiquidity ?? pack.sell?.defense?.currentLiquidity) || 0;

  const pair = (agg, pass, kind, mode) => {
    const total = Math.max(agg + pass, 1e-9);
    const aggPct = Math.round((agg / total) * 100);
    const passPct = 100 - aggPct;
    const aggDom = agg >= pass;

    let title;
    let aggLabel;
    let passLabel;
    let verdict;
    if (mode === "same") {
      title = kind === "buy" ? "Buy side presence" : "Sell side presence";
      aggLabel = kind === "buy" ? "Aggressive buyers" : "Aggressive sellers";
      passLabel = kind === "buy" ? "Passive buyers (bids)" : "Passive sellers (asks)";
      verdict =
        kind === "buy"
          ? aggDom
            ? "AGGRESSIVE BUYERS LEAD"
            : "PASSIVE BUYERS LEAD"
          : aggDom
            ? "AGGRESSIVE SELLERS LEAD"
            : "PASSIVE SELLERS LEAD";
    } else {
      title = kind === "buy" ? "Buyers → Asks" : "Sellers → Bids";
      aggLabel = kind === "buy" ? "Aggressive buyers" : "Aggressive sellers";
      passLabel = kind === "buy" ? "Passive asks" : "Passive bids";
      verdict =
        kind === "buy"
          ? aggDom
            ? "AGGRESSIVE BUYERS PRESS ASKS"
            : "PASSIVE ASKS OUTWEIGH BUYERS"
          : aggDom
            ? "AGGRESSIVE SELLERS PRESS BIDS"
            : "PASSIVE BIDS OUTWEIGH SELLERS";
    }

    const aggSize = 34 + (aggPct / 100) * 28;
    const passSize = 34 + (passPct / 100) * 28;

    return `
      <div class="side-pair ${kind}">
        <div class="side-pair-title">${title}</div>
        <div class="side-pair-chain">
          <div class="side-bubble agg" style="width:${aggSize}px;height:${aggSize}px" title="Aggressive ${fmtUsd(notional(agg, px))}">
            <b>${aggPct}</b>
            <span>AGG</span>
          </div>
          <div class="side-vs">
            <div class="side-vs-track">
              <i class="agg" style="width:${aggPct}%"></i>
              <i class="pass" style="width:${passPct}%"></i>
            </div>
            <em>vs</em>
          </div>
          <div class="side-bubble pass" style="width:${passSize}px;height:${passSize}px" title="Passive ${fmtUsd(notional(pass, px))}">
            <b>${passPct}</b>
            <span>PAS</span>
          </div>
        </div>
        <div class="side-pair-meta">
          <span class="agg-m">${aggLabel} <b>${fmtUsd(notional(agg, px))}</b></span>
          <span class="pass-m">${passLabel} <b>${fmtUsd(notional(pass, px))}</b></span>
        </div>
        <div class="side-pair-verdict ${aggDom ? "agg-lead" : "pass-lead"}">${verdict}</div>
      </div>`;
  };

  // Whole market sides: buy team vs sell team
  const buyTeam = aggBuy + passBid; // aggressive buyers + passive buyers (bids)
  const sellTeam = aggSell + passAsk; // aggressive sellers + passive sellers (asks)
  const both = Math.max(buyTeam + sellTeam, 1e-9);
  const buyPct = Math.round((buyTeam / both) * 100);
  const sellPct = 100 - buyPct;
  const buyLeads = buyTeam >= sellTeam;
  const buySize = 42 + (buyPct / 100) * 36;
  const sellSize = 42 + (sellPct / 100) * 36;

  return `
    <div class="side-presence" aria-label="Aggressive vs passive presence maps">
      <div class="side-presence-block">
        <div class="side-presence-head">
          <span>Opposing book</span>
          <small>Aggressive buyers vs asks · Aggressive sellers vs bids</small>
        </div>
        <div class="side-presence-grid">
          ${pair(aggBuy, passAsk, "buy", "oppose")}
          ${pair(aggSell, passBid, "sell", "oppose")}
        </div>
      </div>
      <div class="side-presence-block">
        <div class="side-presence-head">
          <span>Same-side presence</span>
          <small>Aggressive buyers vs passive bids · Aggressive sellers vs passive asks</small>
        </div>
        <div class="side-presence-grid">
          ${pair(aggBuy, passBid, "buy", "same")}
          ${pair(aggSell, passAsk, "sell", "same")}
        </div>
      </div>
      <div class="side-presence-block">
        <div class="side-presence-head">
          <span>Whole two-side</span>
          <small>Aggressive buyers + passive bids  vs  Aggressive sellers + passive asks</small>
        </div>
        <div class="whole-sides">
          <div class="whole-side buy">
            <div class="side-bubble whole" style="width:${buySize}px;height:${buySize}px">
              <b>${buyPct}</b>
              <span>BUY</span>
            </div>
            <div class="whole-meta">
              <div class="whole-title">Buy team</div>
              <div>Aggressive buyers <b>${fmtUsd(notional(aggBuy, px))}</b></div>
              <div>Passive bids <b>${fmtUsd(notional(passBid, px))}</b></div>
              <div class="whole-total">Total <b>${fmtUsd(notional(buyTeam, px))}</b></div>
            </div>
          </div>
          <div class="whole-vs">
            <div class="side-vs-track whole-track">
              <i class="buy" style="width:${buyPct}%"></i>
              <i class="sell" style="width:${sellPct}%"></i>
            </div>
            <em>VS</em>
            <div class="whole-verdict ${buyLeads ? "buy-lead" : "sell-lead"}">
              ${buyLeads ? "BUY SIDE STRONGER" : "SELL SIDE STRONGER"}
            </div>
          </div>
          <div class="whole-side sell">
            <div class="side-bubble whole" style="width:${sellSize}px;height:${sellSize}px">
              <b>${sellPct}</b>
              <span>SELL</span>
            </div>
            <div class="whole-meta">
              <div class="whole-title">Sell team</div>
              <div>Aggressive sellers <b>${fmtUsd(notional(aggSell, px))}</b></div>
              <div>Passive asks <b>${fmtUsd(notional(passAsk, px))}</b></div>
              <div class="whole-total">Total <b>${fmtUsd(notional(sellTeam, px))}</b></div>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function ensureFightShell() {
  const el = $("fight");
  // Classic summary on top, then Market Battle charts + detailed cards.
  // Drop Passive Liquidity Profile radar / Pre-move if an older shell is present.
  if (
    el.querySelector("#classic-fight-root") &&
    el.querySelector("#shock-events-root") &&
    el.querySelector("#battle-viz-root") &&
    el.querySelector("#battle-cards") &&
    !el.querySelector("#premove-root") &&
    !el.querySelector("#liquidity-profile-root")
  ) {
    return;
  }
  el.innerHTML = `<div id="classic-fight-root"></div><div id="shock-events-root"></div><div id="battle-viz-root" class="bv-root"></div><div id="battle-cards"></div>`;
}

function modelTfLabel() {
  return INTERVALS.find((it) => it.sec === ui.interval)?.label || `${ui.interval}s`;
}

function refreshBattleViz() {
  if (!ui.battleViz) ui.battleViz = createBattleVizState();
  ensureFightShell();
  ensureBattleVizShell($("battle-viz-root"), ui.battleViz, modelTfLabel(), () => {
    paintBattleViz(ui.battleViz, modelTfLabel());
  });
  paintBattleViz(ui.battleViz, modelTfLabel());
  requestAnimationFrame(() => paintBattleViz(ui.battleViz, modelTfLabel()));
  window.__battleVizEvents = () => battleVizEvents(ui.battleViz);
  window.__battleVizHistory = () => ({
    upside: [...(ui.battleViz.upside.hist || [])],
    downside: [...(ui.battleViz.downside.hist || [])],
  });
}

/**
 * Display-only alerts for huge aggressive flow + liquidity vacuum.
 * Uses existing flow / battle / liquidity fields — does not change engine math.
 */
function detectShockEvents(s) {
  const px = s.price ?? s.bestBid ?? s.bestAsk;
  const w = ui.interval;
  const flow =
    s.flowWindows?.[w] ||
    s.flowWindows?.[60] ||
    s.flowWindows?.[String(w)] ||
    {};
  const liq =
    s.liqWindows?.[w] ||
    s.liqWindows?.[60] ||
    s.liqWindows?.[String(w)] ||
    {};
  const pack = s.battlesByWindow?.[w] || s.battlesByWindow?.[String(w)] || {};
  const buy = pack.buy || {};
  const sell = pack.sell || {};
  const events = [];

  const buyAgg = Number(flow.aggressiveBuyVolume || buy.attack?.aggressiveVolume || 0);
  const sellAgg = Number(flow.aggressiveSellVolume || sell.attack?.aggressiveVolume || 0);
  const largeBuy = Number(flow.largeBuyVolume || buy.attack?.largeVolume || 0);
  const largeSell = Number(flow.largeSellVolume || sell.attack?.largeVolume || 0);
  const askLiq = Number(s.askLiquidity || buy.defense?.currentLiquidity || 0);
  const bidLiq = Number(s.bidLiquidity || sell.defense?.currentLiquidity || 0);
  const buyPower = Number(buy.attack?.power);
  const sellPower = Number(sell.attack?.power);
  const buyLargeShare = buyAgg > 0 ? largeBuy / buyAgg : 0;
  const sellLargeShare = sellAgg > 0 ? largeSell / sellAgg : 0;
  const buyVsAsk = askLiq > 0 ? buyAgg / askLiq : 0;
  const sellVsBid = bidLiq > 0 ? sellAgg / bidLiq : 0;

  const hugeBuy =
    (buyLargeShare >= 0.45 && largeBuy > 0 && (buyPower >= 60 || buyVsAsk >= 0.08)) ||
    (buyPower >= 80 && buyLargeShare >= 0.3 && largeBuy > 0) ||
    (buyVsAsk >= 0.25 && buyAgg > 0 && buyPower >= 55);
  const hugeSell =
    (sellLargeShare >= 0.45 && largeSell > 0 && (sellPower >= 60 || sellVsBid >= 0.08)) ||
    (sellPower >= 80 && sellLargeShare >= 0.3 && largeSell > 0) ||
    (sellVsBid >= 0.25 && sellAgg > 0 && sellPower >= 55);

  if (hugeBuy) {
    events.push({
      id: "huge-buy",
      kind: "huge",
      side: "buy",
      title: "HUGE AGGRESSIVE BUY",
      detail: `Large prints ${fmtUsd(notional(largeBuy, px))} · ${(buyLargeShare * 100).toFixed(0)}% of buy aggression · attack ${Number.isFinite(buyPower) ? buyPower : "—"}/100`,
      money: notional(largeBuy || buyAgg, px),
      secondary: `vs ask depth ${fmtUsd(notional(askLiq, px))} (${(buyVsAsk * 100).toFixed(0)}% of near asks)`,
    });
  }
  if (hugeSell) {
    events.push({
      id: "huge-sell",
      kind: "huge",
      side: "sell",
      title: "HUGE AGGRESSIVE SELL",
      detail: `Large prints ${fmtUsd(notional(largeSell, px))} · ${(sellLargeShare * 100).toFixed(0)}% of sell aggression · attack ${Number.isFinite(sellPower) ? sellPower : "—"}/100`,
      money: notional(largeSell || sellAgg, px),
      secondary: `vs bid depth ${fmtUsd(notional(bidLiq, px))} (${(sellVsBid * 100).toFixed(0)}% of near bids)`,
    });
  }

  const buyState = String(buy.state || "");
  const sellState = String(sell.state || "");
  const buyPas = String(buy.passiveState || "");
  const sellPas = String(sell.passiveState || "");
  const askCancel = Number(liq.askCancel || buy.defense?.cancelled || 0);
  const bidCancel = Number(liq.bidCancel || sell.defense?.cancelled || 0);
  const askRefill = Number(liq.askRefill || buy.defense?.replenished || 0);
  const bidRefill = Number(liq.bidRefill || sell.defense?.replenished || 0);
  const askWithdraw = Math.max(0, askCancel - askRefill);
  const bidWithdraw = Math.max(0, bidCancel - bidRefill);
  const askSurvival = Number(buy.defense?.survival);
  const bidSurvival = Number(sell.defense?.survival);
  const askDef = Number(buy.defense?.power);
  const bidDef = Number(sell.defense?.power);
  const askCancelBand = String(buy.defense?.cancelBand || "");
  const bidCancelBand = String(sell.defense?.cancelBand || "");

  const upsideVacuum =
    buyState.includes("VACUUM") ||
    ((askCancelBand === "EXTREME" || askCancelBand === "HIGH" || buyPas.includes("WITHDRAW")) &&
      (askSurvival <= 45 || askDef <= 40) &&
      buyAgg > 0 &&
      (buyPower >= 45 || buyVsAsk >= 0.05) &&
      askWithdraw > askRefill);

  const downsideVacuum =
    sellState.includes("VACUUM") ||
    ((bidCancelBand === "EXTREME" || bidCancelBand === "HIGH" || sellPas.includes("WITHDRAW")) &&
      (bidSurvival <= 45 || bidDef <= 40) &&
      sellAgg > 0 &&
      (sellPower >= 45 || sellVsBid >= 0.05) &&
      bidWithdraw > bidRefill);

  if (upsideVacuum) {
    events.push({
      id: "vacuum-up",
      kind: "vacuum",
      side: "up",
      title: "UPSIDE LIQUIDITY VACUUM",
      detail: buyState.includes("VACUUM")
        ? prettyState(buyState)
        : "Asks withdrawing / thin while buy aggression presses upside",
      money: notional(askWithdraw, px),
      secondary: `Ask withdrawn ${fmtUsd(notional(askWithdraw, px))} · survival ${Number.isFinite(askSurvival) ? askSurvival : "—"}/100 · defense ${Number.isFinite(askDef) ? askDef : "—"}/100`,
    });
  }
  if (downsideVacuum) {
    events.push({
      id: "vacuum-down",
      kind: "vacuum",
      side: "down",
      title: "DOWNSIDE LIQUIDITY VACUUM",
      detail: sellState.includes("VACUUM")
        ? prettyState(sellState)
        : "Bids withdrawing / thin while sell aggression presses downside",
      money: notional(bidWithdraw, px),
      secondary: `Bid withdrawn ${fmtUsd(notional(bidWithdraw, px))} · survival ${Number.isFinite(bidSurvival) ? bidSurvival : "—"}/100 · defense ${Number.isFinite(bidDef) ? bidDef : "—"}/100`,
    });
  }

  // Combined: huge aggression into a vacuum is the strongest shock
  if (hugeBuy && upsideVacuum) {
    events.unshift({
      id: "shock-up",
      kind: "shock",
      side: "buy",
      title: "BUY SHOCK INTO ASK VACUUM",
      detail: "Huge aggressive buys hitting thinning / withdrawing asks",
      money: notional(largeBuy || buyAgg, px),
      secondary: `Large buy ${fmtUsd(notional(largeBuy, px))} · ask withdraw ${fmtUsd(notional(askWithdraw, px))}`,
    });
  }
  if (hugeSell && downsideVacuum) {
    events.unshift({
      id: "shock-down",
      kind: "shock",
      side: "sell",
      title: "SELL SHOCK INTO BID VACUUM",
      detail: "Huge aggressive sells hitting thinning / withdrawing bids",
      money: notional(largeSell || sellAgg, px),
      secondary: `Large sell ${fmtUsd(notional(largeSell, px))} · bid withdraw ${fmtUsd(notional(bidWithdraw, px))}`,
    });
  }

  return events;
}

function renderShockEvents(s) {
  const events = detectShockEvents(s);
  const tf = INTERVALS.find((it) => it.sec === ui.interval)?.label || `${ui.interval}s`;
  if (!events.length) {
    return `
      <div class="shock-panel is-clear">
        <div class="shock-head">
          <div class="shock-title">Aggression & vacuum</div>
          <div class="shock-sub">${tf} · no huge aggression / vacuum alert</div>
        </div>
      </div>`;
  }

  const cards = events
    .map((e) => {
      return `
        <div class="shock-card ${e.kind} ${e.side}">
          <div class="shock-card-title">${e.title}</div>
          <div class="shock-card-money">${fmtUsd(e.money)}</div>
          <div class="shock-card-detail">${e.detail}</div>
          <div class="shock-card-sec">${e.secondary}</div>
        </div>`;
    })
    .join("");

  return `
    <div class="shock-panel has-alerts">
      <div class="shock-head">
        <div class="shock-title">Aggression & vacuum</div>
        <div class="shock-sub">${tf} · ${events.length} active alert${events.length > 1 ? "s" : ""}</div>
      </div>
      <div class="shock-grid">${cards}</div>
    </div>`;
}

function paintBattle(s) {
  ensureFightShell();
  if (!ui.battleViz) ui.battleViz = createBattleVizState();
  ensureBattleVizShell($("battle-viz-root"), ui.battleViz, modelTfLabel(), () => {
    paintBattleViz(ui.battleViz, modelTfLabel());
  });

  const classic = $("classic-fight-root");
  if (classic) classic.innerHTML = renderClassicFight(s);
  const shock = $("shock-events-root");
  if (shock) shock.innerHTML = renderShockEvents(s);

  const px = s.price ?? s.bestBid ?? s.bestAsk;
  const w = ui.interval;
  const tf = INTERVALS.find((it) => it.sec === w)?.label || `${w}s`;
  const pack = s.battlesByWindow?.[w] || s.battlesByWindow?.[String(w)] || null;
  const buy = pack?.buy;
  const sell = pack?.sell;
  const cards = $("battle-cards");

  if (!buy && !sell) {
    cards.innerHTML = `
      <div class="fight-card buy"><div class="fight-hint">Waiting for battle engine… restart the server if this persists.</div></div>
      <div class="fight-card sell"><div class="fight-hint">Waiting for battle engine…</div></div>
    `;
    return;
  }

  cards.innerHTML = `
    ${multiVenuePanel(s)}
    ${sidePresenceShape(s, w, px)}
    ${renderBattleCard(buy, px, "buy", "Aggressive buyers", "Passive asks", tf, s.multiVenue)}
    ${renderBattleCard(sell, px, "sell", "Aggressive sellers", "Passive bids", tf, s.multiVenue)}
  `;

  const lead = buy?.state || sell?.state || s.buyBattle?.result || s.sellBattle?.result;
  if (lead && $("h-state") && !ui.switching) {
    $("h-state").textContent = prettyState(lead);
    $("h-state").className = `state ${stateClass(lead)}`;
  }
}

function renderFooter() {
  $("footer").innerHTML = `
    <div class="note" style="grid-column:1/-1">
      Attack = aggressive trade flow · Passive Liquidity = current depth + window consumed / cancelled / refilled (USD).
      All-venue Σ Ask / Σ Bid = Binance + OKX + Bybit + Hyperliquid near-touch USD depth.
      Consumed / Cancelled / Refilled and battle scores remain Binance-primary for now.
      Absorption stays in Response only.
      Consumed ≠ Aggressive (aggressive is executed tape; consumed is resting liquidity removed by trades).
    </div>
  `;
}

function switchSymbol(next) {
  const sym = String(next || "").toUpperCase();
  if (!sym || sym === ui.symbol) return;
  ui.symbol = sym;
  ui.switching = true;
  const conn = $("h-conn");
  if (conn) {
    conn.textContent = "RECONNECTING";
    conn.className = "conn reconnecting";
  }
  if ($("h-sym")) $("h-sym").textContent = sym;
  const sel = $("sym");
  if (sel) sel.value = sym;
  syncWatchlistChips();
  send({ type: "setSymbol", symbol: sym.toLowerCase() });
  ui.battleViz = createBattleVizState();
  ui.battleVizPaintAt = 0;
}

function ensureHeader() {
  if (ui.headerReady) return;
  $("header").innerHTML = `
    <div class="sym" id="h-sym">—</div>
    <div class="px" id="h-px">—</div>
    <div class="meta">
      <span>Bid <b id="h-bid" style="color:var(--buy)">—</b></span>
      <span>Ask <b id="h-ask" style="color:var(--sell)">—</b></span>
      <span>Spr <b id="h-spr">—</b></span>
      <span>24h <b id="h-chg">—</b></span>
    </div>
    <div class="state state-neutral" id="h-state">NEUTRAL</div>
    <div class="controls">
      <select id="sym">
        <optgroup label="Crypto">
          ${CRYPTO_WATCHLIST.map(
            (c) => `<option value="${c.symbol}">${c.label}</option>`
          ).join("")}
        </optgroup>
        <optgroup label="Equity perps">
          ${EQUITY_WATCHLIST.map(
            (c) => `<option value="${c.symbol}">${c.label}</option>`
          ).join("")}
        </optgroup>
      </select>
      <div class="seg" id="iv">
        ${INTERVALS.map(
          (it) => `<button type="button" data-n="${it.sec}">${it.label}</button>`
        ).join("")}
      </div>
      <div class="conn reconnecting" id="h-conn">RECONNECTING</div>
    </div>
  `;

  const watch = $("watchlist");
  if (watch) {
    watch.innerHTML = `
      <div class="watch-group">
        <span class="watch-label">Crypto</span>
        ${CRYPTO_WATCHLIST.map(
          (c) =>
            `<button type="button" class="watch-chip" data-sym="${c.symbol}">${c.label}</button>`
        ).join("")}
      </div>
      <div class="watch-group">
        <span class="watch-label">Equity</span>
        ${EQUITY_WATCHLIST.map(
          (c) =>
            `<button type="button" class="watch-chip" data-sym="${c.symbol}">${c.label}</button>`
        ).join("")}
      </div>
    `;
    watch.querySelectorAll(".watch-chip").forEach((btn) => {
      btn.addEventListener("click", () => switchSymbol(btn.dataset.sym));
    });
  }

  const sel = $("sym");
  sel.value = ui.symbol;
  sel.addEventListener("change", () => switchSymbol(sel.value));

  $("iv").querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.n);
      if (!n || n === ui.interval) return;
      ui.interval = n;
      ui.battleViz = createBattleVizState();
      ui.battleViz.chartWindow = 60;
      ui.battleVizPaintAt = 0;
      syncIntervalButtons();
      if (ui.last) renderAll(ui.last, true);
    });
  });

  ui.headerReady = true;
  syncIntervalButtons();
  syncWatchlistChips();
}

function syncIntervalButtons() {
  $("iv")?.querySelectorAll("button").forEach((btn) => {
    btn.classList.toggle("active", Number(btn.dataset.n) === ui.interval);
  });
}

function syncWatchlistChips() {
  $("watchlist")?.querySelectorAll(".watch-chip").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sym === ui.symbol);
  });
}

function renderHeader(s) {
  ensureHeader();

  if (s?.symbol) {
    const live = String(s.symbol).toUpperCase();
    if (ui.switching) {
      if (live === ui.symbol) ui.switching = false;
    } else {
      ui.symbol = live;
    }
  }

  const sel = $("sym");
  if (sel && document.activeElement !== sel) {
    sel.value = ui.symbol;
  }
  syncWatchlistChips();

  $("h-sym").textContent = s?.symbol || ui.symbol;
  $("h-px").textContent = fmtPx(s?.price);
  $("h-bid").textContent = fmtPx(s?.bestBid);
  $("h-ask").textContent = fmtPx(s?.bestAsk);
  $("h-spr").textContent = fmt(s?.spread, 2);

  const ch = ui.ticker24h?.priceChangePercent;
  const chEl = $("h-chg");
  if (ch == null) {
    chEl.textContent = "—";
    chEl.style.color = "var(--text-1)";
  } else {
    chEl.textContent = `${Number(ch) >= 0 ? "+" : ""}${Number(ch).toFixed(2)}%`;
    chEl.style.color = Number(ch) >= 0 ? "var(--buy)" : "var(--sell)";
  }

  const st = $("h-state");
  st.textContent = s?.state || "NEUTRAL";
  st.className = `state ${stateClass(s?.state)}`;

  const conn = $("h-conn");
  const c = s?.connection || "RECONNECTING";
  conn.textContent = c;
  conn.className = `conn ${connClass(c)}`;
  conn.title = s?.status || "";
}

function renderAll(s, forcePaint = false) {
  ui.last = s;
  if (!ui.battleViz) ui.battleViz = createBattleVizState();
  ingestBattleViz(ui.battleViz, s, ui.interval);
  renderHeader(s);
  paintBattle(s);
  const now = Date.now();
  if (forcePaint || now - ui.battleVizPaintAt >= BATTLE_CHART_MS) {
    ui.battleVizPaintAt = now;
    refreshBattleViz();
  }
}

let ws;
function send(obj) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);

  ws.onopen = () => {
    send({ type: "setSymbol", symbol: ui.symbol.toLowerCase() });
  };

  ws.onmessage = (msg) => {
    let data;
    try {
      data = JSON.parse(msg.data);
    } catch {
      return;
    }
    if (data.type === "snapshot") renderAll(data.payload);
    else if (data.type === "ticker24h") {
      ui.ticker24h = data.payload;
      if (ui.headerReady) renderHeader(ui.last || { symbol: ui.symbol });
    } else if (data.type === "status") {
      renderHeader({
        ...(ui.last || { symbol: ui.symbol }),
        connection: data.connection,
        status: data.status,
        symbol: ui.switching ? ui.symbol : ui.last?.symbol || ui.symbol,
      });
    }
  };

  ws.onclose = () => {
    renderHeader({
      ...(ui.last || { symbol: ui.symbol }),
      connection: "DISCONNECTED",
      status: "Reconnecting…",
      symbol: ui.symbol,
    });
    setTimeout(connect, 1500);
  };
}

ensureHeader();
renderHeader({ symbol: ui.symbol, connection: "RECONNECTING" });
renderFooter();
connect();
