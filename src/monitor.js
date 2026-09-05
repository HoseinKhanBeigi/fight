/** Orchestrates feed → book → flow → liquidity → walls → classifier. */

import { CONFIG } from "./config.js";
import { BinanceFuturesFeed } from "./feed.js";
import { LocalOrderBook } from "./book.js";
import { AggressiveFlowTracker, TradePrint } from "./trades.js";
import { LiquidityEngine } from "./liquidity.js";
import { WallTracker } from "./walls.js";
import { MarketClassifier } from "./classifier.js";
import { FootprintAggregator } from "./footprint.js";
import { fetchAggTradesHistory, lookbackForInterval } from "./history.js";

export class OrderFlowMonitor {
  constructor(config = CONFIG) {
    this.config = { ...CONFIG, ...config };
    this.book = new LocalOrderBook(this.config.nearBookLevels);
    this.flow = new AggressiveFlowTracker(
      this.config.windows,
      this.config.tradeBookMatchToleranceMs
    );
    this.liquidity = new LiquidityEngine(this.config);
    this.walls = new WallTracker(this.config);
    this.classifier = new MarketClassifier(this.config);
    this.footprint = new FootprintAggregator({
      intervalSec: this.config.footprintIntervalSec ?? 5,
      maxColumns: this.config.footprintColumns ?? 48,
      pricePrecision: this.config.footprintPricePrecision ?? 1,
    });
    this.status = "starting";
    this.ready = false;
    this.lastEvents = [];
    this.history = {
      status: "idle", // idle | loading | done | error
      loaded: 0,
      lookbackSec: 0,
      error: null,
    };
    this._backfillGen = 0;

    this.feed = new BinanceFuturesFeed({
      symbol: this.config.symbol,
      restBase: this.config.restBase,
      wsBase: this.config.wsBase,
      wsFallbacks: this.config.wsFallbacks || [],
      depthLimit: this.config.bookDepthLimit,
      bookMode: this.config.bookMode || "partial20",
      onTrade: (d) => this._onTrade(d),
      onDepth: (d) => this._onDepth(d),
      onResync: () => {
        this.ready = false;
        this.book.clear();
      },
      onStatus: (msg) => {
        // Don't clobber an active backfill status line
        if (this.history.status !== "loading") this.status = msg;
      },
    });
  }

  async start() {
    await this.feed.start();
    // Live stream first; backfill historical aggTrades in parallel
    void this.backfillHistory();
  }

  stop() {
    this._backfillGen += 1;
    this.feed.stop();
  }

  /**
   * Pull previous aggressive trades from Binance REST into footprint (+ recent flow).
   * Does not reconstruct cancels/refills (API does not provide historical depth).
   */
  async backfillHistory(lookbackSec = null) {
    const gen = ++this._backfillGen;
    const interval = this.footprint.intervalSec;
    const lookback =
      lookbackSec ??
      lookbackForInterval(interval, this.footprint.maxColumns);

    this.history = {
      status: "loading",
      loaded: 0,
      lookbackSec: lookback,
      error: null,
    };
    this.status = `Backfilling ~${Math.round(lookback / 60)}m of trades…`;

    const endMs = Date.now();
    const startMs = endMs - lookback * 1000;

    try {
      const raw = await fetchAggTradesHistory({
        restBase: this.config.restBase,
        symbol: this.config.symbol,
        startMs,
        endMs,
        onBatch: (_n, total) => {
          if (gen !== this._backfillGen) return;
          this.history.loaded = total;
          this.status = `Backfilling… ${total.toLocaleString()} trades`;
        },
      });

      if (gen !== this._backfillGen) return;

      // Sort ascending and ingest
      raw.sort((a, b) => Number(a.T) - Number(b.T));
      const nowSec = Date.now() / 1000;
      const flowKeep = Math.max(...this.config.windows, 60);

      for (const row of raw) {
        const trade = new TradePrint({
          timestamp: Number(row.T) / 1000,
          price: Number(row.p),
          quantity: Number(row.q),
          isBuyerMaker: !!row.m,
          tradeId: Number(row.a ?? 0),
        });
        this.footprint.onTrade(trade);
        // Only keep recent prints in the rolling flow windows
        if (nowSec - trade.timestamp <= flowKeep + 5) {
          this.flow.onTrade(trade);
        }
      }

      this.history = {
        status: "done",
        loaded: raw.length,
        lookbackSec: lookback,
        error: null,
      };
      this.status = `History loaded: ${raw.length.toLocaleString()} trades (~${Math.round(lookback / 60)}m)`;
    } catch (err) {
      if (gen !== this._backfillGen) return;
      this.history = {
        status: "error",
        loaded: this.history.loaded || 0,
        lookbackSec: lookback,
        error: err.message || String(err),
      };
      this.status = `History backfill failed: ${err.message}`;
    }
  }

