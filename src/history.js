/**
 * Historical aggressive-trade backfill from Binance USD-M Futures REST.
 * Public endpoint — no API key.
 *
 * YES:  GET /fapi/v1/aggTrades  → footprint buy/sell cells
 * NO:   historical L2 depth / cancels / refills (not offered on public REST)
 *
 * Note: when both startTime and endTime are set, Binance requires the span < 1 hour.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {{ restBase: string, symbol: string, startMs: number, endMs: number, onBatch?: (n:number, total:number) => void }} opts
 * @returns {Promise<Array<{a:number,p:string,q:string,T:number,m:boolean}>>}
 */
export async function fetchAggTradesHistory({
  restBase,
  symbol,
  startMs,
  endMs,
  onBatch = null,
}) {
  const base = restBase.replace(/\/$/, "");
  const sym = symbol.toUpperCase();
  const out = [];
  let cursor = startMs;
  const hardEnd = endMs;

  while (cursor < hardEnd) {
    // Binance: startTime+endTime window must be < 1 hour
    const chunkEnd = Math.min(cursor + 3_600_000 - 1, hardEnd);
    let pageStart = cursor;

    for (;;) {
      const url = new URL(`${base}/fapi/v1/aggTrades`);
      url.searchParams.set("symbol", sym);
      url.searchParams.set("limit", "1000");
      url.searchParams.set("startTime", String(pageStart));
      url.searchParams.set("endTime", String(chunkEnd));

      const res = await fetch(url);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`aggTrades HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const batch = await res.json();
      if (!Array.isArray(batch) || batch.length === 0) break;

      out.push(...batch);
      if (onBatch) onBatch(batch.length, out.length);

      if (batch.length < 1000) break;
      const lastT = Number(batch[batch.length - 1].T);
      const next = lastT + 1;
      if (next <= pageStart || next > chunkEnd) break;
      pageStart = next;
      await sleep(40);
    }

    cursor = chunkEnd + 1;
    await sleep(40);
  }

  return out;
}

/** Sensible lookback (seconds) for a footprint interval. */
export function lookbackForInterval(intervalSec, maxColumns) {
  const cols = maxColumns || 48;
  const raw = Math.max(intervalSec * cols, intervalSec * 12);
  // Cap REST backfill so Railway / rate limits stay sane
  const cap =
    intervalSec >= 2700
      ? 12 * 3600
      : intervalSec >= 1800
        ? 10 * 3600
        : intervalSec >= 900
          ? 8 * 3600
          : intervalSec >= 300
            ? 4 * 3600
            : 2 * 3600;
  return Math.min(raw, cap);
}
