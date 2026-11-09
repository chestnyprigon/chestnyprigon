import { vehicleDisplayName } from "@/lib/mobile-de/models";
import { Suspense } from "react";
import Image from "next/image";
import Link from "next/link";
import type { CatalogCar } from "@/data/cars";
import { loadCatalogPage } from "@/lib/catalog/load-catalog";
import { catalogYearFrom, catalogYearTo, CATALOG_MAX_MILEAGE_KM, CATALOG_MAX_PRICE_USD } from "@/lib/catalog/catalog-rules";
import { formatUsdWithByn } from "@/lib/pricing/display";
import { getMobileDeListings, MobileDeApiError } from "@/lib/mobile-de/api";
import type { MobileDeListing } from "@/lib/mobile-de/types";
import { fetchNbrbRates } from "@/lib/pricing/nbrb-rates";
import { calculateEuropeBelarusPrice } from "@/lib/pricing/europe-belarus";
import { formatEuropeSourcePrice, formatEuropeTurnkeyPrice } from "@/lib/pricing/europe-display";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import { InfoTooltip } from "@/components/mobile-de/InfoTooltip";
import { formatCatalogPower } from "@/lib/catalog/display-power";
import { formatPowerPs } from "@/lib/format/power";
import { loadRussiaPriceSnapshotsOrCalculate } from "@/lib/pricing/russia-price-snapshots";
import { formatRussiaTotal } from "@/lib/pricing/russia-pricing";

const cardLimit = 12;
const distance = new Intl.NumberFormat("ru-RU");

type ShowcaseCard = {
  id: string;
  href: string;
  image: string | null;
  imageAlt: string;
  eyebrow: string;
  title: string;
  details: string;
  power?: string;
  price: string;
  priceNote: string;
  priceInfo?: string;
};

type ShowcaseSectionProps = {
  id: string;
  country: string;
  href: string;
  action: string;
  destination: "by" | "ru";
  currency: "USD" | "BYN" | "RUB" | "EUR";
  cards: ShowcaseCard[];
};

function displayRussiaPrice(car: CatalogCar, currency: "USD" | "BYN" | "RUB" | "EUR") {
  if (!car.russiaCalculation) return "Расчёт уточняется";
  return formatRussiaTotal(car.russiaCalculation, currency === "BYN" ? "RUB" : currency);
}

function koreaCard(car: CatalogCar, destination: "by" | "ru", currency: "USD" | "BYN" | "RUB" | "EUR"): ShowcaseCard {
  const { name } = vehicleDisplayName(car.brand, car.model);
  const history = car.accidents?.accidentCount
    ? `Страховые случаи: ${car.accidents.accidentCount}`
    : car.accidents?.available ? "Без ДТП по отчёту Encar" : "История Encar";
  return {
    id: car.id,
    href: `/catalog/${encodeURIComponent(car.id)}?destination=${destination}&currency=${currency}`,
    image: car.images[0] ?? null,
    imageAlt: name,
    eyebrow: history,
    title: name,
    details: [car.year, `${distance.format(car.mileage)} км`, car.engine, car.fuel, car.drive].filter(Boolean).join(" · "),
    power: formatCatalogPower(car.powerPs, car.electric30MinKw) || undefined,
    price: destination === "ru" ? displayRussiaPrice(car, currency) : car.calculation.calculationAvailable ? formatUsdWithByn(car.price, car.calculation.rates) : "Расчёт уточняется",
    priceNote: "Предварительный расчёт",
    priceInfo: "Расчёт предварительный. Итог может измениться из-за курса, параметров авто и условий оформления. Точную стоимость уточнит менеджер.",
  };
}

