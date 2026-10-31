import { getMobileDeFacets, MobileDeApiError } from "@/lib/mobile-de/api";
const PUBLIC_FACET_CACHE = { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300" };
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const make = params.get("make") || undefined;
  if (params.getAll("make").length > 1 || (make && (make.length > 120 || /[\x00-\x1f]/.test(make)))) {
    return Response.json({error:"Некорректная марка"}, {status:400, headers:{"Cache-Control":"no-store"}});
  }
  try {
    const facets = await getMobileDeFacets(make);
    return Response.json({data:facets}, {headers:PUBLIC_FACET_CACHE});
  } catch (error) {
    const status = error instanceof MobileDeApiError && error.status === 429 ? 429 : 503;
    return Response.json({error:"Не удалось загрузить параметры поиска"},{status,headers:{"Cache-Control":"no-store"}});
  }
}
