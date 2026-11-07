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
import { formatEuropeTurnkeyPrice } from "@/lib/pricing/europe-display";
import type { ExchangeRates } from "@/lib/pricing/chestny-prigon-profile";
import { InfoTooltip } from "@/components/mobile-de/InfoTooltip";
import { formatCatalogPower } from "@/lib/catalog/display-power";
import { formatPowerPs } from "@/lib/format/power";

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
  price: string;
  priceNote: string;
  priceInfo?: string;
};

type ShowcaseSectionProps = {
  id: string;
  country: string;
  href: string;
  action: string;
  cards: ShowcaseCard[];
};

function koreaCard(car: CatalogCar): ShowcaseCard {
  const history = car.accidents?.accidentCount
    ? `Страховые случаи: ${car.accidents.accidentCount}`
    : car.accidents?.available ? "Без ДТП по отчёту Encar" : "История Encar";
  return {
    id: car.id,
    href: `/catalog/${encodeURIComponent(car.id)}`,
    image: car.images[0] ?? null,
    imageAlt: `${car.brand} ${car.model}`,
    eyebrow: history,
    title: `${car.brand} ${car.model}`,
    details: [car.year, `${distance.format(car.mileage)} км`, car.engine, formatCatalogPower(car.powerPs, car.electric30MinKw), car.fuel, car.drive].filter(Boolean).join(" · "),
    price: car.calculation.calculationAvailable ? formatUsdWithByn(car.price, car.calculation.rates) : "Расчёт уточняется",
    priceNote: "Ориентировочный расчёт",
  };
}

function europeCard(listing: MobileDeListing, exchangeRates: ExchangeRates | null): ShowcaseCard {
  const firstRegistration = listing.first_registration?.value;
  const netPrice = listing.net_price;
  const calculation = exchangeRates && typeof netPrice?.amount === "number" && netPrice.basis === "netto" && netPrice.status === "source_reported" && netPrice.source_path === "cars.price_net" && firstRegistration && listing.engine_cc
    ? calculateEuropeBelarusPrice({ netPriceEur: netPrice.amount, firstRegistration, engineCc: listing.engine_cc, exchangeRates })
    : null;
  return {
    id: listing.master_id,
    href: `/catalog/europe/${encodeURIComponent(listing.master_id)}`,
    image: listing.primary_image?.url ?? null,
    imageAlt: listing.title || [listing.make, listing.model].filter(Boolean).join(" "),
    eyebrow: "Mobile.de",
    title: listing.title || [listing.make, listing.model].filter(Boolean).join(" ") || "Автомобиль из Европы",
    details: [listing.first_registration?.value, listing.mileage_km != null ? `${distance.format(listing.mileage_km)} км` : null, listing.power?.value != null ? `${formatPowerPs(listing.power.value)} л. с.` : null].filter(Boolean).join(" · "),
    price: calculation && exchangeRates ? formatEuropeTurnkeyPrice(calculation.totalByn, exchangeRates.eurByn) : "",
    priceNote: "под ключ в Минске",
    priceInfo: "Стоимость предварительная. Для точного расчёта обратитесь к менеджеру.",
  };
}

function ShowcaseSection({ id, country, href, action, cards }: ShowcaseSectionProps) {
  return <section className="home-showcase" id={id}>
    <div className="home-showcase-heading">
      <div><p className="premium-kicker"><span />{country}</p></div>
      <Link className="home-showcase-all" href={href}>{action}<span aria-hidden="true">→</span></Link>
    </div>
    {cards.length ? <div className="home-showcase-grid">{cards.map((card) => <article className="home-showcase-card" key={card.id}>
      <Link className="home-showcase-image" href={card.href} aria-label={`Открыть ${card.title}`}>
        {card.image ? <Image src={card.image} alt={card.imageAlt} fill sizes="(max-width: 700px) 78vw, (max-width: 1100px) 33vw, 25vw" unoptimized /> : <span className="home-showcase-no-image">Фото появится позже</span>}
        <span className="home-showcase-badge">{card.eyebrow}</span>
      </Link>
      <div className="home-showcase-card-body"><h3><Link href={card.href}>{card.title}</Link></h3><p>{card.details || "Характеристики в карточке автомобиля"}</p><footer><span><small>{card.priceNote}{card.priceInfo ? <InfoTooltip label="О предварительной стоимости">{card.priceInfo}</InfoTooltip> : null}</small><strong>{card.price}</strong></span><Link href={card.href} aria-label={`Подробнее: ${card.title}`}>Подробнее <span aria-hidden="true">→</span></Link></footer></div>
    </article>)}</div> : <div className="home-showcase-empty">Сейчас подборка обновляется. Откройте каталог, чтобы посмотреть все объявления.</div>}
    <div className="home-showcase-mobile-action"><Link className="premium-button secondary" href={href}>{action} <span aria-hidden="true">→</span></Link></div>
  </section>;
}

function ShowcaseSkeleton({ country }: { country: string }) {
  return <section className="home-showcase" aria-label={`Загрузка каталога ${country}`} aria-busy="true"><div className="home-showcase-heading"><div><p className="premium-kicker"><span />{country}</p></div></div><div className="home-showcase-grid">{Array.from({ length: 4 }, (_, index) => <div className="home-showcase-skeleton" key={index}><div /><span /><span /></div>)}</div></section>;
}

async function KoreaShowcase() {
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
    });
    cards = catalog.cars.map(koreaCard);
  } catch (error) {
    console.error("[home-showcase] Korea catalogue unavailable", error instanceof Error ? error.message : "Unknown error");
  }
  return <ShowcaseSection id="catalog-korea" country="Каталог Южной Кореи" href="/catalog" action="Все автомобили из Кореи" cards={cards} />;
}

async function EuropeShowcase() {
  let cards: ShowcaseCard[] = [];
  try {
    const [listings, exchangeRates] = await Promise.all([getMobileDeListings({ limit: String(cardLimit), sort: "updated_desc" }), fetchNbrbRates()]);
    cards = listings.data.map((listing) => europeCard(listing, exchangeRates));
  } catch (error) {
    const reason = error instanceof MobileDeApiError ? `status ${error.status ?? "network"}` : "catalog request failed";
    console.error("[home-showcase] Europe catalogue unavailable", reason);
  }
  return <ShowcaseSection id="catalog-europe" country="Каталог Европы" href="/catalog/europe" action="Все автомобили из Европы" cards={cards} />;
}

export function HomeCatalogShowcase() {
  return <div className="home-showcases" id="catalog-directions">
    <Suspense fallback={<ShowcaseSkeleton country="Каталог Южной Кореи" />}><KoreaShowcase /></Suspense>
    <Suspense fallback={<ShowcaseSkeleton country="Каталог Европы" />}><EuropeShowcase /></Suspense>
  </div>;
}
