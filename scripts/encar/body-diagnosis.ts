export type BodyFinding = {
  code: string;
  title: string;
  statuses: Array<{ code: string; title: string }>;
};

export type BodyDiagnosis = {
  findings: BodyFinding[];
  notes: string[];
};

const PARTS: Record<string, { code: string; title: string }> = {
  FRONT_BUMPER: { code: "P011", title: "Передний бампер" },
  BACK_BUMPER: { code: "P012", title: "Задний бампер" },
  FRONT_FENDER_LEFT: { code: "P021", title: "Переднее левое крыло" },
  FRONT_FENDER_RIGHT: { code: "P022", title: "Переднее правое крыло" },
  FRONT_DOOR_LEFT: { code: "P031", title: "Передняя левая дверь" },
  FRONT_DOOR_RIGHT: { code: "P032", title: "Передняя правая дверь" },
  BACK_DOOR_LEFT: { code: "P033", title: "Задняя левая дверь" },
  BACK_DOOR_RIGHT: { code: "P034", title: "Задняя правая дверь" },
  TRUNK_LID: { code: "P041", title: "Крышка багажника" },
  HOOD: { code: "P042", title: "Капот" },
  SIDE_SILL_LEFT: { code: "P051", title: "Левый порог" },
  SIDE_SILL_RIGHT: { code: "P052", title: "Правый порог" },
  ROOF: { code: "P061", title: "Крыша" },
};

const MARKS: Record<string, { code: string; title: string }> = {
  REPLACEMENT: { code: "X", title: "Замена" },
  REPAIR: { code: "W", title: "Ремонт" },
  SCRATCH: { code: "A", title: "Царапина" },
  CORROSION: { code: "C", title: "Коррозия" },
  DEFORMATION: { code: "U", title: "Деформация" },
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;

export function parseBodyDiagnosis(payload: unknown): BodyDiagnosis {
  const root = object(payload);
  const items = Array.isArray(root.items) ? root.items : [];
  const findings = new Map<string, BodyFinding>();
  const notes: string[] = [];

  for (const item of items) {
    const value = object(item);
    const name = text(value.name);
    const result = text(value.result);
    const resultCode = text(value.resultCode)?.toUpperCase() ?? "";
    if (!name || !result) continue;
    if (name === "CHECKER_COMMENT" || name === "OUTER_PANEL_COMMENT") {
      if (/외부패널.*교환|교환.*외부패널/.test(result)) {
        const part = /앞문\(우\)/.test(result) ? "правой передней двери" : "наружной панели";
        const frame = /프레임.{0,50}정상/.test(result)
          ? "силовая структура указана как исправная"
          : "связанный силовой элемент не указан как заменённый";
        notes.push(`Encar: замена ${part}; ${frame}.`);
      }
      continue;
    }
    if (resultCode === "NORMAL") continue;
    const part = PARTS[name];
    if (!part) continue;
    const mark = MARKS[resultCode] ?? { code: "T", title: result };
    const finding = findings.get(part.code) ?? { ...part, statuses: [] };
    if (!finding.statuses.some((status) => status.code === mark.code && status.title === mark.title)) {
      finding.statuses.push(mark);
    }
    findings.set(part.code, finding);
  }

  return { findings: [...findings.values()], notes: [...new Set(notes)] };
}
