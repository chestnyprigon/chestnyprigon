import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ListingCard } from "@/components/mobile-de/MobileDeCatalog";
import { MobileDeDossier } from "@/components/mobile-de/MobileDeDossier";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import { fetchNbrbRates } from "@/lib/pricing/nbrb-rates";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Локальный предпросмотр каталога Европы",
  robots: { index: false, follow: false },
};

const gallery = (urls: string[]) => urls.map((url, position) => ({ url, position, sort_order: position }));

const listings: MobileDeListing[] = [
  {
    master_id: "local-europe-52267991619008",
    source: "mobile_de",
    source_id: "52267991619008",
    title: "Mercedes-Benz GLA 200 d Progressive",
    make: "Mercedes-Benz",
    model: "GLA 200 d",
    first_registration: { value: "2025-07", precision: "month" },
    mileage_km: 7_442,
    engine_cc: 1_950,
    power: { value: 150, unit: "PS", label_ru: "л. с." },
    price: { amount: 32_990, currency: "EUR", type: "original_asking" },
    net_price: { amount: 27_722.69, currency: "EUR", type: "source_netto", basis: "netto", status: "source_reported", source_path: "price.nt.amount" },
    primary_image: { url: "https://img.classistatic.de/api/v1/mo-prod/images/46/461d36e7-421f-43b2-8b2a-0ae4311528c2?rule=mo-1600.jpg", position: 0, is_primary: true },
    gallery: gallery([
      "https://img.classistatic.de/api/v1/mo-prod/images/46/461d36e7-421f-43b2-8b2a-0ae4311528c2?rule=mo-1600.jpg",
      "https://img.classistatic.de/api/v1/mo-prod/images/ac/ac3cc0a6-fabf-4020-8b7d-d0bb03b1322e?rule=mo-1600.jpg",
      "https://img.classistatic.de/api/v1/mo-prod/images/85/854af688-56ac-4740-99e0-c78f3c655a72?rule=mo-1600.jpg",
    ]),
    freshness: { availability: "unknown" },
    fuel_type: "Дизель",
    transmission: "Автоматическая коробка передач",
    drive: null,
    body_type: "Внедорожник",
    color: null,
    options: [],
  },
  {
    master_id: "local-europe-52267913575488",
    source: "mobile_de",
    source_id: "52267913575488",
    title: "Mercedes-Benz B 180 Progressive",
    make: "Mercedes-Benz",
    model: "B 180",
    first_registration: { value: "2025-08", precision: "month" },
    mileage_km: 5_052,
    engine_cc: 1_332,
    power: { value: 136, unit: "PS", label_ru: "л. с." },
    price: { amount: 26_885, currency: "EUR", type: "original_asking" },
    net_price: { amount: 22_592.44, currency: "EUR", type: "source_netto", basis: "netto", status: "source_reported", source_path: "price.nt.amount" },
    primary_image: { url: "https://img.classistatic.de/api/v1/mo-prod/images/8a/8a0f6480-3762-49ec-bfc2-d0a879ac2bd2?rule=mo-1600.jpg", position: 0, is_primary: true },
    gallery: gallery([
      "https://img.classistatic.de/api/v1/mo-prod/images/8a/8a0f6480-3762-49ec-bfc2-d0a879ac2bd2?rule=mo-1600.jpg",
      "https://img.classistatic.de/api/v1/mo-prod/images/8a/8a284a98-e0ea-4c2d-bb8e-4581f2d6e0b1?rule=mo-1600.jpg",
      "https://img.classistatic.de/api/v1/mo-prod/images/8f/8f475d08-8f3f-4bdd-8977-ad2721f8f4e5?rule=mo-1600.jpg",
    ]),
    freshness: { availability: "unknown" },
    fuel_type: "Бензин",
    transmission: "Автоматическая коробка передач",
    drive: null,
    body_type: "Компактвэн",
    color: null,
    options: [],
  },
  {
    master_id: "local-europe-52267743980992",
    source: "mobile_de",
    source_id: "52267743980992",
    title: "Mercedes-Benz B 180 d Progressive Advanced",
    make: "Mercedes-Benz",
    model: "B 180 d",
    first_registration: { value: "2025-07", precision: "month" },
    mileage_km: 6_162,
    engine_cc: 1_950,
    power: { value: 116, unit: "PS", label_ru: "л. с." },
    price: { amount: 25_590, currency: "EUR", type: "original_asking" },
    net_price: { amount: 21_504.20, currency: "EUR", type: "source_netto", basis: "netto", status: "source_reported", source_path: "price.nt.amount" },
    primary_image: { url: "https://img.classistatic.de/api/v1/mo-prod/images/39/39db94b6-9a38-435a-81fb-2694a476cfea?rule=mo-1600.jpg", position: 0, is_primary: true },
    gallery: gallery([
      "https://img.classistatic.de/api/v1/mo-prod/images/39/39db94b6-9a38-435a-81fb-2694a476cfea?rule=mo-1600.jpg",
      "https://img.classistatic.de/api/v1/mo-prod/images/ac/ac3cc0a6-fabf-4020-8b7d-d0a879ac2bd2?rule=mo-1600.jpg",
      "https://img.classistatic.de/api/v1/mo-prod/images/85/854af688-56ac-4740-99e0-c78f3c655a72?rule=mo-1600.jpg",
    ]),
    freshness: { availability: "unknown" },
    fuel_type: "Дизель",
    transmission: "Автоматическая коробка передач",
    drive: null,
    body_type: "Компактвэн",
    color: null,
    options: [],
  },
];

export default async function EuropePricePreviewPage() {
  if (process.env.NODE_ENV !== "development") notFound();

  let exchangeRates: ExchangeRates | null = null;
  try {
    exchangeRates = await fetchNbrbRates();
  } catch {
    exchangeRates = null;
  }

  return <>
    <section style={{ maxWidth: 1240, margin: "24px auto", padding: "0 24px" }}>
      <h1 style={{ margin: "0 0 16px", fontSize: 26 }}>Каталог Европы</h1>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 16 }}>
        {listings.map((listing) => <ListingCard key={listing.master_id} listing={listing} exchangeRates={exchangeRates} detailHref="#europe-price-details" />)}
      </div>
    </section>
    <MobileDeDossier listing={listings[0]} id="europe-price-details" />
  </>;
}
