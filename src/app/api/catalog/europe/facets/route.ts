import { getMobileDeFacets, MobileDeApiError } from "@/lib/mobile-de/api";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const facets = await getMobileDeFacets();
    return Response.json({data:facets}, {headers:{"Cache-Control":"no-store"}});
  } catch (error) {
    const status = error instanceof MobileDeApiError && error.status === 429 ? 429 : 503;
    return Response.json({error:"Не удалось загрузить параметры поиска"},{status,headers:{"Cache-Control":"no-store"}});
  }
}
