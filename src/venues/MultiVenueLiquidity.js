/**
 * Near-touch liquidity snapshot (Binance only).
 * OKX / Bybit / Hyperliquid feeds are disabled — depth + battle stay Binance-primary.
 */

import { venueSymbols, VENUE_LABELS } from "./symbols.js";
import { VenueDepthBook } from "./VenueDepthBook.js";

const BINANCE_ONLY = ["binance"];

export class MultiVenueLiquidity {
  constructor({ levels = 20 } = {}) {
    this.levels = levels;
    this.symbol = null;
    this.ids = venueSymbols("");
    /** @type {Record<string, VenueDepthBook>} */
    this.books = {
      binance: new VenueDepthBook(levels),
    };
    this.status = {
      binance: "idle",
    };
    this.running = false;
  }

  async start(binanceSymbol) {
    await this.stop();
    this.running = true;
    this.symbol = String(binanceSymbol || "").toUpperCase();
    this.ids = venueSymbols(this.symbol);
    this.books.binance = new VenueDepthBook(this.levels);
    this.status.binance = "primary";
  }

  async stop() {
    this.running = false;
    for (const b of Object.values(this.books)) b.clear?.();
  }

  /** Sync Binance primary LocalOrderBook into aggregate. */
  syncBinance(localBook) {
    this.books.binance.fromLocalBook(localBook, this.levels);
    if (this.books.binance.ready) this.status.binance = "Binance live";
  }

  _venueRow(id, now) {
    const label = VENUE_LABELS[id] || id;
    const book = this.books.binance;

    const ready = !!book?.ready;
    const stale = !book || book.stale(now, 4);
    const askUsd = ready ? book.nearUsd("ask", this.levels) : null;
    const bidUsd = ready ? book.nearUsd("bid", this.levels) : null;

    return {
      id,
      label,
      supported: true,
      ready: ready && !stale,
      stale,
      status: this.status[id] || (ready ? "live" : "waiting"),
      askUsd: ready && !stale ? askUsd : null,
      bidUsd: ready && !stale ? bidUsd : null,
      askBase: ready && !stale ? book.nearBase("ask", this.levels) : null,
      bidBase: ready && !stale ? book.nearBase("bid", this.levels) : null,
      mid: ready ? book.mid() : null,
      bestBid: ready ? book.bestBid()?.price ?? null : null,
      bestAsk: ready ? book.bestAsk()?.price ?? null : null,
    };
  }

  snapshot(now = Date.now() / 1000) {
    const venues = {};
    let askUsd = 0;
    let bidUsd = 0;
    let askN = 0;
    let bidN = 0;
    let live = 0;

    for (const id of BINANCE_ONLY) {
      const row = this._venueRow(id, now);
      venues[id] = row;
      if (row.ready && Number.isFinite(row.askUsd)) {
        askUsd += row.askUsd;
        askN += 1;
      }
      if (row.ready && Number.isFinite(row.bidUsd)) {
        bidUsd += row.bidUsd;
        bidN += 1;
      }
      if (row.ready) live += 1;
    }

    return {
      symbol: this.symbol,
      base: this.ids.base,
      levels: this.levels,
      venues,
      venueOrder: BINANCE_ONLY,
      total: {
        askUsd: askN ? askUsd : null,
        bidUsd: bidN ? bidUsd : null,
        venuesLive: live,
        venuesConfigured: 1,
      },
    };
  }
}