function europeCard(listing: MobileDeListing, exchangeRates: ExchangeRates | null, destination: "by" | "ru", currency: "USD" | "BYN" | "RUB" | "EUR", russiaCalculation?: import("@/lib/pricing/russia-pricing").RussiaPriceResult | null): ShowcaseCard {
  const { name } = vehicleDisplayName(listing.make, listing.model, listing.title);
  const firstRegistration = listing.first_registration?.value;
  const sourcePrice = listing.price;
  const calculation = listing.transport_class !== "VAN" && exchangeRates && typeof sourcePrice?.amount === "number" && firstRegistration && listing.engine_cc
    ? calculateEuropeBelarusPrice({ sourcePriceEur: sourcePrice.amount, priceBasis: sourcePrice.basis ?? "unknown", firstRegistration, engineCc: listing.engine_cc, exchangeRates })
    : null;
  return {
    id: listing.master_id,
    href: `/catalog/europe/${encodeURIComponent(listing.master_id)}?destination=${destination}&currency=${currency}`,
    image: listing.primary_image?.url ?? null,
    imageAlt: name,
    eyebrow: "Mobile.de",
    title: name,
    details: [listing.first_registration?.value, listing.mileage_km != null ? `${distance.format(listing.mileage_km)} км` : null, listing.power?.value != null ? `${formatPowerPs(listing.power.value)} л. с.` : null].filter(Boolean).join(" · "),
    price: listing.transport_class === "VAN"
      ? exchangeRates && typeof sourcePrice?.amount === "number" ? formatEuropeSourcePrice(sourcePrice.amount, exchangeRates.eurByn) : typeof sourcePrice?.amount === "number" ? `${distance.format(sourcePrice.amount)} €` : ""
      : destination === "ru" && russiaCalculation
      ? formatRussiaTotal(russiaCalculation, currency === "BYN" ? "RUB" : currency)
      : destination === "ru" && !russiaCalculation
        ? typeof sourcePrice?.amount === "number" ? `${distance.format(sourcePrice.amount)} €` : ""
        : calculation && exchangeRates ? formatEuropeTurnkeyPrice(calculation.totalByn, exchangeRates.eurByn) : exchangeRates && typeof sourcePrice?.amount === "number" ? formatEuropeSourcePrice(sourcePrice.amount, exchangeRates.eurByn) : typeof sourcePrice?.amount === "number" ? `${distance.format(sourcePrice.amount)} €` : "",
    priceNote: listing.transport_class === "VAN" ? "Цена в Европе" : destination === "ru" && russiaCalculation ? "Предварительный расчёт" : destination === "by" && calculation ? "Предварительный расчёт" : "Цена в Европе",
    priceInfo: listing.transport_class === "VAN"
      ? "Цена указана в Mobile.de. Итог уточнит менеджер."
      : (destination === "ru" ? Boolean(russiaCalculation) : Boolean(calculation))
        ? "Расчёт предварительный. Итог может измениться из-за курса, параметров авто и условий оформления. Точную стоимость уточнит менеджер."
        : "Цена объявления Mobile.de. Расчёт под ключ уточнит менеджер.",
  };
}

function ShowcaseSection({ id, country, href, action, destination, currency, cards }: ShowcaseSectionProps) {
  return <section className="home-showcase" id={id}>
    <div className="home-showcase-heading">
      <div><p className="premium-kicker"><span />{country}</p></div>
      <Link className="home-showcase-all" href={`${href}?destination=${destination}&currency=${currency}`}>{action}<span aria-hidden="true">→</span></Link>
    </div>
    {cards.length ? <div className="home-showcase-grid">{cards.map((card) => <article className="home-showcase-card" key={card.id}>
      <Link className="home-showcase-image" href={card.href} aria-label={`Открыть ${card.title}`}>
        {card.image ? <Image src={card.image} alt={card.imageAlt} fill sizes="(max-width: 700px) 78vw, (max-width: 1100px) 33vw, 25vw" unoptimized /> : <span className="home-showcase-no-image">Фото появится позже</span>}
        <span className="home-showcase-badge">{card.eyebrow}</span>
      </Link>
      <div className="home-showcase-card-body"><h3><Link href={card.href}>{card.title}</Link></h3><p>{card.details || "Характеристики в карточке автомобиля"}{card.power ? <> · {card.power} <InfoTooltip label="Об источнике данных о мощности">Мощность указана по открытым источникам и может отличаться. Уточните у продавца.</InfoTooltip></> : null}</p><footer><span><small>{card.priceNote}</small><strong className="price-with-info"><span>{card.price}</span>{card.priceInfo && <InfoTooltip label="Пояснение к цене">{card.priceInfo}</InfoTooltip>}</strong></span><Link href={card.href} aria-label={`Подробнее: ${card.title}`}>Подробнее <span aria-hidden="true">→</span></Link></footer></div>
    </article>)}</div> : <div className="home-showcase-empty">Сейчас подборка обновляется. Откройте каталог, чтобы посмотреть все объявления.</div>}
    <div className="home-showcase-mobile-action"><Link className="premium-button secondary" href={`${href}?destination=${destination}&currency=${currency}`}>{action} <span aria-hidden="true">→</span></Link></div>
  </section>;
}

