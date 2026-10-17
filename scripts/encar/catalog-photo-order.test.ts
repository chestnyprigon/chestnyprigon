import assert from "node:assert/strict";
import test from "node:test";
import { orderCatalogImages } from "../../src/lib/catalog/photo-order";
import { encarPhotoUrl } from "../../src/lib/encar/images";

const base = "https://ci.encar.com/carpicture03/pic4293/42932193";

test("BMW Z4 uses frontal 003 instead of the unordered report's key photo 042", () => {
  const images = [2, 3, 4, 42].map(code => encarPhotoUrl(`${base}_${String(code).padStart(3, "0")}.jpg`));
  const report = { photoGroups: [
    { url: `${base}_042.jpg`, group: "Детали" },
    { url: `${base}_003.jpg`, group: "Кузов" },
    { url: `${base}_004.jpg`, group: "Кузов" },
    { url: `${base}_002.jpg`, group: "Кузов" },
  ] };
  const result = orderCatalogImages(report, images);
  assert.equal(result[0], images[1]);
  assert.deepEqual(result.slice(1), [images[0], images[2], images[3]]);
  assert.deepEqual(images.map(url => Number(url.match(/_(\d{3})\./)?.[1])), [2, 3, 4, 42]);
});

test("standard 001 cover outranks rear/interior frames, even without a report", () => {
  const images = [10, 4, 3, 1].map(code => `${base}_${String(code).padStart(3, "0")}.JPG`);
  assert.equal(orderCatalogImages(null, images)[0], images[3]);
  assert.equal(orderCatalogImages({ photoGroups: [
    { url: images[0], group: "Салон" },
    { url: images[1], group: "Кузов" },
    { url: images[2], group: "Кузов" },
    { url: images[3], group: "Кузов" },
  ] }, images)[0], images[3]);
});

test("confirmed interior photos cannot outrank an exterior cover", () => {
  const images = [`${base}_001.jpg`, `${base}_003.jpg`];
  assert.equal(orderCatalogImages({ photoGroups: [
    { url: images[0], group: "Салон" },
    { url: images[1], group: "Кузов" },
  ] }, images)[0], images[1]);
  assert.deepEqual(orderCatalogImages({}, []), []);
});
