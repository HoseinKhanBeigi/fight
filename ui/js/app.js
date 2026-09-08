/**
 * Live order-flow dashboard (aggressive vs passive fight panel).
 */

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

const PREMOVE_INTERVALS = [
  { sec: 5, label: "5s" },
  { sec: 10, label: "10s" },
  { sec: 30, label: "30s" },
  { sec: 60, label: "1m" },
  { sec: 300, label: "5m" },
  { sec: 900, label: "15m" },
];

const PREMOVE_PAINT_MS = 1000;
const PREMOVE_EMA_TAU_SEC = 4;
const PREMOVE_ENTER = 70;
const PREMOVE_EXIT = 55;
const PREMOVE_STRONG_ENTER = 80;
const PREMOVE_STRONG_EXIT = 65;
const PREMOVE_HOLD_MS = 3000;
const PREMOVE_STRONG_HOLD_MS = 5000;

const ui = {
  symbol: "BTCUSDT",
  interval: 60,
  preMoveInterval: 10,
  preMoveOpen: {
    metrics: false,
    contrib: false,
    backtest: false,
    calib: false,
  },
  preMovePaintAt: 0,
  last: null,
  ticker24h: null,
  headerReady: false,
  switching: false,
  displayPressure: null,
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

function row(label, valueHtml) {
  return `<div class="battle-row"><span class="k">${label}</span><span class="v">${valueHtml}</span></div>`;
}

function section(title, body) {
  return `<div class="battle-sec"><div class="battle-sec-title">${title}</div>${body}</div>`;
}

function prettyState(state = "") {
  return String(state || "NEUTRAL").replace(/_/g, " ");
}

function clampScore(n, fallback = 0) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  return Math.max(0, Math.min(100, x));
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

function renderBattleCard(card, px, sideClass, titleAgg, titlePas, tf) {
  if (!card) {
    return `<div class="fight-card ${sideClass}"><div class="flow">${titleAgg}</div><div class="fight-hint">Waiting for battle metrics…</div></div>`;
  }
  const a = card.attack || {};
  const d = card.defense || {};
  const r = card.response || {};
  const L = card.labels || {};
  const absorbing = (r.absorptionScore || 0) >= 65;

  const attackBody = [
    row(L.aggressive || "Aggressive Volume", moneyOrNoData(a.aggressiveVolume, px)),
    row("Power", `<b>${fmtScore(a.power)}</b>`),
    row("Percentile", `<b>${fmtPctile(a.percentile)}</b><small>${a.percentileBand || ""}</small>`),
    row(
      "Velocity",
      a.velocity == null
        ? `<b class="nodata">NO DATA</b>`
        : `<b>${fmtUsd(notional(a.velocity, px))}/s</b>`
    ),
  ].join("");

  const netLabel =
    (d.netWithdrawal || 0) >= (d.netAddition || 0) ? "Net Withdrawal" : "Net Addition";
  const netVal =
    (d.netWithdrawal || 0) >= (d.netAddition || 0) ? d.netWithdrawal : d.netAddition;

  const defenseBody = [
    row(L.liquidity || "Liquidity", moneyOrNoData(d.currentLiquidity, px)),
    row(L.consumed || "Consumed", moneyOrNoData(d.consumed, px)),
    row(L.cancelled || "Cancelled", moneyOrNoData(d.cancelled, px)),
    row(L.replenished || "Replenished", moneyOrNoData(d.replenished, px)),
    row(netLabel, moneyOrNoData(netVal, px)),
    row("Survival", `<b>${fmtScore(d.survival)}</b>`),
    row("Withdrawal", `<b>${fmtScore(d.withdrawal)}</b>`),
    row(
      "Cancel context",
      `<b>${fmtPctile(d.cancelPercentile)}</b><small>${d.cancelBand || ""}</small>`
    ),
    row("Churn", `<b>${prettyState(d.churnLabel)}</b>`),
  ].join("");

  const responseBody = [
    row(L.efficiency || "Price Efficiency", `<b>${fmtScore(r.efficiency)}</b>`),
    row(L.absorption || "Absorption", `<b class="absorb">${fmtScore(r.absorptionScore)}</b>`),
    row(
      "Estimated Absorbed Flow",
      `<b class="absorb">${fmtUsd(notional(r.estimatedAbsorbedFlow, px))}</b><small>estimate</small>`
    ),
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
      ${section("Defense", defenseBody)}
      ${section("Response", responseBody)}
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

function selectedWindow(s) {
  return Number(ui.preMoveInterval || s?.preMove?.primaryWindow || 10);
}

function pressureForSelected(s) {
  const w = selectedWindow(s);
  const pm = s?.preMove;
  const cur = pm?.current;
  const row = windowRow(pm, w);
  const fromCurrent = Number(cur?.windowSec) === w;
  return {
    windowSec: w,
    up: Number(fromCurrent ? cur.upPressure : row?.upPressure),
    down: Number(fromCurrent ? cur.downPressure : row?.downPressure),
    card: fromCurrent
      ? cur
      : Number(ui.displayPressure?.card?.windowSec) === w
        ? ui.displayPressure.card
        : null,
    confidence: Number(fromCurrent ? cur?.confidence : ui.displayPressure?.confidence) || 0,
  };
}

function emptyDisplayPressure(windowSec) {
  return {
    windowSec,
    up: null,
    down: null,
    lastTs: 0,
    hist: [],
    state: "BALANCED",
    candidate: null,
    candidateSince: 0,
    lastChange: 0,
    card: null,
    confidence: 0,
  };
}

function emaStep(prev, next, dtSec, tau) {
  if (!Number.isFinite(next)) return prev;
  if (!Number.isFinite(prev)) return next;
  const a = 1 - Math.exp(-Math.max(dtSec, 0.05) / tau);
  return prev + a * (next - prev);
}

function trendFromHist(hist, field) {
  if (!hist?.length) return "STABLE";
  const now = hist[hist.length - 1];
  const target = now.t - PREMOVE_EMA_TAU_SEC;
  let then = hist[0][field];
  for (const row of hist) {
    if (row.t >= target) {
      then = row[field];
      break;
    }
    then = row[field];
  }
  const delta = (now[field] ?? 0) - (then ?? 0);
  if (delta >= 12) return "RISING_FAST";
  if (delta >= 4) return "RISING";
  if (delta <= -12) return "FALLING_FAST";
  if (delta <= -4) return "FALLING";
  return "STABLE";
}

function displayCandidate(up, down, conf, committed) {
  if (conf < 35) return "LOW_CONFIDENCE";
  const upIn =
    committed === "STRONG_UPSIDE_PRESSURE"
      ? up > PREMOVE_STRONG_EXIT
      : committed === "UPSIDE_PRESSURE"
        ? up > PREMOVE_EXIT
        : up >= PREMOVE_ENTER;
  const downIn =
    committed === "STRONG_DOWNSIDE_PRESSURE"
      ? down > PREMOVE_STRONG_EXIT
      : committed === "DOWNSIDE_PRESSURE"
        ? down > PREMOVE_EXIT
        : down >= PREMOVE_ENTER;

  const strongUp = up >= PREMOVE_STRONG_ENTER || (committed === "STRONG_UPSIDE_PRESSURE" && up > PREMOVE_STRONG_EXIT);
  const strongDown = down >= PREMOVE_STRONG_ENTER || (committed === "STRONG_DOWNSIDE_PRESSURE" && down > PREMOVE_STRONG_EXIT);

  if (strongUp && !strongDown && up >= down + 8) return "STRONG_UPSIDE_PRESSURE";
  if (strongDown && !strongUp && down >= up + 8) return "STRONG_DOWNSIDE_PRESSURE";
  if (upIn && downIn) return "COMPRESSION";
  if (upIn && !downIn) return "UPSIDE_PRESSURE";
  if (downIn && !upIn) return "DOWNSIDE_PRESSURE";
  if (up >= 50 && down >= 50 && Math.abs(up - down) < 12) return "COMPRESSION";
  return "BALANCED";
}

function commitDisplayState(dp, now, next) {
  dp.state = next;
  dp.candidate = null;
  dp.candidateSince = 0;
  dp.lastChange = now;
}

function ingestDisplayPressure(s) {
  const src = pressureForSelected(s);
  const w = src.windowSec;
  if (!ui.displayPressure || ui.displayPressure.windowSec !== w) {
    ui.displayPressure = emptyDisplayPressure(w);
  }
  const dp = ui.displayPressure;
  const now = Date.now();
  const dtSec = dp.lastTs ? Math.min(2, (now - dp.lastTs) / 1000) : 0.25;
  dp.lastTs = now;
  dp.windowSec = w;
  if (src.card && Number(src.card.windowSec) === w) dp.card = src.card;
  dp.confidence = src.confidence;
  dp.rawUp = src.up;
  dp.rawDown = src.down;

  if (Number.isFinite(src.up)) dp.up = emaStep(dp.up, src.up, dtSec, PREMOVE_EMA_TAU_SEC);
  if (Number.isFinite(src.down)) dp.down = emaStep(dp.down, src.down, dtSec, PREMOVE_EMA_TAU_SEC);

  dp.hist.push({ t: now, up: dp.up, down: dp.down });
  const cutoff = now - 8000;
  while (dp.hist.length > 2 && dp.hist[0].t < cutoff) dp.hist.shift();

  const up = dp.up ?? 0;
  const down = dp.down ?? 0;
  const desired = displayCandidate(up, down, src.confidence, dp.state);

  if (desired === dp.state) {
    dp.candidate = null;
    dp.candidateSince = 0;
    return dp;
  }

  if (dp.candidate !== desired) {
    dp.candidate = desired;
    dp.candidateSince = now;
    return dp;
  }

  if (now - dp.candidateSince < PREMOVE_HOLD_MS) return dp;

  const strongDwell =
    (dp.state === "STRONG_UPSIDE_PRESSURE" || dp.state === "STRONG_DOWNSIDE_PRESSURE") &&
    desired !== "LOW_CONFIDENCE" &&
    dp.lastChange &&
    now - dp.lastChange < PREMOVE_STRONG_HOLD_MS;
  if (strongDwell) return dp;

  commitDisplayState(dp, now, desired);
  return dp;
}

function signedNum(n, d = 0) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const v = d ? x.toFixed(d) : String(Math.round(x));
  return x > 0 ? `+${v}` : v;
}

function trendClass(t = "") {
  const s = String(t).toUpperCase();
  if (s.includes("RISING")) return "rise";
  if (s.includes("FALLING")) return "fall";
  return "";
}

function premoveStateClass(state = "") {
  const s = String(state).toUpperCase();
  if (s.includes("LOW_CONFIDENCE")) return "low";
  if (s === "NO_PRESSURE" || s === "BALANCED") return "low";
  if (s.includes("TRANSIENT") || s.includes("COMPRESSION") || s.includes("TWO_SIDED")) return "warn";
  if (s.includes("DOWNSIDE") || s.includes("LOWER") || s.includes("DOWN_PRESSURE")) return "down";
  if (s.includes("UPSIDE") || s.includes("UPPER") || s.includes("UP_PRESSURE")) return "up";
  return "low";
}

function tfLabel(sec) {
  return PREMOVE_INTERVALS.find((it) => it.sec === Number(sec))?.label || `${sec}s`;
}

function featureLabel(key) {
  return String(key || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

function windowRow(pm, sec) {
  return pm.byWindow?.[sec] || pm.byWindow?.[String(sec)] || null;
}

function tfBias(row) {
  const d = (row?.upPressure || 0) - (row?.downPressure || 0);
  if (d >= 10) return "UP";
  if (d <= -10) return "DOWN";
  return "BALANCED";
}

function tfBiasClass(bias) {
  if (bias === "UP") return "up";
  if (bias === "DOWN") return "down";
  return "";
}

function bucketBias(pm, secs) {
  let up = 0;
  let down = 0;
  for (const sec of secs) {
    const row = windowRow(pm, sec);
    if (!row) continue;
    const bias = tfBias(row);
    if (bias === "UP") up += 1;
    else if (bias === "DOWN") down += 1;
  }
  if (up > down) return "Up";
  if (down > up) return "Down";
  return "Mixed";
}

function alignmentSummary(pm) {
  const align = pm.alignment || {};
  const n = (pm.windows || PREMOVE_INTERVALS.map((x) => x.sec)).length;
  const up = align.upCount || 0;
  const down = align.downCount || 0;
  if (up > down && up >= 3) return `${up} / ${n} timeframes favor upside`;
  if (down > up && down >= 3) return `${down} / ${n} timeframes favor downside`;
  return `Split · ${up} up · ${down} down · ${align.flatCount ?? n - up - down} balanced`;
}

function mainDriver(c, confirm) {
  const bd = c.breakdown || { upside: {}, downside: {} };
  const f = c.features || {};
  const upA = bd.upside.attackPower ?? 0;
  const dnA = bd.downside.attackPower ?? 0;
  const upB = bd.upside.bookPreparation ?? 0;
  const dnB = bd.downside.bookPreparation ?? 0;
  const upD = bd.upside.askDefenseWeakening ?? 0;
  const dnD = bd.downside.bidDefenseWeakening ?? 0;
  const askRep = bd.upside.askReplenishment ?? f.AskReplenishment ?? 0;
  const bidRep = bd.downside.bidReplenishment ?? f.BidReplenishment ?? 0;
  const askSurv = bd.upside.askSurvival ?? f.AskSurvival ?? 0;
  const bidSurv = bd.downside.bidSurvival ?? f.BidSurvival ?? 0;
  const askWith = bd.upside.askWithdrawal ?? f.AskWithdrawal ?? 0;
  const bidWith = bd.downside.bidWithdrawal ?? f.BidWithdrawal ?? 0;
  const askCons = bd.upside.askConsumption ?? f.AskConsumption ?? 0;
  const bidCons = bd.downside.bidConsumption ?? f.BidConsumption ?? 0;
  const cs = String(confirm?.state || "");

  if (cs === "SELLER_ABSORPTION") {
    return {
      label: "SELLER ABSORPTION",
      text: `Buy attack is ${upA}/100, but ask replenishment ${askRep}/100 and survival ${askSurv}/100 are still holding.`,
    };
  }
  if (cs === "BUYER_ABSORPTION") {
    return {
      label: "BUYER ABSORPTION",
      text: `Sell attack is ${dnA}/100, but bid replenishment ${bidRep}/100 and survival ${bidSurv}/100 are still holding.`,
    };
  }

  const scored = [];
  if (dnA >= 58 && bidRep >= 65 && bidSurv >= 60) {
    scored.push({
      s: dnA + bidRep,
      label: "BID REPLENISHMENT DEFENDING",
      text: `Sell attack is ${dnA}/100, but bid replenishment ${bidRep}/100 and survival ${bidSurv}/100 are preventing expansion.`,
    });
  }
  if (upA >= 58 && askRep >= 65 && askSurv >= 60) {
    scored.push({
      s: upA + askRep,
      label: "ASK REPLENISHMENT DEFENDING",
      text: `Buy attack is ${upA}/100, but ask replenishment ${askRep}/100 and survival ${askSurv}/100 are preventing expansion.`,
    });
  }
  if (askWith >= 70 && upB >= 60) {
    scored.push({
      s: askWith + 8,
      label: "ASK LIQUIDITY WITHDRAWING",
      text: `Ask withdrawal is ${askWith}/100 and upside book preparation is ${upB}/100.`,
    });
  }
  if (bidWith >= 70 && dnB >= 60) {
    scored.push({
      s: bidWith + 8,
      label: "BID LIQUIDITY WITHDRAWING",
      text: `Bid withdrawal is ${bidWith}/100 and downside book preparation is ${dnB}/100.`,
    });
  }
  if (upD >= 68 && upD >= dnD + 12) {
    scored.push({
      s: upD,
      label: "ASK DEFENSE WEAKENING",
      text: `Ask defense weakening is ${upD}/100 while bid defense weakening is ${dnD}/100.`,
    });
  }
  if (dnD >= 68 && dnD >= upD + 12) {
    scored.push({
      s: dnD,
      label: "BID DEFENSE WEAKENING",
      text: `Bid defense weakening is ${dnD}/100 while ask defense weakening is ${upD}/100.`,
    });
  }
  if (upA >= 60 && (c.upTrend === "RISING" || c.upTrend === "RISING_FAST")) {
    scored.push({
      s: upA + 5,
      label: "BUY AGGRESSION INCREASING",
      text: `Buy attack is ${upA}/100 and up-pressure trend is ${prettyState(c.upTrend)}.`,
    });
  }
  if (dnA >= 60 && (c.downTrend === "RISING" || c.downTrend === "RISING_FAST")) {
    scored.push({
      s: dnA + 5,
      label: "SELL AGGRESSION RISING",
      text: `Sell attack is ${dnA}/100 and down-pressure trend is ${prettyState(c.downTrend)}.`,
    });
  }
  if (upA >= 55 && dnA >= 55 && Math.abs((c.pressureImbalance || 0)) < 12) {
    scored.push({
      s: 50 + Math.min(upA, dnA),
      label: "TWO-SIDED COMPRESSION",
      text: `Attack is two-sided (up ${upA}/100, down ${dnA}/100) and imbalance is ${signedNum(c.pressureImbalance)}.`,
    });
  }
  if (upA >= 58 && askCons >= 60 && askRep < 45) {
    scored.push({
      s: upA,
      label: "BUY AGGRESSION INCREASING",
      text: `Buy attack ${upA}/100 with ask consumption ${askCons}/100 and replenishment only ${askRep}/100.`,
    });
  }
  if (dnA >= 58 && bidCons >= 60 && bidRep < 45) {
    scored.push({
      s: dnA,
      label: "SELL AGGRESSION RISING",
      text: `Sell attack ${dnA}/100 with bid consumption ${bidCons}/100 and replenishment only ${bidRep}/100.`,
    });
  }

  scored.sort((a, b) => b.s - a.s);
  if (scored[0]) return { label: scored[0].label, text: scored[0].text };

  if ((c.pressureImbalance || 0) > 8) {
    return {
      label: "UPSIDE BIAS",
      text: `Up pressure ${c.upPressure}/100 vs down ${c.downPressure}/100. Strongest upside factor is attack ${upA}/100.`,
    };
  }
  if ((c.pressureImbalance || 0) < -8) {
    return {
      label: "DOWNSIDE BIAS",
      text: `Down pressure ${c.downPressure}/100 vs up ${c.upPressure}/100. Strongest downside factor is attack ${dnA}/100.`,
    };
  }
  return {
    label: "BALANCED",
    text: `Up ${c.upPressure}/100 and down ${c.downPressure}/100. Neither attack (${upA} vs ${dnA}) nor defense weakening (${upD} vs ${dnD}) is dominant.`,
  };
}

function factorBar(score, side) {
  const n = clampScore(score);
  return `<div class="pm-fbar ${side}"><i style="width:${n}%"></i></div><b>${n}</b>`;
}

function contribBlocks(contrib) {
  if (!contrib) return "<div class='fight-hint'>No contribution data.</div>";
  const entries = Object.entries(contrib).filter(([, v]) => Number.isFinite(v));
  const pos = entries.filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const neg = entries.filter(([, v]) => v < 0).sort((a, b) => a[1] - b[1]);
  const list = (arr) =>
    arr
      .map(
        ([k, v]) =>
          `<div class="pm-row"><span>${featureLabel(k)}</span><b class="${v >= 0 ? "rise" : "fall"}">${signedNum(v, 1)}</b></div>`
      )
      .join("");
  return `<div class="pm-contrib-grid">
    <div><div class="pm-kicker">Positive</div>${list(pos) || "<div class='fight-hint'>None</div>"}</div>
    <div><div class="pm-kicker">Negative</div>${list(neg) || "<div class='fight-hint'>None</div>"}</div>
  </div>`;
}

function metricRows(pairs) {
  return `<div class="pm-rows">${pairs
    .map(([k, v]) => {
      let shown = "—";
      if (typeof v === "string") shown = v;
      else if (Number.isFinite(v)) shown = String(v);
      return `<div class="pm-row"><span>${k}</span><b>${shown}</b></div>`;
    })
    .join("")}</div>`;
}

function dispScore(n) {
  if (!Number.isFinite(n)) return "—";
  return Math.round(n);
}

function renderPreMove(s) {
  const pm = s.preMove;
  if (!pm?.current && !pm?.byWindow) {
    return `<div class="premove"><div class="premove-title">Pre-move pressure</div><div class="fight-hint">Waiting for pre-move engine…</div></div>`;
  }

  const w = selectedWindow(s);
  const dp = ui.displayPressure || emptyDisplayPressure(w);
  const c =
    dp.card && Number(dp.card.windowSec) === w
      ? dp.card
      : Number(pm.current?.windowSec) === w
        ? pm.current
        : null;
  const bd = c?.breakdown || { upside: {}, downside: {} };
  const f = c?.features || {};
  const confirm = pm.confirmation || {};
  const up = dp.up;
  const down = dp.down;
  const imb = Number.isFinite(up) && Number.isFinite(down) ? Math.round(up - down) : 0;
  const upTrend = trendFromHist(dp.hist, "up");
  const downTrend = trendFromHist(dp.hist, "down");
  const conf = Number(dp.confidence ?? c?.confidence) || 0;
  const state = conf < 35 ? "LOW_CONFIDENCE" : dp.state;
  const confLow = state === "LOW_CONFIDENCE" || conf < 35;
  const driver = mainDriver(
    {
      ...(c || {}),
      upPressure: dispScore(up),
      downPressure: dispScore(down),
      pressureImbalance: imb,
      upTrend,
      downTrend,
    },
    confirm
  );
  const open = ui.preMoveOpen;

  const tfBadges = (pm.windows || PREMOVE_INTERVALS.map((x) => x.sec))
    .map((sec) => {
      const row = windowRow(pm, sec);
      if (!row) return "";
      const bias = tfBias(row);
      const title = `${tfLabel(sec)}\nUp Pressure     ${row.upPressure}\nDown Pressure   ${row.downPressure}\nImbalance      ${signedNum(row.pressureImbalance)}\nState           ${bias}`;
      return `<button type="button" class="tf-badge ${tfBiasClass(bias)} ${Number(sec) === w ? "current" : ""}" data-n="${sec}" title="${title}">
        <em>${tfLabel(sec)}</em><b>${bias}</b>
      </button>`;
    })
    .join("");

  const bt = pm.backtest;
  let btBody = "<div class='fight-hint'>Not enough completed forward windows yet.</div>";
  if (bt?.states) {
    const focus = [
      "STRONG_UPSIDE_PRESSURE",
      "STRONG_DOWNSIDE_PRESSURE",
      "UPSIDE_PRESSURE",
      "DOWNSIDE_PRESSURE",
      "UPSIDE_PRESSURE_BUILDING",
      "DOWNSIDE_PRESSURE_BUILDING",
      "UPSIDE_LIQUIDITY_VACUUM_FORMING",
      "DOWNSIDE_LIQUIDITY_VACUUM_FORMING",
    ];
    const rows = focus
      .map((st) => {
        const rec = bt.states[st]?.[10] || bt.states[st]?.["10"];
        if (!rec?.n) return "";
        return `<tr>
          <td>${prettyState(st)}</td>
          <td>${rec.n}</td>
          <td>${Math.round((rec.hitRate || 0) * 100)}%</td>
          <td>${signedNum(rec.avgReturnBps, 1)}</td>
          <td>${signedNum(rec.medianReturnBps, 1)}</td>
          <td>${(rec.maeBps ?? 0).toFixed(1)}</td>
          <td>${(rec.mfeBps ?? 0).toFixed(1)}</td>
          <td>${Math.round((rec.falsePositive || 0) * 100)}%</td>
        </tr>`;
      })
      .join("");
    if (rows) {
      btBody = `<table class="pm-table">
        <thead><tr><th>State</th><th>n</th><th>Hit</th><th>Avg bps</th><th>Med bps</th><th>MAE</th><th>MFE</th><th>FP</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <div class="fight-hint">10s forward · ${bt.completed || 0} completed · raw engine states</div>`;
    }
  }

  const cal = pm.calibration;
  const calRows = cal
    ? Object.entries(cal.normalized || {})
        .map(
          ([k, v]) =>
            `<tr><td>${featureLabel(k)}</td><td>${Math.round(v)}</td><td>${
              cal.percentiles?.[k] == null ? "—" : Math.round(cal.percentiles[k] * 100) + "th"
            }</td><td>${cal.contributions?.up?.[k] ?? cal.contributions?.down?.[k] ?? "—"}</td></tr>`
        )
        .join("")
    : "";

  return `
    <div class="premove${confLow ? " is-lowconf" : ""}">
      <div class="premove-head">
        <div class="premove-title">Pre-move pressure</div>
        <div class="premove-tf-now">${tfLabel(w)}</div>
        <div class="premove-tfs" id="pm-iv">
          ${PREMOVE_INTERVALS.map((it) => {
            const on = it.sec === w;
            return `<button type="button" data-n="${it.sec}" class="${on ? "active" : ""}">${it.label}</button>`;
          }).join("")}
        </div>
        <div class="premove-conf ${confLow ? "low" : ""}">CONF ${Math.round(conf)}%</div>
      </div>

      <div class="premove-state ${premoveStateClass(state)}">${prettyState(state)}</div>

      <div class="premove-summary">
        <div class="pm-side up">
          <div class="pm-kicker">Up pressure</div>
          <div class="pm-score">${dispScore(up)}</div>
          <div class="pm-meta"><b class="${trendClass(upTrend)}">${prettyState(upTrend)}</b></div>
        </div>
        <div class="pm-side down">
          <div class="pm-kicker">Down pressure</div>
          <div class="pm-score">${dispScore(down)}</div>
          <div class="pm-meta"><b class="${trendClass(downTrend)}">${prettyState(downTrend)}</b></div>
        </div>
        <div class="pm-side imb">
          <div class="pm-kicker">Imbalance</div>
          <div class="pm-score ${imb > 4 ? "up" : imb < -4 ? "down" : ""}">${signedNum(imb)}</div>
          <div class="pm-meta"><span>${tfLabel(w)}</span></div>
        </div>
      </div>

      <div class="premove-driver">
        <div class="pm-kicker">Main driver</div>
        <div class="pm-driver-label">${driver.label}</div>
        <p>${driver.text}</p>
      </div>

      <div class="premove-factors">
        <div class="pm-kicker">Core factors · ${tfLabel(w)}</div>
        <div class="pm-factor-head"><span></span><span>Up</span><span>Down</span></div>
        ${[
          ["Attack", bd.upside.attackPower, bd.downside.attackPower],
          ["Book prep", bd.upside.bookPreparation, bd.downside.bookPreparation],
          ["Defense weak", bd.upside.askDefenseWeakening, bd.downside.bidDefenseWeakening],
        ]
          .map(
            ([label, u, d]) => `<div class="pm-factor">
              <span>${label}</span>
              <div class="pm-factor-val up">${factorBar(u, "up")}</div>
              <div class="pm-factor-val down">${factorBar(d, "down")}</div>
            </div>`
          )
          .join("")}
      </div>

      <div class="premove-mtf">
        <div class="pm-kicker">Timeframe alignment</div>
        <div class="tf-badges">${tfBadges}</div>
        <div class="pm-align-read">
          <span>Short ${bucketBias(pm, [5, 10, 30])}</span>
          <span>Medium ${bucketBias(pm, [60, 300])}</span>
          <span>Longer ${bucketBias(pm, [900])}</span>
          <b>${alignmentSummary(pm)}</b>
        </div>
      </div>

      <div class="premove-drawers">
        <details data-pm="metrics" ${open.metrics ? "open" : ""}>
          <summary>View detailed metrics</summary>
          <div class="pm-rows" style="margin:8px 0">
            <div class="pm-row"><span>Displayed Up (EMA ${PREMOVE_EMA_TAU_SEC}s)</span><b>${dispScore(up)}</b></div>
            <div class="pm-row"><span>Raw Up</span><b>${dispScore(dp.rawUp)}</b></div>
            <div class="pm-row"><span>Displayed Down (EMA ${PREMOVE_EMA_TAU_SEC}s)</span><b>${dispScore(down)}</b></div>
            <div class="pm-row"><span>Raw Down</span><b>${dispScore(dp.rawDown)}</b></div>
            <div class="pm-row"><span>Engine state</span><b>${prettyState(c?.state)}</b></div>
            <div class="pm-row"><span>Display state</span><b>${prettyState(state)}</b></div>
          </div>
          <div class="premove-details">
            <div>
              <div class="pm-break-title">Upside details · ${tfLabel(w)}</div>
              ${metricRows([
                ["Aggressive buy power", f.BuyAggressionPower],
                ["Buy execution velocity", f.BuyExecutionVelocity],
                ["Buy imbalance strength", f.BuyImbalanceStrength],
                ["Large buy activity", f.LargeBuyActivity],
                ["Ask cancellation", f.AskCancellation],
                ["Ask withdrawal", bd.upside.askWithdrawal ?? f.AskWithdrawal],
                ["Ask consumption", bd.upside.askConsumption ?? f.AskConsumption],
                ["Ask depth thinness", f.AskDepthThinness],
                ["Ask replenishment", bd.upside.askReplenishment ?? f.AskReplenishment],
                ["Ask survival", bd.upside.askSurvival ?? f.AskSurvival],
                ["Ask defense weakening", bd.upside.askDefenseWeakening],
                ["Book preparation", bd.upside.bookPreparation],
                ["Raw velocity / 10s", signedNum(c?.upVelocity)],
                ["Raw acceleration", signedNum(c?.upAcceleration)],
                ["Persistence score", `${c?.upPersistence?.persistence ?? "—"}/100`],
                ["Persistence duration", `${c?.upPersistence?.durationSeconds ?? "—"}s`],
              ])}
            </div>
            <div>
              <div class="pm-break-title">Downside details · ${tfLabel(w)}</div>
              ${metricRows([
                ["Aggressive sell power", f.SellAggressionPower],
                ["Sell execution velocity", f.SellExecutionVelocity],
                ["Sell imbalance strength", f.SellImbalanceStrength],
                ["Large sell activity", f.LargeSellActivity],
                ["Bid cancellation", f.BidCancellation],
                ["Bid withdrawal", bd.downside.bidWithdrawal ?? f.BidWithdrawal],
                ["Bid consumption", bd.downside.bidConsumption ?? f.BidConsumption],
                ["Bid depth thinness", f.BidDepthThinness],
                ["Bid replenishment", bd.downside.bidReplenishment ?? f.BidReplenishment],
                ["Bid survival", bd.downside.bidSurvival ?? f.BidSurvival],
                ["Bid defense weakening", bd.downside.bidDefenseWeakening],
                ["Book preparation", bd.downside.bookPreparation],
                ["Raw velocity / 10s", signedNum(c?.downVelocity)],
                ["Raw acceleration", signedNum(c?.downAcceleration)],
                ["Persistence score", `${c?.downPersistence?.persistence ?? "—"}/100`],
                ["Persistence duration", `${c?.downPersistence?.durationSeconds ?? "—"}s`],
              ])}
            </div>
          </div>
          <div class="premove-confirm">
            <span>Price response <b>${prettyState(confirm.state || "PENDING")}</b></span>
            <span>${confirm.why || ""}</span>
            ${
              confirm.displacementBps != null
                ? `<span>${signedNum(confirm.displacementBps, 1)} bps · ${confirm.horizonSec || 0}s</span>`
                : ""
            }
          </div>
        </details>
        <details data-pm="contrib" ${open.contrib ? "open" : ""}>
          <summary>Score contributions</summary>
          <div class="pm-kicker">Raw UpPressure = ${c?.upPressure ?? "—"}</div>
          ${contribBlocks(c?.upContributions)}
          <div class="pm-kicker" style="margin-top:10px">Raw DownPressure = ${c?.downPressure ?? "—"}</div>
          ${contribBlocks(c?.downContributions)}
        </details>
        <details data-pm="backtest" ${open.backtest ? "open" : ""}>
          <summary>Backtest Lab</summary>
          ${btBody}
        </details>
        <details data-pm="calib" ${open.calib ? "open" : ""}>
          <summary>Calibration</summary>
          ${
            calRows
              ? `<div class="fight-hint">${prettyState(cal.regime)} vol · ${tfLabel(cal.window)}</div>
                <table class="pm-table">
                  <thead><tr><th>Feature</th><th>Norm</th><th>Percentile</th><th>Contrib</th></tr></thead>
                  <tbody>${calRows}</tbody>
                </table>`
              : "<div class='fight-hint'>No calibration sample yet.</div>"
          }
        </details>
      </div>
    </div>
  `;
}

function ensureFightShell() {
  const el = $("fight");
  if (el.querySelector("#premove-root") && el.querySelector("#battle-root")) return;
  el.innerHTML = `<div id="premove-root"></div><div id="battle-root"></div>`;
}

function paintPreMove(s) {
  ensureFightShell();
  $("premove-root").innerHTML = renderPreMove(s);
  bindPreMoveButtons();
}

function paintBattle(s) {
  ensureFightShell();
  const px = s.price ?? s.bestBid ?? s.bestAsk;
  const w = ui.interval;
  const tf = INTERVALS.find((it) => it.sec === w)?.label || `${w}s`;
  const pack = s.battlesByWindow?.[w] || s.battlesByWindow?.[String(w)] || null;
  const buy = pack?.buy;
  const sell = pack?.sell;

  if (!buy && !sell) {
    $("battle-root").innerHTML = `
      <div class="fight-card buy"><div class="fight-hint">Waiting for battle engine… restart the server if this persists.</div></div>
      <div class="fight-card sell"><div class="fight-hint">Waiting for battle engine…</div></div>
    `;
    return;
  }

  $("battle-root").innerHTML = `
    ${sidePresenceShape(s, w, px)}
    ${renderBattleCard(buy, px, "buy", "Aggressive buyers", "Passive asks", tf)}
    ${renderBattleCard(sell, px, "sell", "Aggressive sellers", "Passive bids", tf)}
  `;

  const lead = buy?.state || sell?.state;
  if (lead && $("h-state") && !ui.switching) {
    $("h-state").textContent = prettyState(lead);
    $("h-state").className = `state ${stateClass(lead)}`;
  }
}

function renderFight(s) {
  paintPreMove(s);
  paintBattle(s);
}

function bindPreMoveButtons() {
  const pickTf = (n) => {
    if (!n || n === ui.preMoveInterval) return;
    ui.preMoveInterval = n;
    ui.displayPressure = null;
    ui.preMovePaintAt = 0;
    send({ type: "setPreMoveWindow", windowSec: n });
    if (ui.last) renderAll(ui.last, true);
  };
  $("pm-iv")?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => pickTf(Number(btn.dataset.n)));
  });
  document.querySelectorAll(".tf-badge[data-n]").forEach((btn) => {
    btn.addEventListener("click", () => pickTf(Number(btn.dataset.n)));
  });
  document.querySelectorAll(".premove-drawers details[data-pm]").forEach((el) => {
    el.addEventListener("toggle", () => {
      const key = el.dataset.pm;
      if (key && key in ui.preMoveOpen) ui.preMoveOpen[key] = el.open;
    });
  });
}

function renderFooter() {
  $("footer").innerHTML = `
    <div class="note" style="grid-column:1/-1">
      Attack = aggressive trade flow · Defense = passive book behavior · Response = price efficiency + absorption score.
      Pre-move pressure uses book preparation, attack, and defense weakening only — never future price.
      Consumed ≠ Aggressive (aggressive is already executed tape; consumed is resting liquidity removed by trades).
      Surges use rolling percentiles, not raw dollar cutoffs.
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
  ui.displayPressure = null;
  ui.preMovePaintAt = 0;
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
      syncIntervalButtons();
      if (ui.last) paintBattle(ui.last);
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
  ingestDisplayPressure(s);
  renderHeader(s);
  paintBattle(s);
  const now = Date.now();
  if (forcePaint || now - ui.preMovePaintAt >= PREMOVE_PAINT_MS) {
    ui.preMovePaintAt = now;
    paintPreMove(s);
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
    send({ type: "setPreMoveWindow", windowSec: ui.preMoveInterval });
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
