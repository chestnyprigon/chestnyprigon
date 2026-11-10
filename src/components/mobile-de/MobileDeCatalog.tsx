import { vehicleDisplayName } from "@/lib/mobile-de/models";
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
import { formatEuropeBelarusPrice, formatEuropeRussiaPrice } from "@/lib/pricing/europe-display";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import { fetchCbrRates, type RubExchangeRates } from "@/lib/pricing/cbr-rates";
import { CatalogPrice } from "@/components/catalog/CatalogPrice";
import { MobileDeCardPhoto } from "./MobileDeCardPhoto";
import { formatPowerPs } from "@/lib/format/power";
import { loadRussiaPriceSnapshotsOrCalculate } from "@/lib/pricing/russia-price-snapshots";
import { readCalculationPreference } from "@/lib/pricing/country-preference";
import type { RussiaPriceResult } from "@/lib/pricing/russia-pricing";
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

export function ListingCard({ listing, exchangeRates, detailHref, destination = "by", currency = "USD", russiaCalculation, rubRates }: { listing: MobileDeListing; exchangeRates: ExchangeRates | null; detailHref?: string; destination?: "by" | "ru"; currency?: "USD" | "BYN" | "RUB" | "EUR"; russiaCalculation?: RussiaPriceResult | null; rubRates?: RubExchangeRates | null }) {
  const href = detailHref || `/catalog/europe/${encodeURIComponent(listing.master_id)}?destination=${destination}&currency=${currency}`;
  const { name } = vehicleDisplayName(listing.make, listing.model, listing.title);
  const price = listing.price?.amount;
  const firstRegistration = listing.first_registration?.value;
  const calculation = listing.transport_class !== "VAN" && exchangeRates && typeof price === "number" && firstRegistration && listing.engine_cc
    ? calculateEuropeBelarusPrice({ sourcePriceEur: price, priceBasis: listing.price?.basis ?? "unknown", firstRegistration, engineCc: listing.engine_cc, exchangeRates })
    : null;
  const sourcePriceDisplay = typeof price === "number"
    ? exchangeRates ? formatEuropeBelarusPrice(price * exchangeRates.eurByn, exchangeRates.usdByn, currency === "BYN" ? "BYN" : "USD") : `${new Intl.NumberFormat("ru-RU").format(price)} €`
    : "";
  const priceDisplay = destination === "ru"
    ? formatEuropeRussiaPrice(price, currency, russiaCalculation, rubRates)
    : calculation && exchangeRates ? formatEuropeBelarusPrice(calculation.totalByn, exchangeRates.usdByn, currency === "BYN" ? "BYN" : "USD") : sourcePriceDisplay;
  const isEstimate = listing.transport_class !== "VAN" && (destination === "ru" ? Boolean(russiaCalculation) : Boolean(calculation));
  const specs = [
    registrationLabel(listing) ? `Регистрация ${registrationLabel(listing)}` : null,
    listing.mileage_km != null ? `${formatNumber(listing.mileage_km)} км` : null,
    listing.power?.value != null ? `${formatPowerPs(listing.power.value)} ${listing.power.label_ru || listing.power.unit || "л. с."}` : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <article className={styles.card}>
      <Link prefetch={false} className={styles.cardImage} href={href} aria-label={`Открыть ${name}`}>
        {listing.primary_image?.url ? <MobileDeCardPhoto src={listing.primary_image.url} alt={name} /> : <span className={styles.noImage}>Фото появится позже</span>}
        <span className={styles.countryTag}>Европа</span>
      </Link>
      <div className={styles.cardBody}>
        <Link prefetch={false} className={styles.cardTitle} href={href}>{name}</Link>
        {specs.length > 0 && <p className={styles.specs}>{specs.join(" · ")}</p>}
        <div className={styles.cardFooter}>
          <div className={styles.cardEstimate}>
            {priceDisplay && <CatalogPrice price={priceDisplay} info={isEstimate ? "Расчёт предварительный. Итоговую стоимость уточнит менеджер." : "Цена указана в Mobile.de. Стоимость под ключ уточнит менеджер."} />}
          </div>
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
  const preference = await readCalculationPreference(params);
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
          {valid ? <CatalogResults filters={filters} destination={preference.destination} currency={preference.currency} /> : <section className={styles.results}><div className={styles.message} role="alert"><strong>Проверьте параметры поиска</strong><p>Исправьте отмеченные поля в фильтрах и повторите поиск.</p></div></section>}
        </Suspense>
      </div>
    </main>
  );
}


