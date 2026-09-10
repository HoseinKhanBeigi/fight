/**
 * Cognitive Market Battle UX — display-only.
 * Does not change engine calculations; only presentation / IA.
 */

function clamp(n, lo = 0, hi = 100) {
  const x = Number(n);
  if (!Number.isFinite(x)) return null;
  return Math.max(lo, Math.min(hi, x));
}

function scoreInt(n) {
  const x = clamp(n);
  return x == null ? null : Math.round(x);
}

function pretty(state = "") {
  return String(state || "").replace(/_/g, " ");
}

function money(qty, px) {
  const q = Number(qty);
  const p = Number(px);
  if (!Number.isFinite(q) || !Number.isFinite(p) || p <= 0) return null;
  return q * p;
}

function fmtUsd(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const x = Number(n);
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a < 1) return `${sign}$${a.toFixed(2)}`;
  if (a < 1000) return `${sign}$${a.toFixed(0)}`;
  if (a < 1_000_000) return `${sign}$${(a / 1000).toFixed(a < 10_000 ? 1 : 0)}K`;
  return `${sign}$${(a / 1_000_000).toFixed(2)}M`;
}

function barPct(score) {
  const s = scoreInt(score);
  return s == null ? 0 : s;
}

/** Short response outcome from existing response fields only. */
function responseOutcome(card, isBuy) {
  const r = card?.response || {};
  const eff = Number(r.efficiency);
  const abs = Number(r.absorptionScore);
  const move = Number(r.priceMoveBps);
  if (!Number.isFinite(eff) && !Number.isFinite(abs)) return { label: "NO DATA", kind: "muted" };

  if (Number.isFinite(abs) && abs >= 65 && Number.isFinite(eff) && eff < 45) {
    return {
      label: isBuy ? "SELLER ABSORPTION" : "BUYER ABSORPTION",
      kind: "defense",
    };
  }
  if (Number.isFinite(eff) && eff >= 60 && Number.isFinite(move) && Math.abs(move) >= 1) {
    return {
      label: isBuy ? "UPWARD EFFICIENT" : "DOWNWARD EFFICIENT",
      kind: "attack",
    };
  }
  if (Number.isFinite(eff) && eff < 35) {
    return { label: "WEAK", kind: "amber" };
  }
  if (Number.isFinite(abs) && abs >= 55) {
    return { label: isBuy ? "SELLING ABSORBED" : "BUYING ABSORBED", kind: "defense" };
  }
  if (Number.isFinite(move) && Math.abs(move) < 0.5) {
    return { label: "NO DISPLACEMENT", kind: "muted" };
  }
  return { label: "MIXED", kind: "muted" };
}

function primaryState(card) {
  const st = String(card?.state || "");
  if (!st) return { label: "BALANCED", kind: "muted" };
  if (st.includes("LOW_CONFIDENCE") || st === "STALE" || st === "NO_DATA") {
    return { label: "UNCONFIRMED", kind: "amber" };
  }
  if (st.includes("VACUUM")) return { label: pretty(st), kind: "amber" };
  if (st.includes("WINNING")) return { label: pretty(st), kind: "attack" };
  if (st.includes("DEFENDING")) return { label: pretty(st), kind: "defense" };
  if (st.includes("ABSORPTION")) return { label: pretty(st), kind: "defense" };
  if (st.includes("WITHDRAW")) return { label: pretty(st), kind: "amber" };
  if (st === "BALANCED" || st.includes("NO_MEANINGFUL")) return { label: "BALANCED", kind: "muted" };
  return { label: pretty(st), kind: "muted" };
}

