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

const ui = {
  symbol: "BTCUSDT",
  interval: 60,
  preMoveInterval: 10,
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
  if (s.includes("LOW_CONFIDENCE") || s === "NO_PRESSURE" || s === "BALANCED") return "low";
  if (s.includes("TRANSIENT") || s.includes("COMPRESSION") || s.includes("TWO_SIDED")) return "warn";
  if (s.includes("DOWNSIDE") || s.includes("LOWER") || s.includes("DOWN_PRESSURE")) return "down";
  if (s.includes("UPSIDE") || s.includes("UPPER") || s.includes("UP_PRESSURE")) return "up";
  return "low";
}

function tfLabel(sec) {
  return PREMOVE_INTERVALS.find((it) => it.sec === Number(sec))?.label || `${sec}s`;
}

function sparkline(history) {
  const rows = history || [];
  if (rows.length < 2) {
    return `<svg class="premove-spark" viewBox="0 0 240 56" preserveAspectRatio="none"></svg>`;
  }
  const w = 240;
  const h = 56;
  const n = rows.length;
  const path = (key, color) => {
    const pts = rows
      .map((r, i) => {
        const x = (i / (n - 1)) * w;
        const y = h - (Math.max(0, Math.min(100, Number(r[key]) || 0)) / 100) * (h - 6) - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return `<polyline fill="none" stroke="${color}" stroke-width="1.4" points="${pts}" />`;
  };
  return `<svg class="premove-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="Pressure history">
    ${path("down", "var(--sell)")}
    ${path("up", "var(--buy)")}
  </svg>`;
}

function contribLine(contrib, keys) {
  if (!contrib) return "";
  const items = (keys || Object.keys(contrib))
    .map((k) => {
      const v = contrib[k];
      if (v == null) return "";
      const cls = v >= 0 ? "pos" : "neg";
      return `<span>${k.replace(/([A-Z])/g, " $1").trim()} <b class="${cls}">${signedNum(v, 1)}</b></span>`;
    })
    .filter(Boolean);
  return `<div class="premove-contrib">${items.join("")}</div>`;
}

function breakRows(pairs) {
  return `<div class="pm-rows">${pairs
    .map(([k, v]) => `<div class="pm-row"><span>${k}</span><b>${fmtScore(v)}</b></div>`)
    .join("")}</div>`;
}

function renderPreMove(s) {
  const pm = s.preMove;
  if (!pm?.current) {
    return `<div class="premove"><div class="premove-title">Pre-move pressure</div><div class="fight-hint">Waiting for pre-move engine…</div></div>`;
  }
  const c = pm.current;
  const w = ui.preMoveInterval;
  const slice = pm.byWindow?.[w] || pm.byWindow?.[String(w)] || c;
  const confLow = (c.confidence ?? 100) < 40;
  const imb = slice.pressureImbalance ?? c.pressureImbalance ?? 0;
  const imbPct = Math.max(0, Math.min(50, Math.abs(imb) / 2));
  const bd = c.breakdown || { upside: {}, downside: {} };
  const confirm = pm.confirmation || {};
  const align = pm.alignment || {};
  const why = (c.why || []).map((line) => `<li>${line}</li>`).join("");

  const tfChips = (pm.windows || PREMOVE_INTERVALS.map((x) => x.sec))
    .map((sec) => {
      const row = pm.byWindow?.[sec] || pm.byWindow?.[String(sec)];
      if (!row) return "";
      const d = (row.upPressure || 0) - (row.downPressure || 0);
      const cls = d >= 10 ? "up" : d <= -10 ? "down" : "";
      return `<span class="tf-chip ${cls}">${tfLabel(sec)} ${d >= 10 ? "UP" : d <= -10 ? "DN" : "—"} ${row.upPressure}/${row.downPressure}</span>`;
    })
    .join("");

  const bt = pm.backtest;
  let btHtml = "";
  if (bt?.states) {
    const focus = [
      "STRONG_UPSIDE_PRESSURE",
      "STRONG_DOWNSIDE_PRESSURE",
      "UPSIDE_PRESSURE_BUILDING",
      "DOWNSIDE_PRESSURE_BUILDING",
      "UPSIDE_LIQUIDITY_VACUUM_FORMING",
      "DOWNSIDE_LIQUIDITY_VACUUM_FORMING",
    ];
    const h = 10;
    const rows = focus
      .map((st) => {
        const rec = bt.states[st]?.[h] || bt.states[st]?.["10"];
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
    btHtml = rows
      ? `<details>
        <summary>Backtest lab · 10s forward (completed ${bt.completed || 0})</summary>
        <table class="pm-table">
          <thead><tr><th>State</th><th>n</th><th>Hit</th><th>Avg bps</th><th>Med bps</th><th>MAE</th><th>MFE</th><th>FP</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </details>`
      : "";
  }

  const cal = pm.calibration;
  const calRows = cal
    ? Object.entries(cal.normalized || {})
        .map(
          ([k, v]) =>
            `<tr><td>${k}</td><td>${Math.round(v)}</td><td>${
              cal.percentiles?.[k] == null ? "—" : Math.round(cal.percentiles[k] * 100) + "th"
            }</td><td>${cal.contributions?.up?.[k] ?? cal.contributions?.down?.[k] ?? "—"}</td></tr>`
        )
        .join("")
    : "";

  return `
    <div class="premove">
      <div class="premove-head">
        <div class="premove-title">Pre-move pressure</div>
        <div class="premove-state ${premoveStateClass(c.state)}">${prettyState(c.state)}</div>
        <div class="premove-tfs" id="pm-iv">
          ${PREMOVE_INTERVALS.map(
            (it) =>
              `<button type="button" data-n="${it.sec}" class="${
                it.sec === w ? "active" : ""
              }">${it.label}</button>`
          ).join("")}
        </div>
        <div class="premove-conf ${confLow ? "low" : ""}">
          Confidence ${fmtScore(c.confidence)}${confLow ? " · LOW CONFIDENCE" : ""}
        </div>
      </div>
      <div class="premove-grid">
        <div class="premove-col up">
          <div class="pm-kicker">Up pressure</div>
          <div class="pm-score">${slice.upPressure ?? "—"} <small>/ 100</small></div>
          <div class="pm-bar"><i style="width:${clampScore(slice.upPressure)}%"></i></div>
          <div class="pm-rows">
            <div class="pm-row"><span>Trend</span><b class="${trendClass(slice.upTrend)}">${prettyState(slice.upTrend || c.upTrend)}</b></div>
            <div class="pm-row"><span>Velocity</span><b class="${trendClass(slice.upTrend)}">${signedNum(slice.upVelocity)} / ${c.velocityLookbackSec || 10}s</b></div>
            <div class="pm-row"><span>Acceleration</span><b>${signedNum(c.upAcceleration)}</b></div>
            <div class="pm-row"><span>Persistence</span><b>${fmtScore(c.upPersistence?.persistence)} · ${prettyState(c.upPersistence?.label)}</b></div>
          </div>
        </div>
        <div class="premove-col down">
          <div class="pm-kicker">Down pressure</div>
          <div class="pm-score">${slice.downPressure ?? "—"} <small>/ 100</small></div>
          <div class="pm-bar"><i style="width:${clampScore(slice.downPressure)}%"></i></div>
          <div class="pm-rows">
            <div class="pm-row"><span>Trend</span><b class="${trendClass(slice.downTrend)}">${prettyState(slice.downTrend || c.downTrend)}</b></div>
            <div class="pm-row"><span>Velocity</span><b class="${trendClass(slice.downTrend)}">${signedNum(slice.downVelocity)} / ${c.velocityLookbackSec || 10}s</b></div>
            <div class="pm-row"><span>Acceleration</span><b>${signedNum(c.downAcceleration)}</b></div>
            <div class="pm-row"><span>Persistence</span><b>${fmtScore(c.downPersistence?.persistence)} · ${prettyState(c.downPersistence?.label)}</b></div>
          </div>
        </div>
        <div class="premove-imb">
          <div class="pm-kicker">Pressure imbalance</div>
          <div class="imb-val ${imb > 4 ? "up" : imb < -4 ? "down" : ""}">${signedNum(imb)}</div>
          <div class="imb-track">
            <span class="mid"></span>
            ${
              imb >= 0
                ? `<i class="up" style="width:${imbPct}%"></i>`
                : `<i class="down" style="width:${imbPct}%"></i>`
            }
          </div>
          <div class="pm-row"><span>Norm</span><b>${signedNum((c.normalizedImbalance || 0) * 100, 0)}%</b></div>
          <div class="pm-row"><span>Align</span><b>${align.score ?? "—"}/100</b></div>
        </div>
      </div>
      <div class="premove-align">
        <span>${prettyState(align.label || "MIXED")}</span>
        ${tfChips}
      </div>
      ${sparkline(pm.history)}
      <div class="premove-break">
        <div>
          <div class="pm-break-title">Upside</div>
          ${breakRows([
            ["Attack power", bd.upside.attackPower],
            ["Book preparation", bd.upside.bookPreparation],
            ["Ask defense weakening", bd.upside.askDefenseWeakening],
            ["Ask consumption", bd.upside.askConsumption],
            ["Ask withdrawal", bd.upside.askWithdrawal],
            ["Ask replenishment", bd.upside.askReplenishment],
            ["Ask survival", bd.upside.askSurvival],
          ])}
          ${contribLine(c.upContributions, [
            "BuyAggressionPower",
            "BuyExecutionVelocity",
            "AskCancellation",
            "AskWithdrawal",
            "AskConsumption",
            "AskDepthThinness",
            "AskReplenishment",
            "AskSurvival",
          ])}
        </div>
        <div>
          <div class="pm-break-title">Downside</div>
          ${breakRows([
            ["Attack power", bd.downside.attackPower],
            ["Book preparation", bd.downside.bookPreparation],
            ["Bid defense weakening", bd.downside.bidDefenseWeakening],
            ["Bid consumption", bd.downside.bidConsumption],
            ["Bid withdrawal", bd.downside.bidWithdrawal],
            ["Bid replenishment", bd.downside.bidReplenishment],
            ["Bid survival", bd.downside.bidSurvival],
          ])}
          ${contribLine(c.downContributions, [
            "SellAggressionPower",
            "SellExecutionVelocity",
            "BidCancellation",
            "BidWithdrawal",
            "BidConsumption",
            "BidDepthThinness",
            "BidReplenishment",
            "BidSurvival",
          ])}
        </div>
      </div>
      <div class="premove-why">
        <div class="pm-kicker">Why</div>
        <ul>${why || "<li>Waiting for enough history to explain this state.</li>"}</ul>
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
      ${btHtml}
      ${
        calRows
          ? `<details>
          <summary>Calibration · ${prettyState(cal.regime)} vol · window ${tfLabel(cal.window)}</summary>
          <table class="pm-table">
            <thead><tr><th>Feature</th><th>Norm</th><th>Percentile</th><th>Contrib</th></tr></thead>
            <tbody>${calRows}</tbody>
          </table>
        </details>`
          : ""
      }
    </div>
  `;
}

function renderFight(s) {
  const px = s.price ?? s.bestBid ?? s.bestAsk;
  const w = ui.interval;
  const tf = INTERVALS.find((it) => it.sec === w)?.label || `${w}s`;
  const pack = s.battlesByWindow?.[w] || s.battlesByWindow?.[String(w)] || null;
  const buy = pack?.buy;
  const sell = pack?.sell;

  // Prefer battle-engine cards; fallback message if server not yet upgraded
  if (!buy && !sell) {
    $("fight").innerHTML = `
      ${renderPreMove(s)}
      <div class="fight-card buy"><div class="fight-hint">Waiting for battle engine… restart the server if this persists.</div></div>
      <div class="fight-card sell"><div class="fight-hint">Waiting for battle engine…</div></div>
    `;
    bindPreMoveButtons();
    return;
  }

  $("fight").innerHTML = `
    ${renderPreMove(s)}
    ${sidePresenceShape(s, w, px)}
    ${renderBattleCard(buy, px, "buy", "Aggressive buyers", "Passive asks", tf)}
    ${renderBattleCard(sell, px, "sell", "Aggressive sellers", "Passive bids", tf)}
  `;
  bindPreMoveButtons();

  // Mirror primary interaction state into header when available
  const lead = buy?.state || sell?.state;
  if (lead && $("h-state") && !ui.switching) {
    $("h-state").textContent = prettyState(lead);
    $("h-state").className = `state ${stateClass(lead)}`;
  }
}

function bindPreMoveButtons() {
  $("pm-iv")?.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const n = Number(btn.dataset.n);
      if (!n || n === ui.preMoveInterval) return;
      ui.preMoveInterval = n;
      send({ type: "setPreMoveWindow", windowSec: n });
      if (ui.last) renderFight(ui.last);
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
      if (ui.last) renderFight(ui.last);
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

function renderAll(s) {
  ui.last = s;
  renderHeader(s);
  renderFight(s);
  renderFooter();
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