function ShowcaseSkeleton({ country }: { country: string }) {
  return <section className="home-showcase" aria-label={`Загрузка каталога ${country}`} aria-busy="true"><div className="home-showcase-heading"><div><p className="premium-kicker"><span />{country}</p></div></div><div className="home-showcase-grid">{Array.from({ length: 4 }, (_, index) => <div className="home-showcase-skeleton" key={index}><div /><span /><span /></div>)}</div></section>;
}

async function KoreaShowcase({ destination, currency }: { destination: "by" | "ru"; currency: "USD" | "BYN" | "RUB" | "EUR" }) {
  let cards: ShowcaseCard[] = [];
  try {
    const catalog = await loadCatalogPage({
      homepageMix: true,
      includeCount: false,
      includeBrands: false,
      perPage: cardLimit,
      yearFrom: catalogYearFrom(),
      yearTo: catalogYearTo(),
      minMileage: 0,
      maxMileage: CATALOG_MAX_MILEAGE_KM,
      minPrice: 0,
      maxPrice: CATALOG_MAX_PRICE_USD,
    }, destination);
    cards = catalog.cars.map((car) => koreaCard(car, destination, currency));
  } catch (error) {
    console.error("[home-showcase] Korea catalogue unavailable", error instanceof Error ? error.message : "Unknown error");
  }
  return <ShowcaseSection id="catalog-korea" country="Каталог Южной Кореи" href="/catalog" action="Все автомобили из Кореи" destination={destination} currency={currency} cards={cards} />;
}

async function EuropeShowcase({ destination, currency }: { destination: "by" | "ru"; currency: "USD" | "BYN" | "RUB" | "EUR" }) {
  let cards: ShowcaseCard[] = [];
  try {
    const [listings, exchangeRates] = await Promise.all([getMobileDeListings({ limit: String(cardLimit), sort: "updated_desc" }), destination === "by" ? fetchNbrbRates() : Promise.resolve(null)]);
    const entries = listings.data.flatMap((listing) => {
      if (listing.transport_class === "VAN") return [];
      const price = listing.price?.amount;
      if (typeof price !== "number" || price <= 0) return [];
      const powerValue = listing.power?.value;
      const powerIsKw = /kw/i.test(`${listing.power?.unit ?? ""} ${listing.power?.label_ru ?? ""}`);
      return [{ listingId: listing.master_id, vehicle: {
        source: "europe" as const, sourceId: listing.master_id, brand: listing.make ?? "",
        model: listing.model ?? listing.title, year: Number(listing.first_registration?.value?.slice(0, 4)) || null,
        firstRegistration: listing.first_registration?.value, engineCc: listing.engine_cc,
        fuelType: listing.fuel_type, driveType: listing.drive, price, currency: "EUR" as const,
        powerKw: powerValue && powerIsKw ? powerValue : undefined,
        powerPs: powerValue && !powerIsKw ? powerValue : undefined,
      } }];
    });
    const stored = destination === "ru" ? await loadRussiaPriceSnapshotsOrCalculate("europe", entries) : new Map();
    cards = listings.data.map((listing) => europeCard(listing, exchangeRates, destination, currency, stored.get(listing.master_id) ?? null));
  } catch (error) {
    const reason = error instanceof MobileDeApiError ? `status ${error.status ?? "network"}` : "catalog request failed";
    console.error("[home-showcase] Europe catalogue unavailable", reason);
  }
  return <ShowcaseSection id="catalog-europe" country="Каталог Европы" href="/catalog/europe" action="Все автомобили из Европы" destination={destination} currency={currency} cards={cards} />;
}

export function HomeCatalogShowcase({ destination = "by", currency = "USD" }: { destination?: "by" | "ru"; currency?: "USD" | "BYN" | "RUB" | "EUR" } = {}) {
  return <div className="home-showcases" id="catalog-directions">
    <Suspense fallback={<ShowcaseSkeleton country="Каталог Южной Кореи" />}><KoreaShowcase destination={destination} currency={currency} /></Suspense>
    <Suspense fallback={<ShowcaseSkeleton country="Каталог Европы" />}><EuropeShowcase destination={destination} currency={currency} /></Suspense>
  </div>;
}