function passiveLiquidityState(card, isBuy) {
  const ps = String(card?.passiveState || "");
  if (ps.includes("WITHDRAW")) return isBuy ? "ASK LIQUIDITY WITHDRAWING" : "BID LIQUIDITY WITHDRAWING";
  if (ps.includes("BUILD")) return isBuy ? "ASK LIQUIDITY BUILDING" : "BID LIQUIDITY BUILDING";
  if (ps.includes("CANCELLATION")) return isBuy ? "ASK CANCELLATION DOMINANT" : "BID CANCELLATION DOMINANT";
  if (ps.includes("REPLENISH")) return isBuy ? "ASK REPLENISHMENT DOMINANT" : "BID REPLENISHMENT DOMINANT";
  if (ps.includes("STABLE") || ps.includes("SURVIVING")) return isBuy ? "ASK LIQUIDITY STABLE" : "BIDS HOLDING";
  if (ps === "LOW_CONFIDENCE" || ps === "STALE" || ps === "NO_DATA") return pretty(ps) || "NO DATA";
  return pretty(ps) || (isBuy ? "ASK LIQUIDITY STABLE" : "BIDS HOLDING");
}

function netChangeUsd(d, px) {
  if (d?.behavioralNetChange != null && Number.isFinite(Number(d.behavioralNetChange))) {
    return money(d.behavioralNetChange, px);
  }
  const cancelled = Number(d?.cancelled);
  const replenished = Number(d?.replenished);
  const consumed = Number(d?.consumed);
  const stacked = Number(d?.stacked);
  if (
    Number.isFinite(stacked) &&
    stacked > 0 &&
    Number.isFinite(cancelled) &&
    Number.isFinite(replenished) &&
    Number.isFinite(consumed)
  ) {
    return money(stacked + replenished - cancelled - consumed, px);
  }
  if (Number.isFinite(cancelled) && Number.isFinite(replenished)) {
    return money(replenished - cancelled, px);
  }
  return null;
}

function confidenceFromCards(buy, sell) {
  const states = [buy?.state, sell?.state, buy?.passiveState, sell?.passiveState].map(String);
  if (states.some((s) => s.includes("NO_DATA"))) return { pct: 20, label: "LOW", low: true };
  if (states.some((s) => s.includes("STALE"))) return { pct: 35, label: "LOW", low: true };
  if (states.some((s) => s.includes("LOW_CONFIDENCE"))) return { pct: 40, label: "LOW", low: true };

  const aq = buy?.attack?.dataQuality || sell?.attack?.dataQuality;
  const dq = buy?.defense?.dataQuality || sell?.defense?.dataQuality;
  if (aq === "NO_DATA" || dq === "NO_DATA") return { pct: 25, label: "LOW", low: true };
  if (aq === "STALE" || dq === "STALE") return { pct: 40, label: "LOW", low: true };
  if (aq === "LOW_CONFIDENCE" || dq === "LOW_CONFIDENCE") return { pct: 45, label: "LOW", low: true };

  const fields = [buy?.attack?.power, sell?.attack?.power, buy?.defense?.power, sell?.defense?.power];
  const ok = fields.filter((x) => Number.isFinite(Number(x))).length;
  const pct = Math.round(55 + (ok / 4) * 40);
  return { pct, label: pct >= 80 ? "HIGH" : pct >= 60 ? "MED" : "LOW", low: pct < 55 };
}

function dominantMechanic(buy, sell) {
  const bits = [];
  const ba = scoreInt(buy?.attack?.power) || 0;
  const bd = scoreInt(buy?.defense?.power) || 0;
  const sa = scoreInt(sell?.attack?.power) || 0;
  const sd = scoreInt(sell?.defense?.power) || 0;
  if (sa >= ba + 8) bits.push("SELL AGGRESSION");
  else if (ba >= sa + 8) bits.push("BUY AGGRESSION");
  if (bd >= sd + 8) bits.push("ASK DEFENSE");
  else if (sd >= bd + 8) bits.push("BID DEFENSE");
  if (!bits.length) {
    if ((buy?.state || "").includes("WITHDRAW")) bits.push("ASK WITHDRAWAL");
    if ((sell?.state || "").includes("WITHDRAW")) bits.push("BID WITHDRAWAL");
  }
  return bits.length ? bits.join(" + ") : "BALANCED PRESSURE";
}

