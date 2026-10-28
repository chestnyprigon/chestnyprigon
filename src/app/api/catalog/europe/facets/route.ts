import { getMobileDeFacets, MobileDeApiError } from "@/lib/mobile-de/api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const make = params.get("make") || undefined;
  if (params.getAll("make").length > 1 || (make && (make.length > 120 || /[\x00-\x1f]/.test(make)))) {
    return Response.json({error:"Некорректная марка"}, {status:400, headers:{"Cache-Control":"no-store"}});
  }
  try {
    const facets = await getMobileDeFacets(make);
    return Response.json({data:facets}, {headers:{"Cache-Control":"no-store"}});
  } catch (error) {
    const status = error instanceof MobileDeApiError && error.status === 429 ? 429 : 503;
    return Response.json({error:"Не удалось загрузить параметры поиска"},{status,headers:{"Cache-Control":"no-store"}});
  }
}
