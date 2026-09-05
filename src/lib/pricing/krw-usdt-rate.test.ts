import assert from "node:assert/strict";
import test from "node:test";
import { KRW_USDT_ADJUSTMENT, parseNaverUsdtKrw } from "./krw-usdt-rate";

test("uses the latest Naver Bithumb USDT/KRW candle and applies the approved adjustment", () => {
  const rate = parseNaverUsdtKrw({
    isSuccess: true,
    result: [
      { closePrice: 1_370, lastTradeAt: "2026-09-05T00:00:00Z" },
      { closePrice: 1_371, lastTradeAt: "2026-09-05T00:15:00Z" },
    ],
  }, "2026-09-05T00:16:00Z");
  assert.equal(rate.rawKrwPerUsdt, 1_371);
  assert.equal(rate.adjustmentKrw, KRW_USDT_ADJUSTMENT);
  assert.equal(rate.effectiveKrwPerUsd, 1_362);
  assert.equal(rate.source, "naver-bithumb");
});

test("rejects a malformed Naver response", () => {
  assert.throws(() => parseNaverUsdtKrw({ isSuccess: true, result: [] }));
});
