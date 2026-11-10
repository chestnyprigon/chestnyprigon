import { InfoTooltip } from "@/components/mobile-de/InfoTooltip";

export function CatalogPrice({ price, info }: { price: string; info?: string }) {
  const equivalentStart = price.endsWith(")") ? price.lastIndexOf(" (") : -1;
  const main = equivalentStart < 0 ? price : price.slice(0, equivalentStart);
  const equivalent = equivalentStart < 0 ? null : price.slice(equivalentStart + 1);
  return (
    <strong className="catalog-card-price">
      <span className="catalog-card-price-main">
        {main}{info && <InfoTooltip label="Пояснение к цене">{info}</InfoTooltip>}
      </span>
      {equivalent && <> <span className="catalog-card-price-equivalent">{equivalent}</span></>}
    </strong>
  );
}
