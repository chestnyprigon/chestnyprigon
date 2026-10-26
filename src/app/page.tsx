import type { Metadata } from "next";
import { MobileDeCatalog } from "@/components/mobile-de/MobileDeCatalog";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Европейский каталог автомобилей — Честный пригон",
  description: "Объявления Mobile.de из синхронизированной Master DB.",
  robots: { index: false, follow: false },
};

export default function Home({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <MobileDeCatalog searchParams={searchParams} />;
}
