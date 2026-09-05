/** Wall detection and wall pull vs sweep tracking. */

export class Wall {
  constructor({ side, price, initialSize, now }) {
    this.side = side;
    this.price = price;
    this.initialSize = initialSize;
    this.currentSize = initialSize;
    this.executedVolume = 0;
    this.cancelledVolume = 0;
    this.refilledVolume = 0;
    this.createdAt = now;
    this.lastUpdate = now;
    this.active = true;
    this.status = "ACTIVE"; // ACTIVE | WALL_PULLED | SWEPT | FADED
  }

  get lifetimeMs() {
    return (this.lastUpdate - this.createdAt) * 1000;
  }

  get cancelRatio() {
    const removed = Math.max(0, this.initialSize - this.currentSize) + this.refilledVolume;
    const totalRemoved = this.executedVolume + this.cancelledVolume;
    return totalRemoved > 0 ? this.cancelledVolume / totalRemoved : 0;
  }

  get executionRatio() {
    const totalRemoved = this.executedVolume + this.cancelledVolume;
    return totalRemoved > 0 ? this.executedVolume / totalRemoved : 0;
  }

  get refillRatio() {
    return this.executedVolume > 0 ? this.refilledVolume / this.executedVolume : 0;
  }

  get depletionRatio() {
    return this.initialSize > 0
      ? Math.max(0, this.initialSize - this.currentSize) / this.initialSize
      : 0;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export class WallTracker {
  constructor(config) {
    this.config = config;
    /** @type {Map<string, Wall>} */
    this.walls = new Map(); // key side:price
    this.largestBidWall = null;
    this.largestAskWall = null;
  }

  key(side, price) {
    return `${side}:${price}`;
  }

  detect(book, now) {
    for (const side of ["bid", "ask"]) {
      const sizes = book.levelSizes(side).filter((s) => s > 0).sort((a, b) => a - b);
      if (!sizes.length) continue;

      const p95 = percentile(sizes, this.config.wallPercentile);
      const avg = sizes.reduce((a, b) => a + b, 0) / sizes.length;
      const threshold = Math.max(p95, avg * this.config.wallMultiplier);

      const levels = book.nearLevelsList(side);
      for (const lvl of levels) {
        const k = this.key(side, lvl.price);
        const isWall = lvl.quantity >= threshold && threshold > 0;

        if (isWall) {
          let wall = this.walls.get(k);
          if (!wall || !wall.active) {
            wall = new Wall({
              side,
              price: lvl.price,
              initialSize: lvl.quantity,
              now,
            });
            this.walls.set(k, wall);
          } else {
            if (lvl.quantity > wall.currentSize) {
              wall.refilledVolume += lvl.quantity - wall.currentSize;
            }
            wall.currentSize = lvl.quantity;
            wall.lastUpdate = now;
          }
        }
      }
    }

    this._refreshLargest();
  }

  onLiquidityEvents(events, now) {
    for (const ev of events) {
      const k = this.key(ev.side, ev.price);
      const wall = this.walls.get(k);
      if (!wall || !wall.active) continue;

      wall.lastUpdate = now;
      wall.currentSize = ev.currentSize;

      if (ev.eventType === "EXECUTION") {
        wall.executedVolume += ev.matchedTradeVolume || ev.volume;
      }
      if (ev.eventType === "CANCELLATION" || ev.eventType === "PULLING") {
        wall.cancelledVolume += ev.volume;
      }
      if (ev.eventType === "REFILL") {
        wall.refilledVolume += ev.volume;
      }

      this._classifyWall(wall);
    }
    this._refreshLargest();
  }

  _classifyWall(wall) {
    if (wall.lifetimeMs < this.config.minimumWallLifetimeMs) return;

    const depleted = wall.depletionRatio >= this.config.sweepDepletionRatio;
    if (!depleted && wall.currentSize > 0) {
      wall.status = "ACTIVE";
      return;
    }

    if (wall.currentSize <= 0 || depleted) {
      if (
        wall.cancelRatio >= this.config.pullCancelRatio &&
        wall.executionRatio < this.config.sweepExecutionRatio
      ) {
        wall.status = "WALL_PULLED";
        wall.active = wall.currentSize > wall.initialSize * 0.1;
      } else if (wall.executionRatio >= this.config.sweepExecutionRatio) {
        wall.status = "SWEPT";
        wall.active = false;
      } else if (wall.currentSize <= 0) {
        wall.status = "FADED";
        wall.active = false;
      }
    }
  }

  _refreshLargest() {
    let bestBid = null;
    let bestAsk = null;
    for (const wall of this.walls.values()) {
      if (!wall.active && wall.status === "FADED") continue;
      if (wall.side === "bid") {
        if (!bestBid || wall.currentSize > bestBid.currentSize) bestBid = wall;
      } else {
        if (!bestAsk || wall.currentSize > bestAsk.currentSize) bestAsk = wall;
      }
    }
    this.largestBidWall = bestBid;
    this.largestAskWall = bestAsk;

    // Prune old inactive walls
    for (const [k, w] of this.walls) {
      if (!w.active && Date.now() / 1000 - w.lastUpdate > 120) this.walls.delete(k);
    }
  }
}
