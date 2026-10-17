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
        gradeEnglishName: "Gasoline 2.5 4WD",
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
  assert.equal(vehicle.driveType, "4WD");
  assert.deepEqual(vehicle.imageUrls, [
    "https://ci.encar.com/outer.jpg",
    "https://ci.encar.com/inner.jpg",
  ]);
  assert.equal(vehicle.vinMasked?.endsWith("3456"), true);
});

test("normalizes European brands and displacement fallback fields", () => {
  const vehicle = normalizeListing({
    fetchedAt: "2026-08-09T00:00:00.000Z",
    search: { Id: "bmw-1", Manufacturer: "BMW", Model: "X5", Year: 202301, Mileage: 20_000, Price: 5000 },
    detail: {
      vehicleId: "bmw-1",
      category: { manufacturerName: "BMW", modelGroupEnglishName: "X5", yearMonth: "202301" },
      advertisement: { price: 5000 },
      spec: { engineVolume: "3.0 L", fuelName: "가솔린" },
      photos: Array.from({ length: 5 }, (_, index) => ({ path: `/photo_${index}.jpg` })),
    },
  });
  assert.equal(vehicle.manufacturer, "BMW");
  assert.equal(vehicle.engineCc, 3000);
});

test("uses Encar's listed photo ordering and preserves source order within exterior photos", () => {
  const vehicle = normalizeListing({
    fetchedAt: "2026-08-09T00:00:00.000Z",
    search: {
      Id: "photo-order-1", Manufacturer: "현대", Model: "쏘나타", Year: 202001, Mileage: 20_000, Price: 1500,
      Photos: [
        { location: "/front.jpg", ordering: 2 },
        { location: "/rear.jpg", ordering: 1 },
        { location: "/cabin.jpg", ordering: 3 },
      ],
    },
    detail: {
      vehicleId: "photo-order-1",
      category: { manufacturerName: "현대", modelGroupEnglishName: "Sonata", yearMonth: "202001" },
      advertisement: { price: 1500 },
      spec: { mileage: 20_000, fuelName: "가솔린" },
      photos: [
        { path: "/front.jpg", type: "OUTER", code: "027" },
        { path: "/rear.jpg", type: "OUTER", code: "002" },
        { path: "/cabin.jpg", type: "INNER", code: "001" },
      ],
    },
  });
  assert.deepEqual(vehicle.imageUrls, [
    "https://ci.encar.com/rear.jpg",
    "https://ci.encar.com/front.jpg",
    "https://ci.encar.com/cabin.jpg",
  ]);
});

test("does not sort Encar exterior photos lexically by their photo code", () => {
  const vehicle = normalizeListing({
    fetchedAt: "2026-08-09T00:00:00.000Z",
    search: { Id: "photo-code-1", Manufacturer: "현대", Model: "쏘나타", Year: 202001, Mileage: 20_000, Price: 1500 },
    detail: {
      vehicleId: "photo-code-1",
      category: { manufacturerName: "현대", modelGroupEnglishName: "Sonata", yearMonth: "202001" },
      advertisement: { price: 1500 },
      spec: { mileage: 20_000, fuelName: "가솔린" },
      photos: [
        { path: "/source-first.jpg", type: "OUTER", code: "027" },
        { path: "/source-second.jpg", type: "OUTER", code: "002" },
      ],
    },
  });
  assert.equal(vehicle.imageUrls[0], "https://ci.encar.com/source-first.jpg");
});
