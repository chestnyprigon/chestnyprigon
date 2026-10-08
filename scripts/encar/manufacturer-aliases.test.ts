import assert from "node:assert/strict";
import test from "node:test";
import { primaryManufacturerAlias } from "./manufacturer-aliases";

test("KGM search uses the Encar label verified by the live catalog endpoint", () => {
  assert.equal(primaryManufacturerAlias("KGM"), "KG모빌리티(쌍용)");
});
