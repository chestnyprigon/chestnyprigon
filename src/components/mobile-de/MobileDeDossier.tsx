import Link from "next/link";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { mobileDeSpecifications } from "@/lib/mobile-de/specifications";
import { fetchNbrbRates } from "@/lib/pricing/nbrb-rates";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import { CatalogNavigation } from "./CatalogNavigation";
import { MobileDeGallery } from "./MobileDeGallery";
import { MobileDePriceCalculator } from "./MobileDePriceCalculator";
import { loadRussiaPriceSnapshotsOrCalculate } from "@/lib/pricing/russia-price-snapshots";
import type { RussiaPriceResult } from "@/lib/pricing/russia-pricing";

function optionsList(options: MobileDeListing["options"]) {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option === "string") return [option];
    const value = [option.name, option.value].filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join(": ");
    return value ? [value] : [];
  }).filter((value) => !/^(?:стоимость в ЕС без расчетов|итоговый расч[её]т в ходе консультации с менеджером)\.?$/i.test(value.trim()));
}

function galleryImages(listing: MobileDeListing) {
  const candidates = [listing.primary_image, ...(listing.gallery ?? [])].filter(
    (image): image is NonNullable<MobileDeListing["primary_image"]> => Boolean(image?.url),
  );
  const unique = new Map(candidates.map((image) => [image.url, image]));
  return [...unique.values()].sort((a, b) => (a.sort_order ?? a.position ?? 0) - (b.sort_order ?? b.position ?? 0));
}

function russiaInputForListing(listing: MobileDeListing) {
  const amount = listing.net_price?.amount ?? listing.price?.amount;
  if (typeof amount !== "number" || amount <= 0) return null;
  const powerValue = listing.power?.value;
  const powerIsKw = /kw/i.test(`${listing.power?.unit ?? ""} ${listing.power?.label_ru ?? ""}`);
  return {
    source: "europe" as const, sourceId: listing.master_id, brand: listing.make ?? "",
    model: listing.model ?? listing.title, year: Number(listing.first_registration?.value?.slice(0, 4)) || null,
    firstRegistration: listing.first_registration?.value, engineCc: listing.engine_cc,
    fuelType: listing.fuel_type, driveType: listing.drive, price: amount, currency: "EUR" as const,
    powerKw: powerValue && powerIsKw ? powerValue : undefined,
    powerPs: powerValue && !powerIsKw ? powerValue : undefined,
  };
}

export async function MobileDeDossier({ listing, id, destination = "by", currency = "USD" }: { listing: MobileDeListing; id?: string; destination?: "by" | "ru"; currency?: "USD" | "BYN" | "RUB" | "EUR" }) {
  const options = optionsList(listing.options);
  const gallery = galleryImages(listing);
  const title = listing.title || [listing.make, listing.model].filter(Boolean).join(" ") || "Автомобиль из Европы";
  const specs = mobileDeSpecifications(listing);
  let exchangeRates: ExchangeRates | null = null;
  let russiaCalculation: RussiaPriceResult | null = null;
  if (destination === "by") { try { exchangeRates = await fetchNbrbRates(); } catch { exchangeRates = null; } }
  else {
    const vehicle = listing.transport_class === "VAN" ? null : russiaInputForListing(listing);
    if (vehicle) russiaCalculation = (await loadRussiaPriceSnapshotsOrCalculate("europe", [{ listingId: listing.master_id, vehicle }])).get(listing.master_id) ?? null;
  }

  return (
    <main id={id} className="dossier-page">
      <CatalogNavigation />
      <div className="dossier-contextbar"><Link href={`/catalog/europe?destination=${destination}&currency=${currency}`}><ArrowLeft size={16} />К каталогу</Link></div>
      <section className="dossier-layout">
        <div className="dossier-content">
          <section className="dossier-vehicle-heading"><div><p>Автомобиль из Европы · Mobile.de</p><h1>{[listing.make, listing.model].filter(Boolean).join(" ") || title}</h1>{title !== [listing.make, listing.model].filter(Boolean).join(" ") && <h2>{title}</h2>}</div></section>
          <section className="dossier-gallery"><MobileDeGallery images={gallery.map((image) => image.url)} title={title} /></section>
          <section className="dossier-card"><h2>Общие данные</h2><div className="dossier-spec-cards">{specs.slice(0, 4).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div><div className="dossier-lines">{specs.slice(4).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div></section>
          {options.length > 0 && <section className="dossier-card"><h2>{listing.transport_class === "VAN" ? "Комплектация и данные автомобиля" : "Комплектация и опции"}</h2><div className="dossier-options"><details><summary><span><b>Опции автомобиля</b><small>{options.length} пунктов</small></span><ChevronDown size={18} /></summary><div>{options.map((option, index) => <article key={`${index}-${option}`}><span className="equipment-mark">✓</span><span>{option}</span></article>)}</div></details></div></section>}
        </div>
        <MobileDePriceCalculator listing={listing} exchangeRates={exchangeRates} destination={destination} currency={currency} russiaCalculation={russiaCalculation} />
      </section>
    </main>
  );
}
