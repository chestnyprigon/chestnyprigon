/* eslint-disable @next/next/no-img-element -- image hosts are supplied by Master DB and are not fixed at build time. */
import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeft } from "lucide-react";
import { MobileDeApiError, getMobileDeFacets, getMobileDeListings } from "@/lib/mobile-de/api";
import type { MobileDeFilters, MobileDeListing } from "@/lib/mobile-de/types";
import { MobileDeFilterPanel } from "./MobileDeFilterPanel";
import { CatalogNavigation, CatalogDirections } from "./CatalogNavigation";
import styles from "./MobileDeCatalog.module.css";

import { parseMobileDeFilters, mobileDeFilterParams } from "@/lib/mobile-de/filters";
import { MobileDeFilterForm } from "./MobileDeFilterForm";
import { fetchNbrbRates } from "@/lib/pricing/nbrb-rates";
import { calculateEuropeBelarusPrice } from "@/lib/pricing/europe-belarus";
import { formatEuropeTurnkeyPrice } from "@/lib/pricing/europe-display";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
type SearchParams = Record<string, string | string[] | undefined>;

function formatNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? new Intl.NumberFormat("ru-RU").format(value) : null;
}

function registrationLabel(listing: MobileDeListing) {
  const value = listing.first_registration?.value;
  if (!value) return null;
  const [year, month] = value.split("-");
  return month ? `${month}.${year}` : year;
}

export function ListingCard({ listing, exchangeRates, detailHref }: { listing: MobileDeListing; exchangeRates: ExchangeRates | null; detailHref?: string }) {
  const href = detailHref || `/catalog/europe/${encodeURIComponent(listing.master_id)}`;
  const price = listing.net_price?.amount;
  const firstRegistration = listing.first_registration?.value;
  const calculation = listing.vehicle_class !== "VAN" && exchangeRates && typeof price === "number" && listing.net_price?.basis === "netto" && listing.net_price?.status === "source_reported" && listing.net_price?.source_path === "price.nt.amount" && firstRegistration && listing.engine_cc
    ? calculateEuropeBelarusPrice({ netPriceEur: price, firstRegistration, engineCc: listing.engine_cc, exchangeRates })
    : null;
  const euPrice = listing.source_price?.amount ?? listing.price?.amount;
  const formattedEuPrice = typeof euPrice === "number" ? new Intl.NumberFormat("ru-RU", { style: "currency", currency: listing.source_price?.currency || "EUR", maximumFractionDigits: 0 }).format(euPrice) : null;
  const specs = [
    registrationLabel(listing) ? `Регистрация ${registrationLabel(listing)}` : null,
    listing.mileage_km != null ? `${formatNumber(listing.mileage_km)} км` : null,
    listing.power?.value != null ? `${formatNumber(listing.power.value)} ${listing.power.label_ru || listing.power.unit || "л. с."}` : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <article className={styles.card}>
      <Link prefetch={false} className={styles.cardImage} href={href} aria-label={`Открыть ${listing.title}`}>
        {listing.primary_image?.url ? <img referrerPolicy="no-referrer" src={listing.primary_image.url} alt={listing.title} loading="lazy" /> : <span className={styles.noImage}>Фото появится позже</span>}
        <span className={styles.countryTag}>Европа</span>
      </Link>
      <div className={styles.cardBody}>
        <div className={styles.cardTopline}>
          <span>{listing.make || "Европа"}{listing.model ? ` · ${listing.model}` : ""}</span>
          <span>{listing.freshness?.availability === "unknown" ? "Наличие не подтверждено" : "Данные Master DB"}</span>
        </div>
        <Link prefetch={false} className={styles.cardTitle} href={href}>
          {listing.title || [listing.make, listing.model].filter(Boolean).join(" ") || "Автомобиль из Европы"}
        </Link>
        {specs.length > 0 && <p className={styles.specs}>{specs.join(" · ")}</p>}
        <div className={styles.cardFooter}>
          <div className={styles.cardEstimate}><strong>{calculation && exchangeRates ? formatEuropeTurnkeyPrice(calculation.totalByn, exchangeRates.eurByn) : formattedEuPrice || "Цена не указана"}</strong><small>{calculation && exchangeRates ? "предварительно под ключ в Минске" : listing.source_price?.basis === "gross" ? "цена в Европе · Brutto" : "цена в Европе"}</small></div>
          <Link prefetch={false} href={href}>Подробнее →</Link>
        </div>
      </div>
    </article>
  );
}

export function ApiMessage({ error }: { error: MobileDeApiError }) {
  const message = error.status === 429
    ? "Сервис временно занят. Попробуйте немного позже."
    : error.status === 503
      ? "Для каталога нужна Netto-цена из объявления и данные автомобиля. Обновите страницу позже."
    : "Не удалось получить объявления. Пожалуйста, попробуйте обновить страницу через несколько минут.";
  return <div className={styles.message} role="status"><strong>Каталог временно недоступен</strong><p>{message}</p></div>;
}

