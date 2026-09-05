/**
 * Cancellation / refill / stacking / pulling inference from book Δ + trades.
 * Estimates only — never claimed as exact cancel volume.
 */

import { LiquidityEvent } from "./book.js";

export class RollingSideMetric {
  constructor(windows) {
    this.windows = [...windows];
    this.maxWindow = Math.max(...windows, 60);
    /** @type {{ts:number, bidCancel:number, askCancel:number, bidStack:number, askStack:number, bidRefill:number, askRefill:number, bidExec:number, askExec:number, bidRemoved:number, askRemoved:number}[]} */
    this.events = [];
  }

  push(sample) {
    this.events.push(sample);
    this._prune(sample.ts);
  }

  _prune(now) {
    const cutoff = now - this.maxWindow - 1;
    while (this.events.length && this.events[0].ts < cutoff) this.events.shift();
  }

  sum(now) {
    /** @type {Record<number, object>} */
    const out = {};
    for (const w of this.windows) {
      out[w] = {
        bidCancel: 0,
        askCancel: 0,
        bidStack: 0,
        askStack: 0,
        bidRefill: 0,
        askRefill: 0,
        bidExec: 0,
        askExec: 0,
        bidRemoved: 0,
        askRemoved: 0,
      };
    }
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      const age = now - e.ts;
      if (age > this.maxWindow) break;
      for (const w of this.windows) {
        if (age <= w) {
          const o = out[w];
          o.bidCancel += e.bidCancel;
          o.askCancel += e.askCancel;
          o.bidStack += e.bidStack;
          o.askStack += e.askStack;
          o.bidRefill += e.bidRefill;
          o.askRefill += e.askRefill;
          o.bidExec += e.bidExec;
          o.askExec += e.askExec;
          o.bidRemoved += e.bidRemoved;
          o.askRemoved += e.askRemoved;
        }
      }
    }
    return out;
  }
}

export class LiquidityEngine {
  constructor(config) {
    this.config = config;
    this.epsilon = config.epsilon;
    this.minCancel = config.minimumCancelVolume;
    this.minStack = config.minimumStackVolume;
    this.recentEvents = [];
    this.maxEvents = 2000;
    this.rolling = new RollingSideMetric(config.windows);

    // Per-update accumulators flushed each depth event
    this._acc = this._emptyAcc();
  }

  _emptyAcc() {
    return {
      bidCancel: 0,
      askCancel: 0,
      bidStack: 0,
      askStack: 0,
      bidRefill: 0,
      askRefill: 0,
      bidExec: 0,
      askExec: 0,
      bidRemoved: 0,
      askRemoved: 0,
    };
  }

  /**
   * Classify a single level change.
   * @returns {LiquidityEvent|null}
   */
  classifyLevelChange({ side, price, previous, current, matchedTradeVolume, now }) {
    const bookReduction = Math.max(0, previous - current);
    const bookIncrease = Math.max(0, current - previous);

    const executed = Math.min(matchedTradeVolume, bookReduction > 0 ? bookReduction : matchedTradeVolume);
    const estimatedCancel = Math.max(0, bookReduction - executed);

    const expectedRemaining = Math.max(0, previous - matchedTradeVolume);
    const estimatedRefill = Math.max(0, current - expectedRemaining);

    // Pure stack when no trades explain increase (refill already covers post-trade restock)
    let estimatedStack = 0;
    if (matchedTradeVolume < this.epsilon && bookIncrease > this.epsilon) {
      estimatedStack = bookIncrease;
    } else if (matchedTradeVolume > this.epsilon && estimatedRefill > this.epsilon) {
      // refill path — don't also count as stack
      estimatedStack = 0;
    }

    let eventType = "UNCHANGED";
    let volume = 0;

    if (bookReduction < this.epsilon && bookIncrease < this.epsilon && matchedTradeVolume < this.epsilon) {
      eventType = "UNCHANGED";
    } else if (estimatedCancel >= this.minCancel && estimatedCancel >= executed && bookReduction > 0) {
      // Mostly cancelled
      if (estimatedCancel / Math.max(bookReduction, this.epsilon) >= this.config.pullCancelRatio) {
        eventType = "PULLING";
        volume = estimatedCancel;
      } else if (executed > this.epsilon) {
        eventType = "CANCELLATION";
        volume = estimatedCancel;
      } else {
        eventType = "CANCELLATION";
        volume = estimatedCancel;
      }
    } else if (executed > this.epsilon && bookReduction > 0) {
      eventType = "EXECUTION";
      volume = executed;
      // If also significant cancel leftover
      if (estimatedCancel >= this.minCancel) {
        // Record cancel as secondary via accumulator; primary event is execution
      }
    } else if (estimatedRefill >= this.minStack) {
      eventType = "REFILL";
      volume = estimatedRefill;
    } else if (estimatedStack >= this.minStack) {
      eventType = "STACKING";
      volume = estimatedStack;
    } else if (bookReduction > this.epsilon && executed > this.epsilon) {
      eventType = "EXECUTION";
      volume = executed;
    }

    // Accumulate rolling metrics
    const remKey = side === "bid" ? "bidRemoved" : "askRemoved";
    const execKey = side === "bid" ? "bidExec" : "askExec";
    const cancelKey = side === "bid" ? "bidCancel" : "askCancel";
    const stackKey = side === "bid" ? "bidStack" : "askStack";
    const refillKey = side === "bid" ? "bidRefill" : "askRefill";

    this._acc[remKey] += bookReduction;
    this._acc[execKey] += executed;
    this._acc[cancelKey] += estimatedCancel;
    this._acc[stackKey] += estimatedStack;
    this._acc[refillKey] += estimatedRefill;

    if (eventType === "UNCHANGED") return null;

    return new LiquidityEvent({
      timestamp: now,
      price,
      side,
      eventType,
      volume,
      previousSize: previous,
      currentSize: current,
      matchedTradeVolume: executed,
    });
  }

