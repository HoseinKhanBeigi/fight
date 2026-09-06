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
  { sec: 1, label: "1s" },
  { sec: 5, label: "5s" },
  { sec: 15, label: "15s" },
  { sec: 30, label: "30s" },
  { sec: 60, label: "1m" },
  { sec: 300, label: "5m" },
  { sec: 900, label: "15m" },
  { sec: 1800, label: "30m" },
  { sec: 2700, label: "45m" },
];

const ui = {
  symbol: "BTCUSDT",
  interval: 5,
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
  const s = String(state).toUpperCase();
  if (s.includes("ABSORPTION")) return "state-absorb";
  if (s.includes("TRUE ASK") || s.includes("ASK PULL") || s.includes("BUYERS") || s.includes("UPSIDE"))
    return "state-buy";
  if (s.includes("TRUE BID") || s.includes("BID PULL") || s.includes("SELLERS") || s.includes("DOWNSIDE"))
    return "state-sell";
  if (s.includes("WALL")) return "state-wall";
  return "state-neutral";
}

function connClass(c) {
  const x = String(c || "").toUpperCase();
  if (x === "LIVE") return "live";
  if (x === "DISCONNECTED") return "disconnected";
  return "reconnecting";
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

  // Don't overwrite the user's selection while a switch is in flight,
  // unless the live feed has caught up to the requested symbol.
  if (s?.symbol) {
    const live = String(s.symbol).toUpperCase();
    if (ui.switching) {
      if (live === ui.symbol) ui.switching = false;
    } else {
      ui.symbol = live;
    }
  }

  const sel = $("sym");
  // Only set select value when dropdown is not open / not focused
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

function battleShare(battle) {
  const attack = Math.min(Number(battle?.attackScore) || 0, 3) / 3;
  const exec = Math.max(0, Math.min(1, Number(battle?.executionRatio) || 0));
  const refill = Math.max(0, Math.min(1, Number(battle?.refillRatio) || 0));
  const force = Math.max(0.05, Math.min(0.95, 0.5 * attack + 0.35 * exec + 0.15 * (1 - refill)));
  return { force, resist: 1 - force };
}

function renderFight(s) {
  const px = s.price ?? s.bestBid ?? s.bestAsk;
  // Prefer volumes for the selected timeframe (incl. 5m); fall back if still warming up
  const w = ui.interval;
  const flow =
    s.flowWindows?.[w] ||
    s.flowWindows?.[60] ||
    s.flowWindows?.[5] ||
    {};
  const liq =
    s.liqWindows?.[w] ||
    s.liqWindows?.[60] ||
    s.liqWindows?.[5] ||
    {};

  const buy = {
    aggressiveVolume: flow.aggressiveBuyVolume ?? s.buyBattle?.aggressiveVolume ?? 0,
    passiveLiquidity: s.askLiquidity ?? s.buyBattle?.passiveLiquidity ?? 0,
    executed: liq.askExec ?? s.buyBattle?.executed ?? 0,
    cancelled: liq.askCancel ?? s.buyBattle?.cancelled ?? 0,
    refill: liq.askRefill ?? s.buyBattle?.refill ?? 0,
    executionRatio:
      (liq.askExec ?? 0) + (liq.askCancel ?? 0) > 0
        ? (liq.askExec ?? 0) / Math.max((liq.askExec ?? 0) + (liq.askCancel ?? 0), 1e-9)
        : s.buyBattle?.executionRatio ?? 0,
    cancellationRatio:
      (liq.askExec ?? 0) + (liq.askCancel ?? 0) > 0
        ? (liq.askCancel ?? 0) / Math.max((liq.askExec ?? 0) + (liq.askCancel ?? 0), 1e-9)
        : s.buyBattle?.cancellationRatio ?? 0,
    refillRatio: s.buyBattle?.refillRatio ?? 0,
    attackScore:
      (flow.aggressiveBuyVolume ?? 0) / Math.max(s.askLiquidity || 0, 1e-9),
    result: s.buyBattle?.result || "NEUTRAL",
  };

  const sell = {
    aggressiveVolume: flow.aggressiveSellVolume ?? s.sellBattle?.aggressiveVolume ?? 0,
    passiveLiquidity: s.bidLiquidity ?? s.sellBattle?.passiveLiquidity ?? 0,
    executed: liq.bidExec ?? s.sellBattle?.executed ?? 0,
    cancelled: liq.bidCancel ?? s.sellBattle?.cancelled ?? 0,
    refill: liq.bidRefill ?? s.sellBattle?.refill ?? 0,
    executionRatio:
      (liq.bidExec ?? 0) + (liq.bidCancel ?? 0) > 0
        ? (liq.bidExec ?? 0) / Math.max((liq.bidExec ?? 0) + (liq.bidCancel ?? 0), 1e-9)
        : s.sellBattle?.executionRatio ?? 0,
    cancellationRatio:
      (liq.bidExec ?? 0) + (liq.bidCancel ?? 0) > 0
        ? (liq.bidCancel ?? 0) / Math.max((liq.bidExec ?? 0) + (liq.bidCancel ?? 0), 1e-9)
        : s.sellBattle?.cancellationRatio ?? 0,
    refillRatio: s.sellBattle?.refillRatio ?? 0,
    attackScore:
      (flow.aggressiveSellVolume ?? 0) / Math.max(s.bidLiquidity || 0, 1e-9),
    result: s.sellBattle?.result || "NEUTRAL",
  };

  const b = battleShare(buy);
  const se = battleShare(sell);
  const tf =
    INTERVALS.find((it) => it.sec === w)?.label ||
    `${w}s`;

  $("fight").innerHTML = `
    <div class="fight-card buy">
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
        <span>Aggressive ${usdLine(buy.aggressiveVolume, px)}</span>
        <span class="pas">Ask liq ${usdLine(buy.passiveLiquidity, px)}</span>
        <span class="exec">Executed ${usdLine(buy.executed, px)}</span>
        <span class="cancel">Cancelled ${usdLine(buy.cancelled, px)}</span>
        <span class="refill">Refilled ${usdLine(buy.refill, px)}</span>
      </div>
      <div class="fight-result ${stateClass(buy.result)}">${buy.result || "NEUTRAL"}</div>
      <div class="fight-hint">Big $ = USDT notional (qty × price). Small number = base coins. Green = attack · Blue = ask resistance.</div>
    </div>
    <div class="fight-card sell">
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
        <span>Aggressive ${usdLine(sell.aggressiveVolume, px)}</span>
        <span class="pas">Bid liq ${usdLine(sell.passiveLiquidity, px)}</span>
        <span class="exec">Executed ${usdLine(sell.executed, px)}</span>
        <span class="cancel">Cancelled ${usdLine(sell.cancelled, px)}</span>
        <span class="refill">Refilled ${usdLine(sell.refill, px)}</span>
      </div>
      <div class="fight-result ${stateClass(sell.result)}">${sell.result || "NEUTRAL"}</div>
      <div class="fight-hint">Big $ = USDT notional (qty × price). Small number = base coins. Red = attack · Blue = bid resistance.</div>
    </div>
  `;
}

function renderFooter() {
  $("footer").innerHTML = `
    <div class="note" style="grid-column:1/-1">
      All $ amounts are USDT (size × price). Cancel / refill ratios are live book estimates.
    </div>
  `;
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
