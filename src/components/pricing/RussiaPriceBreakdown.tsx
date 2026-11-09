import { Calculator, RefreshCw } from "lucide-react";
import { InfoTooltip } from "@/components/mobile-de/InfoTooltip";
import { RUSSIA_KOREA_COMMERCIAL_PROFILE, type RussiaPriceResult } from "@/lib/pricing/russia-pricing";

const rub = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 });
const sourceMoney = (amount: number, currency: "KRW" | "EUR") => new Intl.NumberFormat("ru-RU", {
  style: "currency", currency, maximumFractionDigits: currency === "KRW" ? 0 : 2,
}).format(amount);

const COMMERCIAL_LABELS: Record<string, string> = {
  vehicleAndKoreaCost: "Стоимость автомобиля и расходов в Корее",
  vehicle: "Автомобиль",
  delivery: "Доставка до России",
  commission: "Комиссия",
  svhDeclarant: "СВХ и декларант",
  companyService: "Услуги компании",
  euService: "Услуги компании в ЕС",
  translation: "Перевод документов",
};

const RATE_LABELS: Record<string, string> = {
  KRW_per_USD: "Рабочий курс KRW/USD",
  RUB_per_USD: "Курс USD/RUB",
  RUB_per_EUR: "Курс EUR/RUB",
};

function dateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "short", timeStyle: "short", timeZone: "Europe/Moscow",
  }).format(date);
}

export function RussiaPriceBreakdown({
  calculation,
  isRefreshing = false,
  refreshError = null,
  onRefresh,
}: {
  calculation: RussiaPriceResult;
  isRefreshing?: boolean;
  refreshError?: string | null;
  onRefresh?: () => void;
}) {
  const commercialLines = Object.entries(calculation.commercial.lineItemsRub);
  const exchangeRates = Object.entries(calculation.commercial.exchangeRates)
    .filter(([key]) => RATE_LABELS[key])
    .map(([key, value]) => [RATE_LABELS[key]!, value] as const);
  const governmentLines = ([
    ["Таможенная пошлина", calculation.government.dutyRub],
    ["Акциз", calculation.government.exciseRub],
    ["НДС", calculation.government.vatRub],
    ["Утилизационный сбор", calculation.government.recyclingFeeRub],
    ["Таможенный сбор за оформление", calculation.government.customsProcessingFeeRub],
  ] as Array<[string, number]>).filter(([, value]) => value > 0);

  return <details className="dossier-calculation russia-calculation" open>
    <summary><Calculator size={15} />Расчёт цены <span>⌄</span></summary>
    <div className="dossier-client-table">
      {onRefresh ? <>
        <button className="dossier-price-refresh" type="button" onClick={onRefresh} disabled={isRefreshing}>
          <RefreshCw size={14} className={isRefreshing ? "is-spinning" : ""} />
          {isRefreshing ? "Обновляем цену…" : "Обновить цену"}
        </button>
        {refreshError ? <p className="dossier-price-refresh-error" role="alert">{refreshError}</p> : null}
      </> : null}
      <p><span>Цена автомобиля ({calculation.commercial.sourceCurrency})</span><b>{sourceMoney(calculation.commercial.sourcePriceAmount, calculation.commercial.sourceCurrency)}</b></p>
      {calculation.commercial.sourceCurrency === "KRW" ? <p><span>Стояночные</span><b>{sourceMoney(RUSSIA_KOREA_COMMERCIAL_PROFILE.parkingKrw, "KRW")}</b></p> : null}
      {exchangeRates.map(([label, value]) => <p key={label}><span>{label}</span><b>{new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 3 }).format(value)}</b></p>)}
      {commercialLines.map(([key, value]) => <p className={key === "vehicleAndKoreaCost" || key === "vehicle" ? "is-emphasis" : ""} key={key}>
        <span>{COMMERCIAL_LABELS[key] ?? key}</span><b>{rub.format(value)}</b>
      </p>)}
      <p className="is-emphasis"><span>Итого коммерческие расходы</span><b>{rub.format(calculation.commercial.subtotalRub)}</b></p>
      {governmentLines.map(([label, value]) => <p key={label}><span>{label}</span><b>{rub.format(value)}</b></p>)}
      <p className="is-total"><span>ИТОГО в России: <InfoTooltip label="О предварительном расчёте">Расчёт предварительный. Итоговая стоимость может измениться из-за курса валют, параметров автомобиля и условий оформления. Точную стоимость подтвердит менеджер.</InfoTooltip></span><b>{rub.format(calculation.totalRub)}</b></p>
      <small className="dossier-rate-note">Курсы и расчёт обновлены {dateTime(calculation.rates.fetchedAt)} · курс действителен на {calculation.rates.effectiveDate}.</small>
    </div>
  </details>;
}
