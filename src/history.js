/**
 * Historical aggressive-trade backfill from Binance USD-M Futures REST.
 * Public endpoint — no API key.
 *
 * YES:  GET /fapi/v1/aggTrades  → footprint buy/sell cells
 * NO:   historical L2 depth / cancels / refills (not offered on public REST)
 *
 * Note: when both startTime and endTime are set, Binance requires the span < 1 hour.
 */

import { binanceFetch } from "./binance-rest.js";

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const t = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Weight-20 endpoint: stay well under 120 req/min. */
export const AGG_TRADES_MIN_GAP_MS = 700;
/** Newest hours first; stop before multi-hour REST storms. */
export const AGG_TRADES_MAX_PAGES = 180;

/**
 * @param {{
 *   restBase: string,
 *   symbol: string,
 *   startMs: number,
 *   endMs: number,
 *   signal?: AbortSignal,
 *   onBatch?: (n:number, total:number) => void,
 *   onTrades?: (batch: Array<{a:number,p:string,q:string,T:number,m:boolean}>) => void,
 * }} opts
 * @returns {Promise<{ trades: number, pages: number, truncated: boolean }>}
 */
export async function fetchAggTradesHistory({
  restBase,
  symbol,
  startMs,
  endMs,
  signal = null,
  onBatch = null,
  onTrades = null,
}) {
  const base = restBase.replace(/\/$/, "");
  const sym = symbol.toUpperCase();
  let total = 0;
  let pages = 0;
  let truncated = false;

  const hours = [];
  for (let chunkEnd = endMs; chunkEnd > startMs; ) {
    const chunkStart = Math.max(startMs, chunkEnd - 3_600_000 + 1);
    hours.push([chunkStart, chunkEnd]);
    chunkEnd = chunkStart - 1;
  }

  for (const [chunkStart, chunkEnd] of hours) {
    if (signal?.aborted) throw abortError();
    let pageStart = chunkStart;

    for (;;) {
      if (signal?.aborted) throw abortError();
      if (pages >= AGG_TRADES_MAX_PAGES) {
        truncated = true;
        console.warn(
          `[backfill] ${sym} hit ${AGG_TRADES_MAX_PAGES} page cap — keeping most recent hours`
        );
        return { trades: total, pages, truncated };
      }

      const url = new URL(`${base}/fapi/v1/aggTrades`);
      url.searchParams.set("symbol", sym);
      url.searchParams.set("limit", "1000");
      url.searchParams.set("startTime", String(pageStart));
      url.searchParams.set("endTime", String(chunkEnd));

      let res;
      let attempt = 0;
      for (;;) {
        try {
          res = await binanceFetch(url, {
            weight: 20,
            minGapMs: AGG_TRADES_MIN_GAP_MS,
            signal,
            label: "aggTrades",
          });
          if (res.ok) break;
          const text = await res.text();
          throw new Error(`aggTrades HTTP ${res.status}: ${text.slice(0, 200)}`);
        } catch (err) {
          if (err?.name === "AbortError") throw err;
          if (err?.status === 418) throw err;
          if (err?.retryable && attempt < 4) {
            attempt += 1;
            await sleep(Math.min(20_000, 1_500 * 2 ** attempt), signal);
            continue;
          }
          throw err;
        }
      }

      const batch = await res.json();
      pages += 1;
      if (!Array.isArray(batch) || batch.length === 0) break;

      total += batch.length;
      if (onTrades) onTrades(batch);
      if (onBatch) onBatch(batch.length, total);

      if (batch.length < 1000) break;
      const lastT = Number(batch[batch.length - 1].T);
      const next = lastT + 1;
      if (next <= pageStart || next > chunkEnd) break;
      pageStart = next;
    }
  }

  return { trades: total, pages, truncated };
}

/** Sensible lookback (seconds) for a footprint interval. */
export function lookbackForInterval(intervalSec, maxColumns) {
  const cols = maxColumns || 48;
  const raw = Math.max(intervalSec * cols, intervalSec * 12);
  // Cap REST backfill — long pulls look like "no backfill" and hit rate limits
  const cap =
    intervalSec >= 3600
      ? 12 * 3600
      : intervalSec >= 2700
        ? 10 * 3600
        : intervalSec >= 1800
          ? 8 * 3600
          : intervalSec >= 900
            ? 6 * 3600
            : intervalSec >= 300
              ? 3 * 3600
              : 90 * 60;
  return Math.min(raw, cap);
}