  setFootprintInterval(sec) {
    const n = Number(sec);
    if (!n || n <= 0) return;
    const changed = n !== this.footprint.intervalSec;
    this.footprint.setInterval(n);
    if (changed) {
      // Rebuild footprint from REST history for the new timeframe
      void this.backfillHistory();
    }
  }

  _onTrade(data) {
    const ts = (data.T || data.E || Date.now()) / 1000;
    const trade = new TradePrint({
      timestamp: ts,
      price: Number(data.p),
      quantity: Number(data.q),
      isBuyerMaker: !!data.m,
      tradeId: Number(data.a ?? data.t ?? 0),
    });
    this.flow.onTrade(trade);
    this.footprint.onTrade(trade);
  }

  _onDepth(data) {
    const events = this.liquidity.processDepthUpdate(this.book, this.flow, data);
    this.lastEvents = events;
    this.ready = this.feed.bookReady;
    if (events.length) this.footprint.onLiquidityEvents(events);

    const now =
      (data.T || data.E || Date.now()) > 1e12
        ? (data.T || data.E) / 1000
        : Date.now() / 1000;

    if (!data._snapshot) {
      this.walls.detect(this.book, now);
      this.walls.onLiquidityEvents(events, now);
    }

    // Crossed book ⇒ resync (should never happen on a healthy L2)
    const bb = this.book.bestBid();
    const ba = this.book.bestAsk();
    if (bb && ba && bb.price >= ba.price && this.feed.bookReady) {
      this.status = "Crossed book detected — resyncing";
      this.feed.bookReady = false;
      this.ready = false;
      this.feed.queueSync();
    }
  }

