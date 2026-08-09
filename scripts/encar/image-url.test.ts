import assert from "node:assert/strict";
import test from "node:test";
import { encarPhotoUrl } from "../../src/lib/encar/images";

test("upgrades legacy Encar image paths to the official 1280px policy endpoint", () => {
  const url = encarPhotoUrl("https://ci.encar.com/carpicture10/pic4250/42506446_001.jpg");
  assert.equal(url.startsWith("https://ci.encar.com/carpicture/carpicture10/pic4250/42506446_001.jpg?"), true);
  assert.equal(url.includes("rh=768"), true);
  assert.equal(url.includes("cw=1280"), true);
});

test("keeps non-vehicle Encar paths unchanged", () => {
  assert.equal(encarPhotoUrl("https://ci.encar.com/outer.jpg"), "https://ci.encar.com/outer.jpg");
});
