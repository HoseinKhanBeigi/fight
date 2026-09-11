/**
 * Touch vs far resting-book imbalance (Binance L2).
 * Near = first N levels from touch; far = rest of depth band.
 */

const EPS = 1e-12;

function sumQty(levels) {
  let s = 0;
  for (const l of levels || []) {
    const q = Number(l?.quantity ?? l?.[1]);
    if (Number.isFinite(q) && q > 0) s += q;
  }
  return s;
}

function imb(bid, ask) {
  const t = bid + ask;
  if (t <= EPS) return null;
  return (bid - ask) / t;
}

function takeLevels(side, nearN, depthN, book, ladder) {
  const useLadder =
    ladder &&
    ((side === "bid" && ladder.bids?.length >= depthN) ||
      (side === "ask" && ladder.asks?.length >= depthN));
  if (useLadder) {
    const arr = side === "bid" ? ladder.bids : ladder.asks;
    return arr.slice(0, depthN).map((l) => ({
      price: Number(l.price),
      quantity: Number(l.quantity),
    }));
  }
  return book.nearLevelsList(side, depthN);
}

/**
 * @param {import("./book.js").LocalOrderBook} book
 * @param {{ nearLevels?: number, depthLevels?: number, ladder?: { bids: any[], asks: any[] }|null }} opts
 */
export function computeBookShape(book, opts = {}) {
  const nearN = Math.max(1, Number(opts.nearLevels) || 3);
  const depthN = Math.max(nearN + 1, Number(opts.depthLevels) || 20);
  const ladder = opts.ladder || null;

  const asks = takeLevels("ask", nearN, depthN, book, ladder);
  const bids = takeLevels("bid", nearN, depthN, book, ladder);

  const nearAsk = sumQty(asks.slice(0, nearN));
  const nearBid = sumQty(bids.slice(0, nearN));
  const depthAsk = sumQty(asks);
  const depthBid = sumQty(bids);
  const farAsk = Math.max(0, depthAsk - nearAsk);
  const farBid = Math.max(0, depthBid - nearBid);

  const touchImb = imb(nearBid, nearAsk);
  const farImb = imb(farBid, farAsk);
  const bookImb = imb(depthBid, depthAsk);

  const touchAbs = touchImb == null ? 0 : Math.abs(touchImb);
  const farAbs = farImb == null ? 0 : Math.abs(farImb);
  const diverge =
    touchImb != null &&
    farImb != null &&
    Math.sign(touchImb) !== 0 &&
    Math.sign(farImb) !== 0 &&
    Math.sign(touchImb) !== Math.sign(farImb) &&
    touchAbs >= 0.35 &&
    farAbs >= 0.25 &&
    nearBid + nearAsk > EPS &&
    farBid + farAsk > EPS;

  let alert = null;
  if (diverge) {
    // touch bid-heavy + far ask-heavy → soft touch / far ask wall
    if (touchImb > 0 && farImb < 0) {
      alert = {
        id: "touch-bid-far-ask",
        side: "ask-wall",
        title: "TOUCH BID / FAR ASK",
        detail: "Near book leans bids while deeper asks dominate — soft touch, far resistance",
      };
    } else if (touchImb < 0 && farImb > 0) {
      alert = {
        id: "touch-ask-far-bid",
        side: "bid-wall",
        title: "TOUCH ASK / FAR BID",
        detail: "Near book leans asks while deeper bids dominate — soft touch, far support",
      };
    }
  }

  return {
    nearLevels: nearN,
    depthLevels: depthN,
    source: ladder?.bids?.length >= depthN ? "depthLadder" : "liveBook",
    nearAsk,
    nearBid,
    farAsk,
    farBid,
    depthAsk,
    depthBid,
    touchImb,
    farImb,
    bookImb,
    askConc: depthAsk > EPS ? nearAsk / depthAsk : null,
    bidConc: depthBid > EPS ? nearBid / depthBid : null,
    diverge: !!alert,
    alert,
  };
}