  snapshot() {
    const now = Date.now() / 1000;
    const flowWindows = this.flow.windowStats(now);
    const liqRaw = this.liquidity.rolling.sum(now);
    const liqWindows = this.liquidity.ratios(liqRaw);
    const tick = this.book.tickSize;
    const priceChangeTicks5s = this.flow.priceChangeTicks(5, tick, now);

    this.classifier.update({
      now,
      flowWindows,
      liqWindows,
      book: this.book,
      walls: this.walls,
      tickSize: tick,
      priceChangeTicks5s,
    });

    const bb = this.book.bestBid();
    const ba = this.book.bestAsk();
    const primaryWindow = 5;
    const liq5 = liqWindows[primaryWindow] || liqWindows[15] || {};

    const serializeWall = (w) =>
      w
        ? {
            side: w.side,
            price: w.price,
            initialSize: w.initialSize,
            currentSize: w.currentSize,
            executedVolume: w.executedVolume,
            cancelledVolume: w.cancelledVolume,
            refilledVolume: w.refilledVolume,
            executionRatio: w.executionRatio,
            cancelRatio: w.cancelRatio,
            refillRatio: w.refillRatio,
            depletionRatio: w.depletionRatio,
            lifetimeMs: w.lifetimeMs,
            status: w.status,
            active: w.active,
            createdAt: w.createdAt,
            lastUpdate: w.lastUpdate,
          }
        : null;

    const levelRows = (side, n = 15) =>
      this.book.nearLevelsList(side, n).map((lvl) => {
        const removed = Math.max(
          0,
          lvl.confirmedTradeVolume + lvl.estimatedCancelledVolume
        );
        const execRatio =
          removed > 0 ? lvl.confirmedTradeVolume / removed : 0;
        const cancelRatio =
          removed > 0 ? lvl.estimatedCancelledVolume / removed : 0;
        const fightScore =
          side === "ask"
            ? lvl.takerBuyVolume / Math.max(lvl.quantity, this.config.epsilon)
            : lvl.takerSellVolume / Math.max(lvl.quantity, this.config.epsilon);
        return {
          side,
          price: lvl.price,
          quantity: lvl.quantity,
          executed: lvl.confirmedTradeVolume,
          cancelled: lvl.estimatedCancelledVolume,
          refilled: lvl.estimatedRefillVolume,
          stacked: lvl.estimatedStackVolume,
          execRatio,
          cancelRatio,
          fightScore,
          isWall:
            (side === "ask" &&
              this.walls.largestAskWall?.price === lvl.price) ||
            (side === "bid" &&
              this.walls.largestBidWall?.price === lvl.price),
        };
      });

    const wallsList = [...this.walls.walls.values()]
      .map(serializeWall)
      .filter(Boolean)
      .sort((a, b) => b.currentSize - a.currentSize)
      .slice(0, 24);

    const conn =
      this.ready && String(this.status).toLowerCase().includes("live")
        ? "LIVE"
        : this.ready
          ? "LIVE"
          : String(this.status).toLowerCase().includes("reconnect") ||
              String(this.status).toLowerCase().includes("connecting")
            ? "RECONNECTING"
            : String(this.status).toLowerCase().includes("closed") ||
                String(this.status).toLowerCase().includes("error")
              ? "DISCONNECTED"
              : "RECONNECTING";

    return {
      ts: Date.now(),
      symbol: this.config.symbol.toUpperCase(),
      status: this.status,
      connection: conn,
      ready: this.ready,
      windows: this.config.windows,
      price: this.flow.lastPrice ?? this.book.midPrice(),
      bestBid: bb?.price ?? null,
      bestAsk: ba?.price ?? null,
      bestBidQty: bb?.quantity ?? null,
      bestAskQty: ba?.quantity ?? null,
      spread: this.book.spread(),
      tickSize: tick,
      flowWindows: Object.fromEntries(
        Object.entries(flowWindows).map(([w, st]) => [
          w,
          {
            aggressiveBuyVolume: st.aggressiveBuyVolume,
            aggressiveSellVolume: st.aggressiveSellVolume,
            netDelta: st.netDelta,
            totalVolume: st.totalVolume,
            buyRatio: st.buyRatio,
            sellRatio: st.sellRatio,
          },
        ])
      ),
      liqWindows,
      bidLiquidity: this.book.totalNearLiquidity("bid", 20),
      askLiquidity: this.book.totalNearLiquidity("ask", 20),
      buyBattle: this.classifier.buyBattle,
      sellBattle: this.classifier.sellBattle,
      state: this.classifier.currentState,
      pendingState: this.classifier.pendingState,
      largestBidWall: serializeWall(this.walls.largestBidWall),
      largestAskWall: serializeWall(this.walls.largestAskWall),
      walls: wallsList,
      asks: levelRows("ask", 15),
      bids: levelRows("bid", 15),
      priceChangeTicks5s,
      cancelImbalanceLabel: this._cancelImbalanceLabel(liq5),
      pulling: {
        bid: this._levelLabel(liq5.bidCancelRatio, liq5.bidCancel),
        ask: this._levelLabel(liq5.askCancelRatio, liq5.askCancel),
      },
      stacking: {
        bid: this._stackLabel(liq5.bidStack),
        ask: this._stackLabel(liq5.askStack),
      },
      recentEvents: this.liquidity.recentEvents.slice(-40).map((e) => ({
        timestamp: e.timestamp,
        price: e.price,
        side: e.side,
        eventType: e.eventType,
        volume: e.volume,
        previousSize: e.previousSize,
        currentSize: e.currentSize,
        matchedTradeVolume: e.matchedTradeVolume,
      })),
      footprint: this.footprint.snapshot(now),
      history: { ...this.history },
      note: "Cancellation volumes are ESTIMATES (book Δ − matched trades). Historical footprint uses Binance aggTrades REST; cancels/refills are live-only.",
    };
  }

  _cancelImbalanceLabel(liq) {
    if (!liq || liq.cancelImbalance == null) return "BALANCED";
    if (liq.cancelImbalance > 0.25) return "ASKS PULLING";
    if (liq.cancelImbalance < -0.25) return "BIDS PULLING";
    return "BALANCED";
  }

  _levelLabel(ratio, vol) {
    if (!vol || vol < this.config.minimumCancelVolume) return "LOW";
    if (ratio >= 0.6) return "HIGH";
    if (ratio >= 0.3) return "MED";
    return "LOW";
  }

  _stackLabel(vol) {
    if (!vol || vol < this.config.minimumStackVolume) return "LOW";
    if (vol > 5) return "HIGH";
    if (vol > 1) return "MED";
    return "LOW";
  }
}
