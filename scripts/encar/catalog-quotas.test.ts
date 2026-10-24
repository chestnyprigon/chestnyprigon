import assert from "node:assert/strict";
import test from "node:test";
import { APPROVED_BRAND_MIX_WEIGHTS } from "../catalog/brand-quotas";
test("approved brand-mix guidance contains unique brands with positive relative weights",()=>{
  assert.ok(APPROVED_BRAND_MIX_WEIGHTS.length > 0);
  assert.ok(APPROVED_BRAND_MIX_WEIGHTS.every((item) => Number.isInteger(item.target) && item.target > 0));
  assert.equal(new Set(APPROVED_BRAND_MIX_WEIGHTS.map((item) => item.manufacturer)).size, APPROVED_BRAND_MIX_WEIGHTS.length);
});
