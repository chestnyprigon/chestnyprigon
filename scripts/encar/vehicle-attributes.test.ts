import assert from "node:assert/strict";
import test from "node:test";
import { driveLabel, exteriorColorLabel, inferDriveType } from "../../src/lib/catalog/vehicle-attributes";

test("translates frequent Encar exterior color values missing from the old dictionary", () => {
  assert.equal(exteriorColorLabel("쥐색"), "Серый");
  assert.equal(exteriorColorLabel("청색"), "Синий");
  assert.equal(exteriorColorLabel("은회색"), "Серебристо-серый");
  assert.equal(exteriorColorLabel("카본블랙"), "Чёрный металлик");
  assert.equal(exteriorColorLabel(""), "Не указан");
  assert.equal(exteriorColorLabel("미분류색"), "Не указан");
});

test("maps common AWD marketing badges without guessing sDrive or unspecified trims", () => {
  for (const badge of ["xDrive", "xDrive30d", "4MATIC", "quattro", "4Motion", "HTRAC", "SH-AWD"]) {
    assert.equal(inferDriveType(badge), "4WD");
    assert.equal(driveLabel(null, `Premium ${badge}`), "Полный");
  }
  assert.equal(inferDriveType("sDrive"), null);
  assert.equal(driveLabel(null, "520d sDrive"), "Не указан");
});