  /**
   * Process a depth update against the local book + trade matcher.
   * Supports:
   * - REST snapshot (_snapshot)
   * - incremental diffs
   * - partial top-N replace (_partial) from @depth20@100ms
   */
  processDepthUpdate(book, flow, event) {
    const isSnapshot = !!event._snapshot;
    const isPartial = !!event._partial;
    const rawTs = event.T || event.E || Date.now();
    const now = rawTs > 1e12 ? rawTs / 1000 : rawTs;

    if (isSnapshot && !isPartial) {
      book.applySnapshot(event.b || [], event.a || [], Number(event.lastUpdateId ?? event.u), rawTs);
      return [];
    }

    this._acc = this._emptyAcc();
    const events = [];

    if (isPartial) {
      // Replace near book: diff previous vs new absolute top-N ladders.
      // Levels that fall out of the top-N window due to price movement are
      // scroll-outs — NOT cancellations.
      const incomingBids = event.b || [];
      const incomingAsks = event.a || [];
      const newBidPrices = incomingBids.map(([p]) => Number(p));
      const newAskPrices = incomingAsks.map(([p]) => Number(p));
      const worstBid = newBidPrices.length ? Math.min(...newBidPrices) : null;
      const worstAsk = newAskPrices.length ? Math.max(...newAskPrices) : null;

      for (const side of ["bid", "ask"]) {
        const incoming = side === "bid" ? incomingBids : incomingAsks;
        const newMap = new Map();
        for (const [p, q] of incoming) {
          newMap.set(Number(p), Number(q));
        }
        const oldPrices = new Set(book.getSideBook(side).keys());
        const allPrices = new Set([...oldPrices, ...newMap.keys()]);

        for (const price of allPrices) {
          const previous = book.getSideBook(side).has(price)
            ? book.getSideBook(side).get(price).quantity
            : 0;
          const current = newMap.has(price) ? newMap.get(price) : 0;

          // Scroll-out: level left the visible window because price moved
          const scrolledOut =
            current <= 0 &&
            previous > 0 &&
            ((side === "bid" && worstBid != null && price < worstBid) ||
              (side === "ask" && worstAsk != null && price > worstAsk));

          if (scrolledOut) {
            book.setLevelQty(side, price, 0, now, false);
            continue;
          }

          if (Math.abs(previous - current) < this.epsilon && current > 0) {
            const lvl = book.getSideBook(side).get(price);
            if (lvl) lvl.lastUpdate = now;
            continue;
          }

          const reduction = Math.max(0, previous - current);
          let matched = 0;
          if (reduction > 0) {
            matched = flow.consumeMatchedVolume(price, side, now, reduction);
          }

          const { previous: prev, current: cur, level } = book.setLevelQty(
            side,
            price,
            current,
            now,
            false
          );

          const liqEvent = this.classifyLevelChange({
            side,
            price,
            previous: prev,
            current: cur,
            matchedTradeVolume: matched,
            now,
          });

          if (level) {
            level.lastTradeVolume = matched;
            level.confirmedTradeVolume += matched;
            level.estimatedCancelledVolume += Math.max(0, Math.max(0, prev - cur) - matched);
            const expectedRemaining = Math.max(0, prev - matched);
            level.estimatedRefillVolume += Math.max(0, cur - expectedRemaining);
            if (matched < this.epsilon && cur > prev) {
              level.estimatedStackVolume += cur - prev;
            }
            if (side === "ask") level.takerBuyVolume += matched;
            else level.takerSellVolume += matched;
          }

          if (liqEvent) {
            events.push(liqEvent);
            this.recentEvents.push(liqEvent);
            if (this.recentEvents.length > this.maxEvents) this.recentEvents.shift();
          }
        }
      }
      book.rebuildSorted();
      book.lastUpdateId = Number(event.u);
      book.lastEventTime = now;
      book.inferTickSize();
      this.rolling.push({ ts: now, ...this._acc });
      return events;
    }

    const applySide = (side, levels) => {
      for (const [priceS, qtyS] of levels) {
        const price = Number(priceS);
        const qty = Number(qtyS);
        const bookMap = book.getSideBook(side);
        const previous = bookMap.has(price) ? bookMap.get(price).quantity : 0;

        const reduction = Math.max(0, previous - (qty > 0 ? qty : 0));
        let matched = 0;
        if (reduction > 0 || previous > 0) {
          matched = flow.consumeMatchedVolume(price, side, now, reduction > 0 ? reduction : previous);
        }

        const { previous: prev, current, level } = book.setLevelQty(
          side,
          price,
          qty > 0 ? qty : 0,
          now,
          false
        );

        const liqEvent = this.classifyLevelChange({
          side,
          price,
          previous: prev,
          current,
          matchedTradeVolume: matched,
          now,
        });

        if (level) {
          level.lastTradeVolume = matched;
          level.confirmedTradeVolume += matched;
          level.estimatedCancelledVolume += Math.max(0, Math.max(0, prev - current) - matched);
          const expectedRemaining = Math.max(0, prev - matched);
          const refill = Math.max(0, current - expectedRemaining);
          level.estimatedRefillVolume += refill;
          if (matched < this.epsilon && current > prev) {
            level.estimatedStackVolume += current - prev;
          }
          if (side === "ask") level.takerBuyVolume += matched;
          else level.takerSellVolume += matched;
        }

        if (liqEvent) {
          events.push(liqEvent);
          this.recentEvents.push(liqEvent);
          if (this.recentEvents.length > this.maxEvents) this.recentEvents.shift();
        }
      }
    };

    applySide("bid", event.b || []);
    applySide("ask", event.a || []);
    book.rebuildSorted();

    book.lastUpdateId = Number(event.u);
    book.lastEventTime = now;
    book.inferTickSize();

    this.rolling.push({ ts: now, ...this._acc });
    return events;
  }

  ratios(windowSums, epsilon = this.epsilon) {
    /** @type {Record<number, object>} */
    const out = {};
    for (const [w, s] of Object.entries(windowSums)) {
      const bidCancelRatio = s.bidCancel / Math.max(s.bidRemoved, epsilon);
      const askCancelRatio = s.askCancel / Math.max(s.askRemoved, epsilon);
      const bidExecRatio = s.bidExec / Math.max(s.bidRemoved, epsilon);
      const askExecRatio = s.askExec / Math.max(s.askRemoved, epsilon);
      const cancelImbalance =
        (s.askCancel - s.bidCancel) / Math.max(s.askCancel + s.bidCancel, epsilon);
      out[w] = {
        ...s,
        bidCancelRatio,
        askCancelRatio,
        bidExecRatio,
        askExecRatio,
        cancelImbalance,
        bidPassivePressure: s.bidStack + s.bidRefill - s.bidCancel,
        askPassivePressure: s.askStack + s.askRefill - s.askCancel,
        bidCancelRate: s.bidCancel, // volume/sec approx via window later
        askCancelRate: s.askCancel,
      };
    }
    return out;
  }
}
