import test from "node:test";
import assert from "node:assert/strict";
import { equipmentOptionsFromCodes } from "../../src/data/equipment";

test("converts standard Encar option codes to readable equipment", () => {
  assert.deepEqual(equipmentOptionsFromCodes(["010", "075", "010", "unknown"]), [
    { name: "Люк", priceKrw: null, description: "Стандартная комплектация Encar" },
    { name: "LED-фары", priceKrw: null, description: "Стандартная комплектация Encar" },
  ]);
});
