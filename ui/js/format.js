/** Formatting helpers for the live dashboard. */

export function fmt(n, d = 3) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const a = Math.abs(x);
  if (a >= 1000) return x.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (a >= 100) return x.toFixed(2);
  if (a >= 1) return x.toFixed(d);
  if (a >= 0.01) return x.toFixed(4);
  return x.toFixed(6);
}

export function fmtPrice(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 2,
  });
}

export function pct(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${(Number(n) * 100).toFixed(0)}%`;
}

export function signed(n, d = 3) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const x = Number(n);
  const s = fmt(x, d);
  return x > 0 ? `+${s}` : s;
}

export function clock(tsSec) {
  if (!tsSec) return "—";
  const d = new Date(tsSec > 1e12 ? tsSec : tsSec * 1000);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

export function clamp01(n) {
  if (n == null || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export function stateClass(state = "") {
  const s = String(state).toUpperCase();
  if (s.includes("ASK ABSORPTION") || s.includes("BID ABSORPTION")) return "state-absorb";
  if (s.includes("TRUE ASK SWEEP") || s.includes("ASK PULLED") || s.includes("UPSIDE"))
    return "state-ask-sweep";
  if (s.includes("TRUE BID SWEEP") || s.includes("BID PULLED") || s.includes("DOWNSIDE"))
    return "state-bid-sweep";
  if (s.includes("WALL")) return "state-wall";
  if (s.includes("BUYERS") || s.includes("ASK STACK") || s.includes("ASK CANCEL"))
    return "state-buy";
  if (s.includes("SELLERS") || s.includes("BID STACK") || s.includes("BID CANCEL"))
    return "state-sell";
  return "state-neutral";
}

export function explainState(s) {
  if (!s) return "Waiting for live market structure.";
  const buy = s.buyBattle || {};
  const sell = s.sellBattle || {};
  const state = s.state || "NEUTRAL";
  const liq = s.liqWindows?.[s._window || 5] || s.liqWindows?.[5] || {};

  if (state.includes("ASK ABSORPTION")) {
    return `Aggressive buy volume is elevated (attack ${fmt(buy.attackScore, 2)}), but asks continue refilling (${pct(buy.refillRatio)}) and price response is limited (${signed(s.priceChangeTicks5s, 1)} ticks).`;
  }
  if (state.includes("BID ABSORPTION")) {
    return `Aggressive sell volume is elevated (attack ${fmt(sell.attackScore, 2)}), but bids continue refilling (${pct(sell.refillRatio)}) and downside response is limited.`;
  }
  if (state.includes("TRUE ASK SWEEP")) {
    return `Ask liquidity was largely executed (${pct(buy.executionRatio)} execution vs ${pct(buy.cancellationRatio)} estimated cancel) with upside price response.`;
  }
  if (state.includes("TRUE BID SWEEP")) {
    return `Bid liquidity was largely executed (${pct(sell.executionRatio)} execution vs ${pct(sell.cancellationRatio)} estimated cancel) with downside price response.`;
  }
  if (state.includes("ASK WALL PULLED") || state.includes("ASK PULLED")) {
    const w = s.largestAskWall;
    const cr = w ? pct(w.cancelRatio) : pct(buy.cancellationRatio);
    return `${cr} of ask-side disappearance is inferred cancellation rather than confirmed aggressive execution.`;
  }
  if (state.includes("BID WALL PULLED") || state.includes("BID PULLED")) {
    const w = s.largestBidWall;
    const cr = w ? pct(w.cancelRatio) : pct(sell.cancellationRatio);
    return `${cr} of bid-side disappearance is inferred cancellation rather than confirmed aggressive execution.`;
  }
  if (state.includes("ASK CANCELLATION")) {
    return `Estimated ask cancellations dominate near-book removals (cancel ratio ${pct(liq.askCancelRatio)}).`;
  }
  if (state.includes("BID CANCELLATION")) {
    return `Estimated bid cancellations dominate near-book removals (cancel ratio ${pct(liq.bidCancelRatio)}).`;
  }
  if (state.includes("BUYERS WINNING")) {
    return `Buy aggression and upside price response are aligned. Execution on asks: ${pct(buy.executionRatio)}.`;
  }
  if (state.includes("SELLERS WINNING")) {
    return `Sell aggression and downside price response are aligned. Execution on bids: ${pct(sell.executionRatio)}.`;
  }
  if (state.includes("ASK STACKING")) {
    return `Ask liquidity is being added faster than it is removed (stack ${fmt(liq.askStack)}).`;
  }
  if (state.includes("BID STACKING")) {
    return `Bid liquidity is being added faster than it is removed (stack ${fmt(liq.bidStack)}).`;
  }
  if (state.includes("BALANCED")) {
    return `Aggressive buy/sell pressure is roughly balanced over the selected window.`;
  }
  return `No persistent microstructure edge. Executed and cancelled liquidity remain separated in the panels below.`;
}

export function wallStatusBadge(status) {
  const s = String(status || "HOLDING").toUpperCase();
  if (s.includes("PULLED") || s === "WALL_PULLED") return { label: "PULLED", cls: "pulled" };
  if (s.includes("SWEPT") || s.includes("TRUE SWEEP")) return { label: "TRUE SWEEP", cls: "sweep" };
  if (s.includes("ABSORB")) return { label: "ABSORBING", cls: "absorbing" };
  if (s.includes("REFILL")) return { label: "REFILLING", cls: "refilling" };
  if (s.includes("BREAK")) return { label: "BREAKING", cls: "breaking" };
  if (s.includes("DEPLET") || s === "FADED") return { label: "DEPLETING", cls: "depleting" };
  if (s === "ACTIVE") return { label: "HOLDING", cls: "holding" };
  return { label: s.replace(/_/g, " "), cls: "holding" };
}

/** Dominance of aggression vs passive resistance for battle meter (0–1 aggression share). */
export function battleDominance(battle) {
  const attack = Math.min(Number(battle?.attackScore) || 0, 3) / 3;
  const exec = clamp01(battle?.executionRatio);
  const cancel = clamp01(battle?.cancellationRatio);
  const refill = clamp01(battle?.refillRatio);
  // Aggression wins visually via attack+exec; resistance via remaining liq implied by low exec + refill + cancel-as-withdraw is mixed
  const force = clamp01(0.45 * attack + 0.35 * exec + 0.2 * (1 - refill));
  const resist = clamp01(0.4 * (1 - exec) + 0.35 * refill + 0.25 * (1 - cancel) * 0.5 + 0.2);
  const sum = force + resist || 1;
  return { force: force / sum, resist: resist / sum };
}
