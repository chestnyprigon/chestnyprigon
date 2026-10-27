/* eslint-disable @next/next/no-img-element -- image hosts are supplied by Master DB and are not fixed at build time. */
import Link from "next/link";
import { MobileDeApiError, getMobileDeFacets, getMobileDeListings } from "@/lib/mobile-de/api";
import type { MobileDeFacets, MobileDeFilters, MobileDeListing } from "@/lib/mobile-de/types";
import { MobileDeFilterPanel } from "./MobileDeFilterPanel";
import { CatalogNavigation, CatalogDirections } from "./CatalogNavigation";
import styles from "./MobileDeCatalog.module.css";

const SORT_OPTIONS = [
  ["updated_desc", "Сначала новые в базе"],
  ["price_asc", "Сначала дешевле"],
  ["price_desc", "Сначала дороже"],
  ["year_desc", "Сначала новее по году"],
  ["year_asc", "Сначала старше по году"],
  ["mileage_asc", "Сначала с меньшим пробегом"],
  ["mileage_desc", "Сначала с большим пробегом"],
  ["updated_asc", "Сначала давно обновлённые"],
] as const;

const FILTER_FIELDS: Array<[keyof MobileDeFilters, string]> = [
  ["make", "Марка"], ["model", "Модель"], ["fuel_type", "Топливо"],
  ["transmission", "Коробка"], ["body_type", "Кузов"],
];

const RANGE_FIELDS: Array<[keyof MobileDeFilters, string, string]> = [
  ["price_min", "Цена от, €", "number"], ["price_max", "Цена до, €", "number"],
  ["year_min", "Год выпуска от", "number"], ["year_max", "Год выпуска до", "number"],
  ["registration_year_min", "Первая регистрация от", "number"], ["registration_year_max", "Первая регистрация до", "number"],
  ["mileage_min", "Пробег от, км", "number"], ["mileage_max", "Пробег до, км", "number"],
  ["power_min", "Мощность от, л. с.", "number"], ["power_max", "Мощность до, л. с.", "number"],
];

type SearchParams = Record<string, string | string[] | undefined>;

function getString(params: SearchParams, key: string) {
  return typeof params[key] === "string" ? params[key] as string : "";
}

function filterOptions(facets: MobileDeFacets, key: keyof MobileDeFilters): string[] {
  const values = key === "make" ? facets.makes
    : key === "model" ? facets.models
      : key === "fuel_type" ? facets.fuel_types
        : key === "transmission" ? facets.transmissions
          : key === "body_type" ? facets.body_types : undefined;
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
}

function formatNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("ru-RU").format(value) : null;
}

function registrationLabel(listing: MobileDeListing) {
  const value = listing.first_registration?.value;
  if (!value) return null;
  const [year, month] = value.split("-");
  return month ? `${month}.${year}` : year;
}

function ListingCard({ listing }: { listing: MobileDeListing }) {
  const price = listing.price?.amount;
  const currency = listing.price?.currency || "EUR";
  const priceLabel = typeof price === "number"
    ? new Intl.NumberFormat("ru-RU", { style: "currency", currency, maximumFractionDigits: 0 }).format(price)
    : "Цена уточняется";
  const specs = [
    listing.production_year ? `${listing.production_year} г.` : null,
    registrationLabel(listing) ? `Регистрация ${registrationLabel(listing)}` : null,
    listing.mileage_km != null ? `${formatNumber(listing.mileage_km)} км` : null,
    listing.power?.value != null ? `${formatNumber(listing.power.value)} ${listing.power.label_ru || listing.power.unit || "л. с."}` : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <article className={styles.card}>
      <Link className={styles.cardImage} href={`/catalog/europe/${encodeURIComponent(listing.master_id)}`} aria-label={`Открыть ${listing.title}`}>
        {listing.primary_image?.url ? <img src={listing.primary_image.url} alt={listing.title} loading="lazy" /> : <span className={styles.noImage}>Фото появится позже</span>}
        <span className={styles.countryTag}>Европа</span>
      </Link>
      <div className={styles.cardBody}>
        <div className={styles.cardTopline}>
          <span>{listing.make || "Европа"}{listing.model ? ` · ${listing.model}` : ""}</span>
          <span>{listing.freshness?.availability === "unknown" ? "Наличие не подтверждено" : "Данные Master DB"}</span>
        </div>
        <Link className={styles.cardTitle} href={`/catalog/europe/${encodeURIComponent(listing.master_id)}`}>
          {listing.title || [listing.make, listing.model].filter(Boolean).join(" ") || "Автомобиль из Европы"}
        </Link>
        {specs.length > 0 && <p className={styles.specs}>{specs.join(" · ")}</p>}
        <div className={styles.cardFooter}>
          <strong>{priceLabel}</strong>
          <Link href={`/catalog/europe/${encodeURIComponent(listing.master_id)}`}>Подробнее →</Link>
        </div>
      </div>
    </article>
  );
}

export function ApiMessage({ error }: { error: MobileDeApiError }) {
  const message = error.status === 429
    ? "Сервис временно занят. Попробуйте немного позже."
    : "Не удалось получить объявления. Пожалуйста, попробуйте обновить страницу через несколько минут.";
  return <div className={styles.message} role="status"><strong>Каталог временно недоступен</strong><p>{message}</p></div>;
}

