/**
 * Append-only JSONL store for frozen snapshots and their 15m outcomes.
 *
 * One file per symbol + strategy version, so results from different formula
 * versions can never be mixed. Snapshots are written the moment they are
 * frozen, before the outcome exists, so a crash cannot lose the features.
 *
 * Line kinds:
 *   {"k":"h", ...}  header (strategy fingerprint, written once per file)
 *   {"k":"s", ...}  immutable snapshot at T
 *   {"k":"o", id, outcome}  outcome once the horizon elapsed
 */

import fs from "node:fs";
import path from "node:path";

function safeName(s) {
  return String(s || "UNKNOWN").replace(/[^A-Za-z0-9._-]/g, "_");
}

/** Persisted rows drop debug-only context to keep files a sane size. */
export function toPersisted(record) {
  const { strategyFingerprint, features, outcome, ...rest } = record;
  return {
    ...rest,
    features: {
      raw: features?.raw ?? null,
      normalized: features?.normalized ?? null,
    },
  };
}

export class PathTestStore {
  constructor({
    dir = "data/path-test",
    symbol = "UNKNOWN",
    strategyVersion = "PREMOVE_V1.0",
    fingerprint = null,
    maxRows = 8000,
    enabled = true,
  } = {}) {
    this.enabled = enabled;
    this.dir = path.resolve(dir);
    this.symbol = safeName(String(symbol).toUpperCase());
    this.strategyVersion = strategyVersion;
    this.fingerprint = fingerprint;
    this.maxRows = maxRows;
    this.file = path.join(this.dir, `${this.symbol}__${safeName(strategyVersion)}.jsonl`);
    this.ready = false;
    this.error = null;
    this.writes = 0;
  }

  _ensure() {
    if (!this.enabled || this.error) return false;
    if (this.ready) return true;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const fresh = !fs.existsSync(this.file) || fs.statSync(this.file).size === 0;
      this.ready = true;
      if (fresh) {
        this._write({
          k: "h",
          symbol: this.symbol,
          strategyVersion: this.strategyVersion,
          fingerprint: this.fingerprint,
          createdAt: new Date().toISOString(),
        });
      }
      return true;
    } catch (err) {
      this.error = err.message;
      this.enabled = false;
      return false;
    }
  }

  /**
   * Synchronous append: a few lines per minute, and a half-written file after a
   * kill would cost days of collection.
   */
  _write(obj) {
    if (!this._ensure()) return;
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(obj)}\n`);
      this.writes += 1;
    } catch (err) {
      this.error = err.message;
    }
  }

  appendSnapshot(record) {
    if (!this.enabled || !record) return;
    this._write({ k: "s", ...toPersisted(record) });
  }

  appendOutcome(id, outcome) {
    if (!this.enabled || !id || !outcome) return;
    this._write({ k: "o", id, outcome });
  }

  /**
   * Rebuild completed rows from disk. Snapshots without an outcome are counted
   * as abandoned: their price path was never observed, so labelling them after
   * a restart would invent data.
   */
  load() {
    const empty = { completed: [], abandoned: 0, totalLines: 0, file: this.file };
    if (!this.enabled) return empty;
    let text;
    try {
      if (!fs.existsSync(this.file)) return empty;
      text = fs.readFileSync(this.file, "utf8");
    } catch (err) {
      this.error = err.message;
      return empty;
    }

    /** @type {Map<string, object>} */
    const byId = new Map();
    const outcomes = new Map();
    let totalLines = 0;

    for (const line of text.split("\n")) {
      if (!line) continue;
      totalLines += 1;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue; // torn final line after a hard kill
      }
      if (row.k === "s" && row.id) byId.set(row.id, row);
      else if (row.k === "o" && row.id) outcomes.set(row.id, row.outcome);
    }

    const completed = [];
    let abandoned = 0;
    for (const [id, snap] of byId) {
      const outcome = outcomes.get(id);
      if (!outcome) {
        abandoned += 1;
        continue;
      }
      const { k, ...rest } = snap;
      completed.push({ ...rest, outcome });
    }
    completed.sort((a, b) => a.timestamp - b.timestamp);
    const trimmed = completed.slice(-this.maxRows);
    return { completed: trimmed, abandoned, totalLines, file: this.file };
  }

  /** Rewrite the file with only the rows still in memory. */
  compact(rows) {
    if (!this.enabled) return false;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      const lines = [
        JSON.stringify({
          k: "h",
          symbol: this.symbol,
          strategyVersion: this.strategyVersion,
          fingerprint: this.fingerprint,
          compactedAt: new Date().toISOString(),
        }),
      ];
      for (const r of rows) {
        lines.push(JSON.stringify({ k: "s", ...toPersisted(r) }));
        if (r.outcome) lines.push(JSON.stringify({ k: "o", id: r.id, outcome: r.outcome }));
      }
      fs.writeFileSync(tmp, `${lines.join("\n")}\n`);
      fs.renameSync(tmp, this.file);
      this.ready = true;
      return true;
    } catch (err) {
      this.error = err.message;
      return false;
    }
  }

  close() {
    // Appends are synchronous, so there is nothing buffered to flush.
    this.ready = false;
  }

  status() {
    return {
      enabled: this.enabled,
      file: this.file,
      writes: this.writes,
      error: this.error,
    };
  }
}

/**
 * Read snapshots back in timestamp order, each with its recorded outcome
 * attached when the 15m horizon had elapsed. Rows still awaiting an outcome are
 * returned with `outcome: null` so callers can count them.
 */
export function replayRowsFromFile(file) {
  const text = fs.readFileSync(file, "utf8");
  const rows = [];
  const outcomes = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      continue; // torn final line after a hard kill
    }
    if (row.k === "s" && row.id) {
      const { k, ...rest } = row;
      rows.push(rest);
    } else if (row.k === "o" && row.id) {
      outcomes.set(row.id, row.outcome);
    }
  }
  for (const row of rows) row.outcome = outcomes.get(row.id) ?? null;
  rows.sort((a, b) => a.timestamp - b.timestamp);
  return rows;
}
