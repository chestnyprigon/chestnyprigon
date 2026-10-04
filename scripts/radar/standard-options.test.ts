import assert from "node:assert/strict";
import test from "node:test";
import { encarOptionsUrl, extractStandardOptionCodes } from "./standard-options";

test("requests Encar options by advertised source listing ID", () => {
  const url = encarOptionsUrl("42817371");
  assert.equal(url.searchParams.get("vehicleIds"), "42817371");
  assert.equal(url.searchParams.get("include"), "OPTIONS");
});

test("accepts source listing response when its canonical vehicle ID matches", () => {
  assert.deepEqual(extractStandardOptionCodes([
    { vehicleId: 42810008, options: { standard: ["101", 202, "101", null] } },
  ], "42810008"), ["101", "202"]);
});

test("classifies an empty Encar result as an unavailable source listing", () => {
  assert.throws(() => extractStandardOptionCodes([], "42475063"), /source_listing_unavailable/);
});

test("rejects a response resolving to a different canonical vehicle", () => {
  assert.throws(() => extractStandardOptionCodes([
    { vehicleId: "42817371", options: { standard: ["101"] } },
  ], "42810008"), /canonical_id_mismatch/);
});
