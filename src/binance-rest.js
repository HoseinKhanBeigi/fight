/**
 * Serialized Binance USD-M Futures REST with IP-ban awareness.
 *
 * Futures REQUEST_WEIGHT is 2400/min. GET /fapi/v1/aggTrades is weight 20,
 * so even a polite 20ms page gap (~50 req/s) burns the budget in seconds
 * and earns a 418 IP ban. One in-flight request at a time, with gaps.
 */

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

/** @param {string} text */
export function parseBinanceBanUntil(text) {
  const m = String(text || "").match(/banned until\s+(\d+)/i);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? n * 1000 : n;
}

let bannedUntil = 0;
let nextAt = 0;
let queue = Promise.resolve();
let loggedBanUntil = 0;

export function binanceBannedUntil() {
  return bannedUntil > Date.now() ? bannedUntil : 0;
}

export function isBinanceBanned() {
  return binanceBannedUntil() > 0;
}

export function noteBinanceBan(untilMs) {
  const n = Number(untilMs) || 0;
  if (n > bannedUntil) bannedUntil = n;
}

function throwIfBanned(signal) {
  if (signal?.aborted) throw abortError();
  const until = binanceBannedUntil();
  if (!until) return;
  if (loggedBanUntil !== until) {
    loggedBanUntil = until;
    console.error(
      `[binance] IP banned until ${new Date(until).toISOString()} — skipping REST`
    );
  }
  const err = new Error(
    `Binance IP banned until ${new Date(until).toISOString()}. Wait, then retry.`
  );
  err.status = 418;
  throw err;
}

/**
 * @param {string} url
 * @param {{ weight?: number, minGapMs?: number, signal?: AbortSignal, label?: string }} [opts]
 * @returns {Promise<Response>}
 */
export function binanceFetch(url, opts = {}) {
  const {
    minGapMs = 250,
    signal = null,
    label = "rest",
  } = opts;

  const run = async () => {
    throwIfBanned(signal);
    const wait = Math.max(0, nextAt - Date.now());
    if (wait) await sleep(wait, signal);

    throwIfBanned(signal);
    const res = await fetch(url, signal ? { signal } : undefined);

    const used = Number(res.headers.get("x-mbx-used-weight-1m"));
    let gap = minGapMs;
    if (Number.isFinite(used) && used > 0) {
      if (used >= 2200) gap = Math.max(gap, 25_000);
      else if (used >= 1800) gap = Math.max(gap, 8_000);
      else if (used >= 1400) gap = Math.max(gap, 1_500);
    }

    if (res.status === 418) {
      const text = await res.text();
      const until = parseBinanceBanUntil(text) || Date.now() + 15 * 60_000;
      noteBinanceBan(until);
      nextAt = Math.max(nextAt, until);
      const err = new Error(`${label} HTTP 418: ${text.slice(0, 240)}`);
      err.status = 418;
      throw err;
    }

    if (res.status === 429) {
      const text = await res.text();
      const retryAfter = Number(res.headers.get("retry-after"));
      const extra =
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 12_000;
      nextAt = Date.now() + extra;
      const err = new Error(`${label} HTTP 429: ${text.slice(0, 240)}`);
      err.status = 429;
      err.retryable = true;
      throw err;
    }

    nextAt = Date.now() + gap;
    return res;
  };

  const p = queue.then(run, run);
  queue = p.then(
    () => {},
    () => {}
  );
  return p;
}
