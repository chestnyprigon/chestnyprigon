import assert from "node:assert/strict";
import test from "node:test";
import { screenListing } from "./screening";
import type { EncarBundle } from "./types";

function bundle(overrides: {
  badge?: string;
  vehicleNo?: string;
  contents?: string;
  photos?: number;
  serviceCopyCar?: string;
} = {}): EncarBundle {
  return {
    fetchedAt: "2026-08-09T00:00:00.000Z",
    search: {
      Id: "1",
      Manufacturer: "현대",
      Model: "그랜저",
      Badge: overrides.badge ?? "2.5 가솔린",
      Year: 202401,
      Mileage: 12_000,
      Price: 3500,
      ServiceCopyCar: overrides.serviceCopyCar,
    },
    detail: {
      vehicleId: 1,
      vehicleNo: overrides.vehicleNo ?? "123가4567",
      advertisement: { status: "ADVERTISE" },
      contents: { text: overrides.contents ?? null },
      condition: { seizing: { seizingCount: 0, pledgeCount: 0 } },
      photos: Array.from({ length: overrides.photos ?? 8 }, (_, index) => ({
        path: `/photo_${index}.jpg`,
      })),
    },
  };
}

test("approves a complete clean listing", () => {
  assert.equal(screenListing(bundle()).decision, "approved");
});

test("rejects lease listings", () => {
  const result = screenListing(bundle({ badge: "운용리스 승계 차량" }));
  assert.equal(result.decision, "rejected");
  assert.equal(result.isLease, true);
});

test("rejects Korean rental plates", () => {
  const result = screenListing(bundle({ vehicleNo: "123하4567" }));
  assert.equal(result.decision, "rejected");
  assert.equal(result.isRental, true);
});

test("rejects taxi and commercial keywords", () => {
  const taxi = screenListing(bundle({ badge: "부활택시" }));
  const commercial = screenListing(bundle({ badge: "어린이보호차 특장" }));
  assert.equal(taxi.isTaxi, true);
  assert.equal(taxi.decision, "rejected");
  assert.equal(commercial.isCommercial, true);
  assert.equal(commercial.decision, "rejected");
});

test("sends incomplete listings to manual review but accepts Encar technical copies", () => {
  assert.equal(screenListing(bundle({ photos: 2 })).decision, "manual_review");
  assert.equal(screenListing(bundle({ serviceCopyCar: "DUPLICATION" })).decision, "approved");
});

test("does not reject seller financing text or a negated usage history", () => {
  const result = screenListing(
    bundle({ contents: "할부 및 리스 가능. 렌트 및 영업용 이력 전혀 없음. 택시로 오세요." }),
  );
  assert.equal(result.decision, "approved");
});
