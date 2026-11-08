import Link from "next/link";
import { ArrowLeft, ChevronDown } from "lucide-react";
import { mobileDeSpecifications } from "@/lib/mobile-de/specifications";
import { fetchNbrbRates } from "@/lib/pricing/nbrb-rates";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import { CatalogNavigation } from "./CatalogNavigation";
import { MobileDeGallery } from "./MobileDeGallery";
import { MobileDePriceCalculator } from "./MobileDePriceCalculator";

function optionsList(options: MobileDeListing["options"]) {
  if (!Array.isArray(options)) return [];
  return options.flatMap((option) => {
    if (typeof option === "string") return [option];
    const value = [option.name, option.value].filter((part): part is string => typeof part === "string" && Boolean(part.trim())).join(": ");
    return value ? [value] : [];
  });
}

function galleryImages(listing: MobileDeListing) {
  const candidates = [listing.primary_image, ...(listing.gallery ?? [])].filter(
    (image): image is NonNullable<MobileDeListing["primary_image"]> => Boolean(image?.url),
  );
  const unique = new Map(candidates.map((image) => [image.url, image]));
  return [...unique.values()].sort((a, b) => (a.sort_order ?? a.position ?? 0) - (b.sort_order ?? b.position ?? 0));
}

export async function MobileDeDossier({ listing, id }: { listing: MobileDeListing; id?: string }) {
  const options = optionsList(listing.options);
  const gallery = galleryImages(listing);
  const title = listing.title || [listing.make, listing.model].filter(Boolean).join(" ") || "Автомобиль из Европы";
  const specs = mobileDeSpecifications(listing);
  let exchangeRates: ExchangeRates | null = null;
  try { exchangeRates = await fetchNbrbRates(); } catch { exchangeRates = null; }

  return (
    <main id={id} className="dossier-page">
      <CatalogNavigation />
      <div className="dossier-contextbar"><Link href="/catalog/europe"><ArrowLeft size={16} />К каталогу</Link></div>
      <section className="dossier-layout">
        <div className="dossier-content">
          <section className="dossier-vehicle-heading"><div><p>Автомобиль из Европы · Mobile.de</p><h1>{[listing.make, listing.model].filter(Boolean).join(" ") || title}</h1>{title !== [listing.make, listing.model].filter(Boolean).join(" ") && <h2>{title}</h2>}</div><div className="dossier-vehicle-facts">{specs.slice(0, 4).map(([label, value]) => <span key={label}>{label}: {value}</span>)}</div></section>
          <section className="dossier-gallery"><MobileDeGallery images={gallery.map((image) => image.url)} title={title} /></section>
          <section className="dossier-card"><h2>Общие данные</h2><div className="dossier-spec-cards">{specs.slice(0, 4).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div><div className="dossier-lines">{specs.slice(4).map(([label, value]) => <div key={label}><span>{label}</span><b>{value}</b></div>)}</div></section>
          {options.length > 0 && <section className="dossier-card"><h2>Комплектация и опции</h2><div className="dossier-options"><details><summary><span><b>Опции автомобиля</b><small>{options.length} пунктов</small></span><ChevronDown size={18} /></summary><div>{options.map((option, index) => <article key={`${index}-${option}`}><span className="equipment-mark">✓</span><span>{option}</span></article>)}</div></details></div></section>}
        </div>
        {listing.vehicle_class === "VAN" || !listing.net_price || listing.net_price.status !== "source_reported" ? (
          <aside className="dossier-price-source" aria-label="Исходная цена объявления">
            <p>Цена в Европе</p>
            <strong>{typeof (listing.source_price?.amount ?? listing.price?.amount) === "number"
              ? new Intl.NumberFormat("ru-RU", { style: "currency", currency: listing.source_price?.currency || "EUR", maximumFractionDigits: 0 }).format((listing.source_price?.amount ?? listing.price?.amount)!)
              : "Не указана"}</strong>
            {listing.source_price?.basis === "gross" && <small>Brutto по объявлению Mobile.de. Стоимость доставки и оформления не рассчитана.</small>}
          </aside>
        ) : <MobileDePriceCalculator listing={listing} exchangeRates={exchangeRates} />}
      </section>
    </main>
  );
}
