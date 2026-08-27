import assert from "node:assert/strict";
import test from "node:test";
import { createDomesticQuery } from "./client";
import { ENCAR_MAX_MILEAGE_KM, ENCAR_MIN_VEHICLE_AGE_YEARS, encarYearFrom } from "./config";

test("uses the customer-confirmed seven-year and mileage limits", () => {
  const yearTo = 2026;
  const query = createDomesticQuery(encarYearFrom(yearTo), yearTo, ENCAR_MAX_MILEAGE_KM);

  assert.equal(ENCAR_MIN_VEHICLE_AGE_YEARS, 7);
  assert.match(query, /Year\.range\(201900\.\.202699\)/);
  assert.match(query, /Mileage\.range\(\.\.190000\)/);
  assert.match(createDomesticQuery(encarYearFrom(yearTo), yearTo, ENCAR_MAX_MILEAGE_KM, "N"), /CarType\.N/);
  assert.match(createDomesticQuery(encarYearFrom(yearTo), yearTo, ENCAR_MAX_MILEAGE_KM, "Y", "BMW"), /Manufacturer\.BMW/);
});