export function createBattleUxState() {
  return {
    controlLabel: null,
    controlLabelAt: 0,
    upState: null,
    upStateAt: 0,
    downState: null,
    downStateAt: 0,
    emaBuy: null,
    emaSell: null,
  };
}

function stickyLabel(prev, prevAt, next, now, holdMs) {
  if (!prev) return { label: next, at: now };
  if (prev === next) return { label: next, at: now };
  if (now - prevAt < holdMs) return { label: prev, at: prevAt };
  return { label: next, at: now };
}

function ema(prev, next, alpha = 0.35) {
  if (next == null || !Number.isFinite(next)) return prev;
  if (prev == null || !Number.isFinite(prev)) return next;
  return prev * (1 - alpha) + next * alpha;
}

function sharePair(buyRaw, sellRaw, ux) {
  let b = Number(buyRaw);
  let s = Number(sellRaw);
  if (!Number.isFinite(b)) b = 0;
  if (!Number.isFinite(s)) s = 0;
  ux.emaBuy = ema(ux.emaBuy, b);
  ux.emaSell = ema(ux.emaSell, s);
  b = ux.emaBuy;
  s = ux.emaSell;
  const tot = Math.max(b + s, 1e-9);
  const buyShare = Math.round((b / tot) * 100);
  const sellShare = 100 - buyShare;
  return { buyShare, sellShare, gap: buyShare - sellShare };
}

function controlLeadLabel(gap, lowConf) {
  if (lowConf) return "UNCONFIRMED";
  if (Math.abs(gap) < 6) return "BALANCED";
  return gap > 0 ? "BUYERS LEAD" : "SELLERS LEAD";
}

function scoreBar(label, score, tone) {
  const s = scoreInt(score);
  const w = s == null ? 0 : s;
  const show = s == null ? "—" : String(s);
  return `
    <div class="bx-scoreline">
      <span class="bx-scoreline-lab">${label}</span>
      <div class="bx-track" aria-hidden="true"><i class="${tone}" style="width:${w}%"></i></div>
      <b class="bx-scoreline-num">${show}</b>
    </div>`;
}

function moneyRow(label, usd) {
  return `
    <div class="bx-money-row">
      <span>${label}</span>
      <b>${usd == null ? "—" : fmtUsd(usd)}</b>
    </div>`;
}

function activityBar(label, usd, maxUsd, tone) {
  const u = usd == null ? 0 : Math.max(0, usd);
  const pct = maxUsd > 0 ? Math.round((u / maxUsd) * 100) : 0;
  return `
    <div class="bx-act-row">
      <span>${label}</span>
      <div class="bx-track"><i class="${tone}" style="width:${pct}%"></i></div>
      <b>${usd == null ? "—" : fmtUsd(usd)}</b>
    </div>`;
}

function renderMarketControl(buy, sell, conf, ux, now) {
  const buyP = buy?.attack?.power;
  const sellP = sell?.attack?.power;
  const { buyShare, sellShare, gap } = sharePair(buyP ?? 50, sellP ?? 50, ux);
  const rawLead = controlLeadLabel(gap, conf.low);
  const sticky = stickyLabel(ux.controlLabel, ux.controlLabelAt, rawLead, now, conf.low ? 4000 : 2800);
  ux.controlLabel = sticky.label;
  ux.controlLabelAt = sticky.at;

  const leadClass =
    sticky.label.includes("BUYERS") ? "buy" : sticky.label.includes("SELLERS") ? "sell" : "flat";

  return `
    <section class="bx-control${conf.low ? " is-lowconf" : ""}" aria-label="Market control">
      <header class="bx-control-head">
        <h2>MARKET CONTROL</h2>
        <span class="bx-conf ${conf.low ? "low" : ""}">CONF ${conf.pct}%</span>
      </header>
      <div class="bx-control-scores">
        <div class="bx-pole buy">
          <span>BUYERS</span>
          <b>${buyShare}</b>
        </div>
        <div class="bx-pole sell">
          <span>SELLERS</span>
          <b>${sellShare}</b>
        </div>
      </div>
      <div class="bx-control-bar" aria-hidden="true">
        <i class="buy" style="width:${buyShare}%"></i>
        <i class="sell" style="width:${sellShare}%"></i>
      </div>
      <div class="bx-control-lead ${leadClass}">
        <strong>${sticky.label}</strong>
        <span>Control Gap ${gap > 0 ? "+" : ""}${gap}</span>
      </div>
      <div class="bx-control-mech">Dominant Mechanic · ${dominantMechanic(buy, sell)}</div>
    </section>`;
}

