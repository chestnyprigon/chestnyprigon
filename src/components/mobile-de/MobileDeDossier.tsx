/* eslint-disable @next/next/no-img-element -- gallery image hosts are supplied by Master DB and are not fixed at build time. */
import Link from "next/link";
import type { MobileDeListing } from "@/lib/mobile-de/types";
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

function formatNumber(value: number | null | undefined, suffix = "") {
  if (typeof value !== "number" || !Number.isFinite(value)) return "Не указано";
  return `${new Intl.NumberFormat("ru-RU").format(value)}${suffix}`;
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
  const registration = listing.first_registration?.value;
  const power = listing.power?.value == null
    ? "Не указана"
    : `${formatNumber(listing.power.value)} ${listing.power.label_ru || listing.power.unit || "л. с."}`;
  const availability = listing.freshness?.availability === "unknown"
    ? "Продавец не подтвердил актуальность объявления"
    : "Статус объявления уточняется";

  const specs: Array<[string, string]> = [
    ["Год выпуска", listing.production_year ? String(listing.production_year) : "Не указан"],
    ["Первая регистрация", registration || "Не указана"],
    ["Пробег", formatNumber(listing.mileage_km, " км")],
    ["Объём двигателя", formatNumber(listing.engine_cc, " см³")],
    ["Мощность", power],
    ["Топливо", listing.fuel_type || "Не указано"],
    ["Коробка передач", listing.transmission || "Не указана"],
    ["Привод", listing.drive || "Не указан"],
    ["Кузов", listing.body_type || "Не указан"],
    ["Цвет", listing.color || "Не указан"],
  ];

  return (
    <main className={`${styles.page} ${styles.detailPage}`}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand}><span className={styles.brandMark}>ЧП</span><span>Честный пригон<small>ЕВРОПЕЙСКИЙ КАТАЛОГ</small></span></Link>
        <a className={styles.headerLink} href="https://chestnyprigon.com" rel="noreferrer">Основной сайт ↗</a>
      </header>
      <Link href="/catalog/europe" className={styles.backLink}>← Вернуться к объявлениям</Link>
      <div className={styles.detailGrid}>
        <section>
          <div className={styles.gallery}>
            {gallery.length ? gallery.map((image) => <img src={image.url} alt={title} key={image.url} loading="lazy" />) : <div className={styles.noImage}>Фотографии не указаны</div>}
          </div>
          {listing.description && <div className={styles.detailDescription}>{listing.description}</div>}
          {options.length > 0 && <div className={styles.detailOptions}><strong>Комплектация и опции</strong><ul>{options.map((option, index) => <li key={`${index}-${option}`}>{option}</li>)}</ul></div>}
        </section>
        <aside className={styles.detailCard}>
          <span className={styles.eyebrow}>MOBILE.DE · MASTER DB</span>
          <h1>{title}</h1>
          <p className={styles.detailPrice}>{formatMoney(listing)}</p>
          <p className={styles.filterFootnote}>{availability}</p>
          <dl className={styles.detailSpecs}>
            {specs.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
          </dl>
          <a className={styles.sourceButton} href={sourceUrl(listing.source_id)} target="_blank" rel="noreferrer">Открыть объявление на mobile.de ↗</a>
        </aside>
      </div>
    </main>
  );
}
