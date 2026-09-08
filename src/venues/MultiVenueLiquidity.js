/**
 * Multi-venue near-touch liquidity aggregator.
 *
 * Primary battle/flow stays on Binance.
 * OKX + Bybit + Hyperliquid contribute CURRENT depth (USD notional) only.
 * Snapshot exposes per-venue breakdown + summed totals.
 */

import { venueSymbols, VENUE_IDS, VENUE_LABELS } from "./symbols.js";
import { VenueDepthBook } from "./VenueDepthBook.js";
import { OkxDepthFeed } from "./okx.js";
import { BybitDepthFeed } from "./bybit.js";
import { HyperliquidDepthFeed } from "./hyperliquid.js";

export class MultiVenueLiquidity {
  constructor({ levels = 20 } = {}) {
    this.levels = levels;
    this.symbol = null;
    this.ids = venueSymbols("");
    /** @type {Record<string, VenueDepthBook>} */
    this.books = {
      binance: new VenueDepthBook(levels),
    };
    this.feeds = {
      okx: null,
      bybit: null,
      hyperliquid: null,
    };
    this.status = {
      binance: "idle",
      okx: "idle",
      bybit: "idle",
      hyperliquid: "idle",
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

    if (this.ids.okx) {
      this.feeds.okx = new OkxDepthFeed({
        instId: this.ids.okx,
        levels: this.levels,
        onStatus: (m) => {
          this.status.okx = m;
        },
      });
      void this.feeds.okx.start();
    } else {
      this.status.okx = "UNSUPPORTED";
    }

    if (this.ids.bybit) {
      this.feeds.bybit = new BybitDepthFeed({
        symbol: this.ids.bybit,
        levels: this.levels,
        onStatus: (m) => {
          this.status.bybit = m;
        },
      });
      void this.feeds.bybit.start();
    } else {
      this.status.bybit = "UNSUPPORTED";
    }

    if (this.ids.hyperliquid) {
      this.feeds.hyperliquid = new HyperliquidDepthFeed({
        coin: this.ids.hyperliquid,
        levels: this.levels,
        onStatus: (m) => {
          this.status.hyperliquid = m;
        },
      });
      void this.feeds.hyperliquid.start();
    } else {
      this.status.hyperliquid = "UNSUPPORTED";
    }
  }

  async stop() {
    this.running = false;
    for (const key of ["okx", "bybit", "hyperliquid"]) {
      try {
        this.feeds[key]?.stop();
      } catch {
        /* ignore */
      }
      this.feeds[key] = null;
    }
    for (const b of Object.values(this.books)) b.clear?.();
  }

  /** Sync Binance primary LocalOrderBook into aggregate. */
  syncBinance(localBook) {
    this.books.binance.fromLocalBook(localBook, this.levels);
    if (this.books.binance.ready) this.status.binance = "Binance live";
  }

  _venueBook(id) {
    if (id === "binance") return this.books.binance;
    return this.feeds[id]?.book || null;
  }

  _venueRow(id, now) {
    const label = VENUE_LABELS[id] || id;
    const book = this._venueBook(id);
    const supported =
      id === "binance" ? true : id === "okx" ? !!this.ids.okx : id === "bybit" ? !!this.ids.bybit : !!this.ids.hyperliquid;

    if (!supported) {
      return {
        id,
        label,
        supported: false,
        ready: false,
        stale: true,
        status: "UNSUPPORTED",
        askUsd: null,
        bidUsd: null,
        askBase: null,
        bidBase: null,
        mid: null,
        bestBid: null,
        bestAsk: null,
      };
    }

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

    for (const id of VENUE_IDS) {
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
      venueOrder: VENUE_IDS,
      total: {
        askUsd: askN ? askUsd : null,
        bidUsd: bidN ? bidUsd : null,
        venuesLive: live,
        venuesConfigured: VENUE_IDS.filter((id) => venues[id].supported).length,
      },
    };
  }
}