export function MobileDeUnavailable({ error }: { error: MobileDeApiError }) {
  return <main className={styles.page}><CatalogNavigation /><section className={styles.hero}><div><ApiMessage error={error} /><Link className={styles.backLink} href="/catalog/europe">← Вернуться в каталог</Link></div></section></main>;
}

export async function MobileDeCatalog({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const filters: MobileDeFilters = { limit: "20" };
  for (const [key] of FILTER_FIELDS) filters[key] = getString(params, key) || undefined;
  for (const [key] of RANGE_FIELDS) filters[key] = getString(params, key) || undefined;
  const requestedSort = getString(params, "sort");
  filters.sort = SORT_OPTIONS.some(([value]) => value === requestedSort) ? requestedSort : "updated_desc";
  filters.cursor = getString(params, "cursor") || undefined;

  let facets: MobileDeFacets = {};
  let catalog: Awaited<ReturnType<typeof getMobileDeListings>> | null = null;
  let error: MobileDeApiError | null = null;
  const [facetsResult, catalogResult] = await Promise.allSettled([
    getMobileDeFacets(),
    getMobileDeListings(filters),
  ]);
  if (facetsResult.status === "fulfilled") facets = facetsResult.value;
  if (catalogResult.status === "fulfilled") catalog = catalogResult.value;
  else {
    const cause = catalogResult.reason;
    error = cause instanceof MobileDeApiError ? cause : new MobileDeApiError(null, "Master API request failed");
  }

  const nextParams = new URLSearchParams();
  for (const [key] of FILTER_FIELDS) if (filters[key]) nextParams.set(key, filters[key]!);
  for (const [key] of RANGE_FIELDS) if (filters[key]) nextParams.set(key, filters[key]!);
  if (filters.sort) nextParams.set("sort", filters.sort);
  if (catalog?.page.next_cursor) nextParams.set("cursor", catalog.page.next_cursor);
  const count = typeof facets.ranges?.count === "number" ? facets.ranges.count : null;

  return (
    <main className={styles.page}>
      <CatalogNavigation />
      <section className={styles.hero}>
        <div className={styles.heroCopy}>
          <span className={styles.eyebrow}>КАТАЛОГ АВТОМОБИЛЕЙ</span>
          <h1>Автомобили из Европы</h1>
          <p>Выберите автомобиль из Европы. Поможем проверить его, рассчитать доставку и оформить покупку.</p>
        </div>
        <div className={styles.heroNote}><span>01 / ИСТОЧНИК</span><strong>Германия и Европа</strong><small>Актуальность продавца может быть неизвестна</small></div>
      </section>

      <CatalogDirections active="europe" />
      <div className={styles.layout}>
        <MobileDeFilterPanel><form action="/catalog/europe" className={styles.filters}>
          <div className={styles.filterHeading}><span>Параметры поиска</span><Link href="/catalog/europe">Сбросить</Link></div>
          {FILTER_FIELDS.map(([key, label]) => (
            <label className={styles.field} key={key}>
              <span>{label}</span>
              <select name={key} defaultValue={getString(params, key)}>
                <option value="">Любая</option>
                {filterOptions(facets, key).map((value) => <option value={value} key={value}>{value}</option>)}
              </select>
            </label>
          ))}
          <div className={styles.rangeGrid}>
            {RANGE_FIELDS.map(([key, label, type]) => (
              <label className={styles.field} key={key}>
                <span>{label}</span>
                <input name={key} type={type} min="0" inputMode="numeric" defaultValue={getString(params, key)} />
              </label>
            ))}
          </div>
          <label className={styles.field}>
            <span>Сортировка</span>
            <select name="sort" defaultValue={filters.sort}>
              {SORT_OPTIONS.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
            </select>
          </label>
          <button className={styles.submit} type="submit">Показать объявления</button>
          <p className={styles.filterFootnote}>Год выпуска и первая регистрация фильтруются отдельно.</p>
        </form></MobileDeFilterPanel>

        <section className={styles.results}>
          <div className={styles.resultsHeading}>
            <div><span className={styles.eyebrow}>КАТАЛОГ MOBILE.DE</span><h2>{count === null ? "Автомобили из Европы" : `${formatNumber(count)} объявлений`}</h2></div>
            <span>{catalog ? `Показано ${catalog.data.length}` : "Только просмотр"}</span>
          </div>
          {error ? <ApiMessage error={error} /> : catalog?.data.length ? (
            <>
              <div className={styles.cards}>{catalog.data.map((listing) => <ListingCard listing={listing} key={listing.master_id} />)}</div>
              {catalog.page.has_more && catalog.page.next_cursor && <Link className={styles.nextPage} href={`/catalog/europe?${nextParams.toString()}`}>Показать следующие объявления <span>→</span></Link>}
            </>
          ) : <div className={styles.empty}><strong>Пока нет объявлений по этим параметрам</strong><span>Измените фильтры или сбросьте их.</span></div>}
        </section>
      </div>
      <footer className={styles.footer}><span>Цены продавцов в евро. Доставка и таможня рассчитываются отдельно.</span><span>Наличие и цена могут измениться на стороне продавца</span></footer>
    </main>
  );
}
