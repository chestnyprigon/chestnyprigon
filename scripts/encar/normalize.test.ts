import assert from "node:assert/strict";
import test from "node:test";
import { normalizeListing } from "./normalize";

test("normalizes canonical identity, registration month, price and ordered photos", () => {
  const vehicle = normalizeListing({
    fetchedAt: "2026-08-09T00:00:00.000Z",
    search: {
      Id: "advertisement-22",
      Manufacturer: "현대",
      Model: "그랜저",
      Year: 202403,
      Mileage: 18_500,
      Price: 3200,
      FuelType: "가솔린",
    },
    detail: {
      vehicleId: "vehicle-11",
      vin: "KMHABCDEFGH123456",
      category: {
        manufacturerName: "현대",
        modelName: "더 뉴 그랜저",
        modelGroupEnglishName: "Grandeur",
        yearMonth: "202403",
      },
      advertisement: { price: 3200 },
      spec: { mileage: 18_500, fuelName: "가솔린" },
      photos: [
        { path: "/inner.jpg", type: "INNER", code: "002" },
        { path: "/outer.jpg", type: "OUTER", code: "001" },
      ],
    },
  });

  assert.equal(vehicle.sourceListingId, "vehicle-11");
  assert.equal(vehicle.sourceUrl.includes("advertisement-22"), true);
  assert.equal(vehicle.manufacturer, "Hyundai");
  assert.equal(vehicle.model, "Grandeur");
  assert.equal(vehicle.firstRegistrationDate, "2024-03-01");
  assert.equal(vehicle.priceKrw, 32_000_000);
  assert.deepEqual(vehicle.imageUrls, [
    "https://ci.encar.com/outer.jpg",
    "https://ci.encar.com/inner.jpg",
  ]);
  assert.equal(vehicle.vinMasked?.endsWith("3456"), true);
});