export function MobileDeUnavailable({ error }: { error: MobileDeApiError }) {
  return <main className={styles.page}><CatalogNavigation /><section className={styles.hero}><div><ApiMessage error={error} /><Link className={styles.backLink} href="/catalog/europe">← Вернуться в каталог</Link></div></section></main>;
}

async function EuropeIntro() {
  const [facetsResult] = await Promise.allSettled([getMobileDeFacets()]);
  const total = facetsResult.status === "fulfilled" ? facetsResult.value.ranges?.count : undefined;
  return <section className={styles.europeIntro}>
    <div className={styles.europeIntroCopy}>
      <Link href="/"><ArrowLeft size={16} />На главную</Link>
      <p className={styles.europeIntroKicker}><span />Каталог автомобилей из Европы</p>
      <h1>Автомобили<br />из Европы</h1>
      <p>Актуальные объявления Mobile.de с подробной карточкой, опциями и предварительной стоимостью под ключ.</p>
    </div>
    <div className={styles.europeIntroStat}>
      <strong>{typeof total === "number" ? `${new Intl.NumberFormat("ru-RU").format(total)} авто` : "Европа"}</strong>
      <span>{typeof total === "number" ? "доступны в каталоге" : "каталог автомобилей"}</span>
    </div>
  </section>;
}

function EuropeIntroFallback() {
  return <section className={styles.europeIntro}>
    <div className={styles.europeIntroCopy}><Link href="/"><ArrowLeft size={16} />На главную</Link><p className={styles.europeIntroKicker}><span />Каталог автомобилей из Европы</p><h1>Автомобили<br />из Европы</h1><p>Актуальные объявления Mobile.de с подробной карточкой, опциями и предварительной стоимостью под ключ.</p></div>
    <div className={styles.europeIntroStat}><strong>Европа</strong><span>каталог автомобилей</span></div>
  </section>;
}

export async function MobileDeCatalog({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const {filters, errors, valid} = parseMobileDeFilters(params);

  return (
    <main className={styles.page}>
      <CatalogNavigation />
      <Suspense fallback={<EuropeIntroFallback />}><EuropeIntro /></Suspense>

      <CatalogDirections active="europe" preserveScroll />
      <div className={styles.layout}>
        <MobileDeFilterPanel>
          <MobileDeFilterForm key={JSON.stringify(params)} params={params} initialErrors={errors} />
        </MobileDeFilterPanel>
        <Suspense key={JSON.stringify(filters)} fallback={<CatalogResultsLoading />}>
          {valid ? <CatalogResults filters={filters} /> : <section className={styles.results}><div className={styles.message} role="alert"><strong>Проверьте параметры поиска</strong><p>Исправьте отмеченные поля в фильтрах и повторите поиск.</p></div></section>}
        </Suspense>
      </div>
    </main>
  );
}


function CatalogResultsLoading() {
  return <section className={styles.results} aria-busy="true" aria-label="Загрузка объявлений"><div className={styles.resultsHeading}><h2>Автомобили из Европы</h2><span role="status">Загружаем объявления…</span></div><div className={styles.cards}>{Array.from({length:6},(_,index)=><div className={styles.skeletonCard} key={index}><div /><span /><span /></div>)}</div></section>;
}

async function CatalogResults({ filters }: { filters: MobileDeFilters }) {
  let catalog: Awaited<ReturnType<typeof getMobileDeListings>> | null = null;
  let error: MobileDeApiError | null = null;
  let exchangeRates: ExchangeRates | null = null;
  const [catalogResult, ratesResult] = await Promise.allSettled([getMobileDeListings(filters), fetchNbrbRates()]);
  if (catalogResult.status === "fulfilled") catalog = catalogResult.value;
  else error = catalogResult.reason instanceof MobileDeApiError ? catalogResult.reason : new MobileDeApiError(null, "Europe catalogue request failed");
  if (ratesResult.status === "fulfilled") exchangeRates = ratesResult.value;
  const nextParams = mobileDeFilterParams(filters, catalog?.page.next_cursor || undefined);
  return (


        <section className={styles.results}>
          <div className={styles.resultsHeading}>
            <div><span className={styles.eyebrow}>КАТАЛОГ MOBILE.DE</span><h2>Автомобили из Европы</h2></div>
            <span>{catalog ? `Показано ${catalog.data.length}` : "Только просмотр"}</span>
          </div>
          {error ? <ApiMessage error={error} /> : catalog?.data.length ? (
            <>
              <div className={styles.cards}>{catalog.data.map((listing) => <ListingCard listing={listing} exchangeRates={exchangeRates} key={listing.master_id} />)}</div>
              {catalog.page.has_more && catalog.page.next_cursor && <Link prefetch={false} className={styles.nextPage} href={`/catalog/europe?${nextParams.toString()}`}>Показать следующие объявления <span>→</span></Link>}
            </>
          ) : <div className={styles.empty}><strong>Пока нет объявлений по этим параметрам</strong><span>Измените фильтры или сбросьте их.</span></div>}
        </section>
  );
}
