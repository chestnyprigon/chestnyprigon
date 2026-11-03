import { getMobileDeCount, MobileDeApiError } from "@/lib/mobile-de/api";
import { parseMobileDeFilters } from "@/lib/mobile-de/filters";

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const search = [...params.entries()].reduce<Record<string, string | string[]>>((result, [key, value]) => {
    const existing = result[key];
    result[key] = existing === undefined ? value : Array.isArray(existing) ? [...existing, value] : [existing, value];
    return result;
  }, {});
  const parsed = parseMobileDeFilters(search);
  if (!parsed.valid) {
    return Response.json({ error: "Некорректные параметры фильтра" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const count = await getMobileDeCount(parsed.filters);
    return Response.json({ count }, { headers: { "Cache-Control": "private, max-age=0, must-revalidate" } });
  } catch (error) {
    const status = error instanceof MobileDeApiError && error.status === 429 ? 429 : 503;
    return Response.json({ error: "Не удалось посчитать объявления" }, { status, headers: { "Cache-Control": "no-store" } });
  }
}
