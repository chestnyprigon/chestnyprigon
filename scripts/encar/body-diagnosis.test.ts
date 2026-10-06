import assert from "node:assert/strict";
import test from "node:test";
import { parseBodyDiagnosis } from "./body-diagnosis";

test("maps Encar replacement diagnosis to the matching body panel and preserves frame note", () => {
  const result = parseBodyDiagnosis({ items: [
    { name: "FRONT_DOOR_RIGHT", result: "교환", resultCode: "REPLACEMENT" },
    { name: "HOOD", result: "정상", resultCode: "NORMAL" },
    { name: "CHECKER_COMMENT", result: "본 차량은 엔카의 진단 결과 외부패널부의 앞문(우)가 교환되었으며, 프레임(주요 골격) 부위는 모든 항목이 정상으로 확인되어, 외부패널 단순교환 차량으로 진단 판정 합니다.", resultCode: null },
    { name: "OUTER_PANEL_COMMENT", result: "외부패널 확인 결과 앞문(우)가 교환되었으며 관련 프레임 교환은 없습니다.", resultCode: null },
  ] });
  assert.deepEqual(result.findings, [{
    code: "P032",
    title: "Передняя правая дверь",
    statuses: [{ code: "X", title: "Замена" }],
  }]);
  assert.deepEqual(result.notes, [
    "Encar: замена правой передней двери; силовая структура указана как исправная.",
    "Encar: замена правой передней двери; связанный силовой элемент не указан как заменённый.",
  ]);
});

test("returns no findings for a complete diagnosis with all panels normal", () => {
  const result = parseBodyDiagnosis({ items: [
    { name: "FRONT_DOOR_RIGHT", result: "정상", resultCode: "NORMAL" },
  ] });
  assert.deepEqual(result, { findings: [], notes: [] });
});
