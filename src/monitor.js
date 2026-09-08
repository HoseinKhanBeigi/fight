/** Orchestrates feed → book → flow → liquidity → walls → classifier. */

import { CONFIG } from "./config.js";
import { BinanceFuturesFeed } from "./feed.js";
import { LocalOrderBook } from "./book.js";
import { AggressiveFlowTracker, TradePrint } from "./trades.js";
import { LiquidityEngine } from "./liquidity.js";
import { WallTracker } from "./walls.js";
import { MarketClassifier, absorptionFlags } from "./classifier.js";
import { MarketBattleEngine } from "./battle.js";
import { FootprintAggregator } from "./footprint.js";
import { PreMovePressureEngine } from "./microstructure/PreMovePressureEngine.js";
import { fetchAggTradesHistory, lookbackForInterval } from "./history.js";

function mergeWindows(a = [], b = []) {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

export class OrderFlowMonitor {
  constructor(config = CONFIG) {
    this.config = { ...CONFIG, ...config };
    this.trackingWindows = mergeWindows(
      this.config.windows,
      this.config.preMove?.windows
    );
    this.book = new LocalOrderBook(this.config.nearBookLevels);
    this.flow = new AggressiveFlowTracker(
      this.trackingWindows,
      this.config.tradeBookMatchToleranceMs
    );
    this.liquidity = new LiquidityEngine({
      ...this.config,
      windows: this.trackingWindows,
    });
    this.walls = new WallTracker(this.config);
    this.classifier = new MarketClassifier(this.config);
    this.battle = new MarketBattleEngine(this.config);
    this.preMove = new PreMovePressureEngine(this.config);
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
    this._backfilling = false;
    /** Deeper REST ladder for footprint rows (beyond live depth20). */
    this.depthLadder = { bids: [], asks: [], ts: 0 };
    this._depthLadderTimer = null;

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
        this.liquidity.clear();
        this.battle.clear();
        this.preMove.clear();
      },
      onStatus: (msg) => {
        // Don't clobber an active backfill status line
        if (this.history.status !== "loading") this.status = msg;
      },
    });
  }

  async start() {
    await this.feed.start();
    void this.backfillHistory();
    this._startDepthLadder();
  }

  stop() {
    this._backfillGen += 1;
    if (this._depthLadderTimer) {
      clearInterval(this._depthLadderTimer);
      this._depthLadderTimer = null;
    }
    this.feed.stop();
  }

  _startDepthLadder() {
    if (this._depthLadderTimer) clearInterval(this._depthLadderTimer);
    const ms = this.config.footprintDepthRefreshMs ?? 2000;
    void this.refreshDepthLadder();
    this._depthLadderTimer = setInterval(() => {
      void this.refreshDepthLadder();
    }, ms);
  }

  async refreshDepthLadder() {
    try {
      const limit = this.config.footprintDepthLimit ?? 100;
      const url = `${this.config.restBase}/fapi/v1/depth?symbol=${this.config.symbol.toUpperCase()}&limit=${limit}`;
      const res = await fetch(url);
      if (!res.ok) return;
      const j = await res.json();
      this.depthLadder = {
        bids: (j.bids || []).map(([p, q]) => ({
          price: Number(p),
          quantity: Number(q),
        })),
        asks: (j.asks || []).map(([p, q]) => ({
          price: Number(p),
          quantity: Number(q),
        })),
        ts: Date.now(),
      };
      // Infer tick / price precision from ladder when possible
      if (this.depthLadder.asks.length >= 2) {
        const d = Math.abs(this.depthLadder.asks[1].price - this.depthLadder.asks[0].price);
        if (d > 0 && d < 1) {
          const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(d))));
          this.footprint.pricePrecision = decimals;
        } else if (d >= 1) {
          this.footprint.pricePrecision = 1;
        }
      }
    } catch {
      /* ignore transient REST errors */
    }
  }

  /**
   * Pull previous aggressive trades from Binance REST into flow (+ footprint).
   * Does not reconstruct cancels/refills (API does not provide historical depth).
   */
  async backfillHistory(lookbackSec = null) {
    const gen = ++this._backfillGen;
    const maxWin = Math.max(...this.config.windows, 60);
    // Prefer enough history to fill the longest fight window
    const lookback =
      lookbackSec ??
      Math.max(
        maxWin + 30,
        lookbackForInterval(this.footprint.intervalSec, this.footprint.maxColumns)
      );

    this._backfilling = true;
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

      // Replace flow with a clean historical set (avoid live+history doubles)
      this.flow.clear();
      this.footprint.columns.clear();

      raw.sort((a, b) => Number(a.T) - Number(b.T));
      const nowSec = Date.now() / 1000;
      const flowKeep = maxWin;

      for (const row of raw) {
        const trade = new TradePrint({
          timestamp: Number(row.T) / 1000,
          price: Number(row.p),
          quantity: Number(row.q),
          isBuyerMaker: !!row.m,
          tradeId: Number(row.a ?? 0),
        });
        this.footprint.onTrade(trade);
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
    } finally {
      if (gen === this._backfillGen) this._backfilling = false;
    }
  }

  setFootprintInterval(sec) {
    const n = Number(sec);
    if (!n || n <= 0) return;
    const changed = n !== this.footprint.intervalSec;
    this.footprint.setInterval(n);
    if (changed) {
      void this.backfillHistory();
    }
  }

  setPreMoveWindow(sec) {
    const n = Number(sec);
    if (!n || n <= 0) return;
    if (!this.preMove.windows.includes(n)) return;
    this.preMove.primaryWindow = n;
  }

  _onTrade(data) {
    // While REST backfill rebuilds the window, skip live prints (dedupe also guards overlap)
    if (this._backfilling) return;
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
      this.book.clear();
      this.liquidity.clear();
      this.battle.clear();
      this.preMove.clear();
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
    const priceChangeByWindow = Object.fromEntries(
      this.config.windows.map((w) => [
        w,
        this.flow.priceChangeTicks(Math.min(w, 300), tick, now),
      ])
    );

    this.classifier.update({
      now,
      flowWindows,
      liqWindows,
      book: this.book,
      walls: this.walls,
      tickSize: tick,
      priceChangeTicks5s,
      windowSec: 60,
    });

    const askLiq = this.book.totalNearLiquidity("ask", 20);
    const bidLiq = this.book.totalNearLiquidity("bid", 20);
    const nearAskLiq = this.book.totalNearLiquidity("ask", 3);
    const nearBidLiq = this.book.totalNearLiquidity("bid", 3);
    const bookReady = this.ready && this.feed.bookReady;
    const staleBook = this.book.lastEventTime > 0 && now - this.book.lastEventTime > 2;
    const tradesReady = this.flow.trades.length > 0;
    const absorptionByWindow = Object.fromEntries(
      this.config.windows.map((w) => {
        const flow = flowWindows[w] || {};
        const liq = liqWindows[w] || {};
        return [
          w,
          absorptionFlags({
            aggressiveBuyVolume: flow.aggressiveBuyVolume || 0,
            aggressiveSellVolume: flow.aggressiveSellVolume || 0,
            askLiquidity: askLiq,
            bidLiquidity: bidLiq,
            askExec: liq.askExec || 0,
            bidExec: liq.bidExec || 0,
            askRefill: liq.askRefill || 0,
            bidRefill: liq.bidRefill || 0,
            priceChangeTicks: priceChangeByWindow[w] ?? priceChangeTicks5s,
            config: this.config,
          }),
        ];
      })
    );

    const priceNow = this.flow.lastPrice ?? this.book.midPrice();
    const battlesByWindow = this.battle.buildAll({
      windows: this.config.windows,
      flowWindows,
      liqWindows,
      askLiquidity: askLiq,
      bidLiquidity: bidLiq,
      nearAskLiquidity: nearAskLiq,
      nearBidLiquidity: nearBidLiq,
      priceNow,
      priceHistory: this.flow.priceHistory,
      now,
      bookReady,
      tradesReady,
      staleBook,
      walls: this.walls,
    });

    const lastTrade = this.flow.trades.length
      ? this.flow.trades[this.flow.trades.length - 1]
      : null;
    const preMove = this.preMove.snapshot({
      now,
      priceNow,
      priceHistory: this.flow.priceHistory,
      flowWindows,
      liqWindows,
      book: this.book,
      walls: this.walls,
      tickSize: tick,
      bookReady,
      tradesReady,
      staleBook,
      lastTradeAge: lastTrade ? now - lastTrade.timestamp : 999,
      lastBookAge: this.book.lastEventTime ? now - this.book.lastEventTime : 999,
    });

    const bb = this.book.bestBid();
    const ba = this.book.bestAsk();
    const primaryWindow = 60;
    const liq5 = liqWindows[primaryWindow] || liqWindows[300] || {};

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
            buyCount: st.buyCount || 0,
            sellCount: st.sellCount || 0,
            largeBuyVolume: st.largeBuyVolume || 0,
            largeSellVolume: st.largeSellVolume || 0,
          },
        ])
      ),
      liqWindows,
      bidLiquidity: bidLiq,
      askLiquidity: askLiq,
      bidLiquidityRange: this.book.nearPriceRange("bid", 20),
      askLiquidityRange: this.book.nearPriceRange("ask", 20),
      buyBattle: this.classifier.buyBattle,
      sellBattle: this.classifier.sellBattle,
      absorption: this.classifier.absorption,
      absorptionByWindow,
      battlesByWindow,
      preMove,
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
      footprint: this.footprint.snapshot(now, {
        bookBids:
          this.depthLadder.bids.length > 0
            ? this.depthLadder.bids
            : this.book.nearLevelsList("bid", this.config.footprintBidLevels ?? 30).map((l) => ({
                price: l.price,
                quantity: l.quantity,
              })),
        bookAsks:
          this.depthLadder.asks.length > 0
            ? this.depthLadder.asks
            : this.book.nearLevelsList("ask", this.config.footprintAskLevels ?? 30).map((l) => ({
                price: l.price,
                quantity: l.quantity,
              })),
        bidLevels: this.config.footprintBidLevels ?? 30,
        askLevels: this.config.footprintAskLevels ?? 30,
      }),
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
