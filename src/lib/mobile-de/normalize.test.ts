import assert from "node:assert/strict";
import test from "node:test";
import { mobileDeText, normalizeMobileDeListing } from "./normalize";

test("translated description is rendered as text rather than a React object", () => {
  const listing = normalizeMobileDeListing({ description: { text_ru: "Автомобиль в хорошем состоянии", status: "translated", attribution: {} }, options: ["ABS", { text_ru: "Климат-контроль" }, null, { unexpected: true }] });
  assert.equal(listing.description, "Автомобиль в хорошем состоянии");
  assert.deepEqual(listing.options, ["ABS", "Климат-контроль"]);
});
test("unknown metadata never becomes display text", () => {
  assert.equal(mobileDeText({ status: "pending", generated_at: "today" }), null);
  assert.equal(mobileDeText(null), null);
  assert.equal(mobileDeText(" original text "), "original text");
});
