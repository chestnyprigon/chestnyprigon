import assert from "node:assert/strict";
import test from "node:test";
import { orderImagesByReport } from "../../src/lib/catalog/photo-order";

test("restores the Encar report photo order for cards already in the catalog", () => {
  const imageUrls = [
    "https://ci.encar.com/rear.jpg",
    "https://ci.encar.com/cabin.jpg",
    "https://ci.encar.com/front.jpg",
    "https://ci.encar.com/unlisted.jpg",
  ];
  const report = {
    photoGroups: [
      { url: "https://ci.encar.com/front.jpg", group: "Кузов" },
      { url: "https://ci.encar.com/rear.jpg", group: "Кузов" },
      { url: "https://ci.encar.com/cabin.jpg", group: "Салон" },
    ],
  };

  assert.deepEqual(orderImagesByReport(report, imageUrls), [
    "https://ci.encar.com/front.jpg",
    "https://ci.encar.com/rear.jpg",
    "https://ci.encar.com/cabin.jpg",
    "https://ci.encar.com/unlisted.jpg",
  ]);
});

test("keeps existing image order if the report has no saved photo ordering", () => {
  const images = ["https://ci.encar.com/a.jpg", "https://ci.encar.com/b.jpg"];
  assert.deepEqual(orderImagesByReport({}, images), images);
});
