import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseBinanceBanUntil } from "./binance-rest.js";
import { lookbackForInterval } from "./history.js";

describe("parseBinanceBanUntil", () => {
  it("reads millisecond timestamps from 418 bodies", () => {
    const text =
      '{"code":-1003,"msg":"Way too many requests; IP(1.2.3.4) banned until 1789585605261. Please use the websocket."}';
    assert.equal(parseBinanceBanUntil(text), 1789585605261);
  });

  it("promotes second-precision stamps to ms", () => {
    assert.equal(parseBinanceBanUntil("banned until 1789585605"), 1789585605000);
  });

  it("returns 0 when the body has no ban stamp", () => {
    assert.equal(parseBinanceBanUntil("too many requests"), 0);
  });
});

describe("lookbackForInterval", () => {
  it("caps 30m columns at 8h", () => {
    assert.equal(lookbackForInterval(1800, 16), 8 * 3600);
  });

  it("uses column span for short intervals", () => {
    assert.equal(lookbackForInterval(5, 48), 5 * 48);
  });
});