function CatalogResultsLoading() {
  return <section className={styles.results} aria-busy="true" aria-label="Загрузка объявлений"><div className={styles.resultsHeading}><h2>Автомобили из Европы</h2><span role="status">Загружаем объявления…</span></div><div className={styles.cards}>{Array.from({length:6},(_,index)=><div className={styles.skeletonCard} key={index}><div /><span /><span /></div>)}</div></section>;
}

async function CatalogResults({ filters, destination, currency }: { filters: MobileDeFilters; destination: "by" | "ru"; currency: "USD" | "BYN" | "RUB" | "EUR" }) {
  let catalog: Awaited<ReturnType<typeof getMobileDeListings>> | null = null;
  let error: MobileDeApiError | null = null;
  let exchangeRates: ExchangeRates | null = null;
  const [catalogResult, ratesResult, rubRatesResult] = await Promise.allSettled([
    getMobileDeListings(filters),
    destination === "by" ? fetchNbrbRates() : null,
    destination === "ru" ? fetchCbrRates() : null,
  ]);
  const rubRates = rubRatesResult.status === "fulfilled" ? rubRatesResult.value : null;
  if (catalogResult.status === "fulfilled") catalog = catalogResult.value;
  else error = catalogResult.reason instanceof MobileDeApiError ? catalogResult.reason : new MobileDeApiError(null, "Europe catalogue request failed");
  if (ratesResult.status === "fulfilled") exchangeRates = ratesResult.value;
  const russiaCalculations = new Map<string, RussiaPriceResult | null>();
  if (destination === "ru" && catalog) {
    const entries = catalog.data.flatMap((listing) => {
      if (listing.transport_class === "VAN") return [];
      const vehicle = russiaInputForListing(listing);
      return vehicle ? [{ listingId: listing.master_id, vehicle }] : [];
    });
    const stored = await loadRussiaPriceSnapshotsOrCalculate("europe", entries).catch(() => null);
    for (const listing of catalog.data) russiaCalculations.set(listing.master_id, stored?.get(listing.master_id) ?? null);
  }
  const nextParams = mobileDeFilterParams(filters, catalog?.page.next_cursor || undefined);
  if (destination) { nextParams.set("destination", destination); nextParams.set("currency", currency); }
  return (


        <section className={styles.results}>
          <div className={styles.resultsHeading}>
            <div><span className={styles.eyebrow}>КАТАЛОГ MOBILE.DE</span><h2>Автомобили из Европы</h2></div>
            <span>{catalog ? `Показано ${catalog.data.length}` : "Только просмотр"}</span>
          </div>
          {error ? <ApiMessage error={error} /> : catalog?.data.length ? (
            <>
              <div className={styles.cards}>{catalog.data.map((listing) => <ListingCard listing={listing} exchangeRates={exchangeRates} destination={destination} currency={currency} rubRates={rubRates} russiaCalculation={russiaCalculations.get(listing.master_id)} key={listing.master_id} />)}</div>
              {catalog.page.has_more && catalog.page.next_cursor && <Link prefetch={false} className={styles.nextPage} href={`/catalog/europe?${nextParams.toString()}`}>Показать следующие объявления <span>→</span></Link>}
            </>
          ) : <div className={styles.empty}><strong>Пока нет объявлений по этим параметрам</strong><span>Измените фильтры или сбросьте их.</span></div>}
        </section>
  );
}