function renderCompareStrip(buy, sell, px) {
  const ba = scoreInt(buy?.attack?.power);
  const bd = scoreInt(buy?.defense?.power);
  const sa = scoreInt(sell?.attack?.power);
  const sd = scoreInt(sell?.defense?.power);
  const bs = Number(buy?.battleSpread);
  const ss = Number(sell?.battleSpread);
  const ask = money(buy?.defense?.currentLiquidity, px);
  const bid = money(sell?.defense?.currentLiquidity, px);
  const askC = money(buy?.defense?.cancelled, px);
  const bidC = money(sell?.defense?.cancelled, px);
  const askR = money(buy?.defense?.replenished, px);
  const bidR = money(sell?.defense?.replenished, px);

  const cell = (v) => (v == null || !Number.isFinite(v) ? "—" : String(v));
  const cellUsd = (v) => (v == null ? "—" : fmtUsd(v));
  const cellSpr = (v) => (!Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${Math.round(v)}`);

  return `
    <section class="bx-compare" aria-label="Upside versus downside comparison">
      <div class="bx-compare-head"><span></span><span>UPSIDE</span><span>DOWNSIDE</span></div>
      <div class="bx-compare-row"><span>Attack</span><b class="buy">${cell(ba)}</b><b class="sell">${cell(sa)}</b></div>
      <div class="bx-compare-row"><span>Defense</span><b class="pas">${cell(bd)}</b><b class="pas">${cell(sd)}</b></div>
      <div class="bx-compare-row strong"><span>Spread</span><b>${cellSpr(bs)}</b><b>${cellSpr(ss)}</b></div>
      <div class="bx-compare-row"><span>Current Liq</span><b>${cellUsd(ask)}</b><b>${cellUsd(bid)}</b></div>
      <div class="bx-compare-row muted"><span>Cancelled</span><b>${cellUsd(askC)}</b><b>${cellUsd(bidC)}</b></div>
      <div class="bx-compare-row muted"><span>Refill</span><b>${cellUsd(askR)}</b><b>${cellUsd(bidR)}</b></div>
    </section>`;
}

function renderBattleCardUX(card, px, isBuy, tf, multiVenue, ux, now) {
  const side = isBuy ? "buy" : "sell";
  const a = card?.attack || {};
  const d = card?.defense || {};
  const r = card?.response || {};
  const attack = a.power;
  const defense = d.power;
  const spread = Number(card?.battleSpread);
  const atkUsd = money(a.aggressiveVolume, px);
  const defUsd = money(d.currentLiquidity, px);
  const allUsd = isBuy ? multiVenue?.total?.askUsd : multiVenue?.total?.bidUsd;
  const consumed = money(d.consumed, px);
  const cancelled = money(d.cancelled, px);
  const refilled = money(d.replenished, px);
  const net = netChangeUsd(d, px);
  const actMax = Math.max(consumed || 0, cancelled || 0, refilled || 0, 1);

  const rawState = primaryState(card);
  const key = isBuy ? "upState" : "downState";
  const atKey = isBuy ? "upStateAt" : "downStateAt";
  const sticky = stickyLabel(ux[key], ux[atKey], rawState.label, now, 3000);
  ux[key] = sticky.label;
  ux[atKey] = sticky.at;

  const spreadLead =
    !Number.isFinite(spread) || Math.abs(spread) < 4
      ? "BALANCED"
      : spread > 0
        ? "ATTACK GAINING CONTROL"
        : "DEFENSE DOMINANT";

  const resp = responseOutcome(card, isBuy);
  const pasState = passiveLiquidityState(card, isBuy);
  const low =
    sticky.label === "UNCONFIRMED" || String(card?.state || "").includes("LOW_CONFIDENCE");

  const title = isBuy ? "UPSIDE BATTLE" : "DOWNSIDE BATTLE";
  const flow = isBuy
    ? "Aggressive Buyers → Passive Sellers"
    : "Aggressive Sellers → Passive Buyers";
  const atkName = isBuy ? "Aggressive Buy" : "Aggressive Sell";
  const defName = isBuy ? "Ask Defense" : "Bid Defense";
  const pasTitle = isBuy ? "PASSIVE ASKS" : "PASSIVE BIDS";

  const evidence = (card?.evidence || [])
    .map((e) => `<li><span>${e.k}</span><b>${e.v}</b></li>`)
    .join("");

  const depthPct =
    defUsd != null ? Math.min(100, Math.round(40 + Math.min(defUsd / 5_000_000, 1) * 55)) : 50;

  const details = `
    <div class="bx-detail-grid">
      ${scoreBar("Attack power", attack, side)}
      ${scoreBar("Defense power", defense, "pas")}
      <div class="bx-money-row muted"><span>Attack percentile</span><b>${a.percentile != null ? Math.round(Number(a.percentile) * (Number(a.percentile) <= 1 ? 100 : 1)) + "th" : "—"}</b></div>
      <div class="bx-money-row muted"><span>Cancel band</span><b>${d.cancelBand || "—"}</b></div>
      <div class="bx-money-row muted"><span>Refill band</span><b>${d.refillBand || "—"}</b></div>
      <div class="bx-money-row muted"><span>Absorption score</span><b>${r.absorptionScore == null ? "—" : Math.round(Number(r.absorptionScore))}</b></div>
      <div class="bx-money-row muted"><span>Price efficiency</span><b>${r.efficiency == null ? "—" : Math.round(Number(r.efficiency))}</b></div>
      <div class="bx-money-row muted"><span>Price move</span><b>${r.priceMoveBps == null ? "—" : Number(r.priceMoveBps).toFixed(1) + " bps"}</b></div>
      <div class="bx-money-row muted"><span>Absorbed (est.)</span><b>${r.estimatedAbsorbedFlow == null ? "—" : fmtUsd(money(r.estimatedAbsorbedFlow, px))}</b></div>
      <div class="bx-money-row muted"><span>All-venue depth</span><b>${allUsd == null ? "—" : fmtUsd(allUsd)}</b></div>
      <div class="bx-money-row muted"><span>Data quality</span><b>${a.dataQuality || d.dataQuality || "—"}</b></div>
    </div>
    ${card?.why ? `<p class="bx-why">${card.why}</p>` : ""}
    ${evidence ? `<ul class="bx-evidence">${evidence}</ul>` : ""}
  `;

  return `
    <article class="bx-card ${side}${low ? " is-lowconf" : ""}">
      <header class="bx-card-head">
        <div>
          <h3>${title}</h3>
          <p>${flow} · ${tf}</p>
        </div>
        <div class="bx-state-badge ${rawState.kind}">${sticky.label}</div>
      </header>

      <div class="bx-ad">
        <div class="bx-ad-col attack">
          <span class="bx-ad-k">ATTACK</span>
          <b class="bx-ad-v">${scoreInt(attack) ?? "—"}</b>
          <span class="bx-ad-sub">${atkName}</span>
          <span class="bx-ad-money">${atkUsd == null ? "—" : fmtUsd(atkUsd)} executed</span>
        </div>
        <div class="bx-ad-col defense">
          <span class="bx-ad-k">DEFENSE</span>
          <b class="bx-ad-v">${scoreInt(defense) ?? "—"}</b>
          <span class="bx-ad-sub">${defName}</span>
          <span class="bx-ad-money">${defUsd == null ? "—" : fmtUsd(defUsd)} current</span>
        </div>
      </div>

      <div class="bx-dualbar" aria-hidden="true">
        <div class="bx-dualbar-row">
          <span>ATK</span>
          <div class="bx-track"><i class="${side}" style="width:${barPct(attack)}%"></i></div>
        </div>
        <div class="bx-dualbar-row">
          <span>DEF</span>
          <div class="bx-track"><i class="pas" style="width:${barPct(defense)}%"></i></div>
        </div>
      </div>

      <div class="bx-spread ${!Number.isFinite(spread) ? "" : spread >= 0 ? "pos" : "neg"}">
        <span>BATTLE SPREAD</span>
        <b>${!Number.isFinite(spread) ? "—" : (spread > 0 ? "+" : "") + Math.round(spread)}</b>
        <em>${spreadLead}</em>
      </div>

      <section class="bx-passive">
        <h4>${pasTitle}</h4>
        <div class="bx-depth">
          <span>CURRENT DEPTH</span>
          <div class="bx-track tall"><i class="pas" style="width:${depthPct}%"></i></div>
          <b>${defUsd == null ? "—" : fmtUsd(defUsd)}</b>
        </div>
        <div class="bx-activity-label">${tf} ACTIVITY</div>
        ${activityBar("Consumed", consumed, actMax, "cons")}
        ${activityBar("Cancelled", cancelled, actMax, "cancel")}
        ${activityBar("Refilled", refilled, actMax, "refill")}
        ${moneyRow("Net Change", net)}
        <div class="bx-pas-state">${pasState}</div>
      </section>

      <div class="bx-response ${resp.kind}">
        <span>PRICE RESPONSE</span>
        <b>${resp.label}</b>
      </div>

      <details class="bx-details">
        <summary>Details</summary>
        ${details}
      </details>
    </article>`;
}

/**
 * Full Market Battle UX block (control + compare + dual cards).
 */
export function renderMarketBattleUX(s, opts) {
  const px = s.price ?? s.bestBid ?? s.bestAsk;
  const w = opts.interval;
  const pack = s.battlesByWindow?.[w] || s.battlesByWindow?.[String(w)] || {};
  const buy = pack.buy || null;
  const sell = pack.sell || null;
  const ux = opts.ux || createBattleUxState();
  const now = Date.now();
  const conf = confidenceFromCards(buy, sell);
  const tf = opts.tf || `${w}s`;

  if (!buy && !sell) {
    return `<div class="bx-wait">Waiting for battle engine…</div>`;
  }

  return `
    <div class="bx-root">
      ${renderMarketControl(buy, sell, conf, ux, now)}
      ${renderCompareStrip(buy, sell, px)}
      <div class="bx-dual">
        ${renderBattleCardUX(buy, px, true, tf, s.multiVenue, ux, now)}
        ${renderBattleCardUX(sell, px, false, tf, s.multiVenue, ux, now)}
      </div>
      ${
        s.multiVenue
          ? `<details class="bx-venues"><summary>All-venue liquidity</summary>
              <div class="bx-venues-body">
                Σ Ask ${fmtUsd(s.multiVenue.total?.askUsd)} · Σ Bid ${fmtUsd(s.multiVenue.total?.bidUsd)} · ${s.multiVenue.total?.venuesLive || 0} live
              </div>
            </details>`
          : ""
      }
    </div>`;
}
