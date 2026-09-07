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

const ui = {
  symbol: "BTCUSDT",
  interval: 60,
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
 * 2) Whole two-side: (Agg buyers + Passive bids) vs (Agg sellers + Passive asks)
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

  const pair = (agg, pass, kind) => {
    const total = Math.max(agg + pass, 1e-9);
    const aggPct = Math.round((agg / total) * 100);
    const passPct = 100 - aggPct;
    const aggDom = agg >= pass;
    const title = kind === "buy" ? "Buyers → Asks" : "Sellers → Bids";
    const aggLabel = kind === "buy" ? "Aggressive buyers" : "Aggressive sellers";
    const passLabel = kind === "buy" ? "Passive asks" : "Passive bids";
    const verdict =
      kind === "buy"
        ? aggDom
          ? "AGGRESSIVE BUYERS PRESS ASKS"
          : "PASSIVE ASKS OUTWEIGH BUYERS"
        : aggDom
          ? "AGGRESSIVE SELLERS PRESS BIDS"
          : "PASSIVE BIDS OUTWEIGH SELLERS";

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
          ${pair(aggBuy, passAsk, "buy")}
          ${pair(aggSell, passBid, "sell")}
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
      <div class="fight-card buy"><div class="fight-hint">Waiting for battle engine… restart the server if this persists.</div></div>
      <div class="fight-card sell"><div class="fight-hint">Waiting for battle engine…</div></div>
    `;
    return;
  }

  $("fight").innerHTML = `
    ${sidePresenceShape(s, w, px)}
    ${renderBattleCard(buy, px, "buy", "Aggressive buyers", "Passive asks", tf)}
    ${renderBattleCard(sell, px, "sell", "Aggressive sellers", "Passive bids", tf)}
  `;

  // Mirror primary interaction state into header when available
  const lead = buy?.state || sell?.state;
  if (lead && $("h-state") && !ui.switching) {
    $("h-state").textContent = prettyState(lead);
    $("h-state").className = `state ${stateClass(lead)}`;
  }
}

function renderFooter() {
  $("footer").innerHTML = `
    <div class="note" style="grid-column:1/-1">
      Attack = aggressive trade flow · Defense = passive book behavior · Response = price efficiency + absorption score.
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
