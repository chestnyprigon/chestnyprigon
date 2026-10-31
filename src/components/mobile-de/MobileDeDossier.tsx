import Link from "next/link";
import { mobileDeSpecifications } from "@/lib/mobile-de/specifications";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import { CatalogNavigation } from "./CatalogNavigation";
import { MobileDeGallery } from "./MobileDeGallery";
import styles from "./MobileDeCatalog.module.css";

function sourceUrl(sourceId: string) {
  const url = new URL("https://suchen.mobile.de/fahrzeuge/details.html");
  url.searchParams.set("id", sourceId);
  return url.toString();
}

function formatMoney(listing: MobileDeListing) {
  const amount = listing.price?.amount;
  if (typeof amount !== "number") return "Цена уточняется";
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: listing.price?.currency || "EUR",
    maximumFractionDigits: 0,
  }).format(amount);
}

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

export function MobileDeDossier({ listing }: { listing: MobileDeListing }) {
  const options = optionsList(listing.options);
  const gallery = galleryImages(listing);
  const title = listing.title || [listing.make, listing.model].filter(Boolean).join(" ") || "Автомобиль из Европы";
  const availability = listing.freshness?.availability === "unknown"
    ? "Продавец не подтвердил актуальность объявления"
    : "Статус объявления уточняется";

  const specs = mobileDeSpecifications(listing);

  return (
    <main className={`${styles.page} ${styles.detailPage}`}>
      <CatalogNavigation />
      <Link href="/catalog/europe" className={styles.backLink}>← Вернуться к объявлениям</Link>
      <div className={styles.detailGrid}>
        <section>
          <MobileDeGallery images={gallery.map((image) => image.url)} title={title} />
          {options.length > 0 && <div className={styles.detailOptions}><strong>Комплектация и опции</strong><ul>{options.map((option, index) => <li key={`${index}-${option}`}>{option}</li>)}</ul></div>}
        </section>
        <aside className={styles.detailCard}>
          <span className={styles.eyebrow}>АВТОМОБИЛЬ ИЗ ЕВРОПЫ</span>
          <h1>{title}</h1>
          <p className={styles.detailPrice}>{formatMoney(listing)}</p>
          <p className={styles.filterFootnote}>Цена продавца в Европе. Доставка, таможня и услуги рассчитываются отдельно.</p><p className={styles.filterFootnote}>{availability}</p>
          <dl className={styles.detailSpecs}>
            {specs.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <Link className={styles.sourceButton} href="/#contacts">Рассчитать доставку и получить консультацию</Link>
          <a className={styles.secondaryButton} href={sourceUrl(listing.source_id)} target="_blank" rel="noreferrer">Открыть объявление на mobile.de ↗</a>
        </aside>
      </div>
    </main>
  );
}
