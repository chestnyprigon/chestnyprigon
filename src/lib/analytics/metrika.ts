export const YANDEX_METRIKA_ID = 112810644;

type MetrikaValue = string | number | boolean;
type MetrikaParams = Record<string, MetrikaValue | undefined>;

declare global {
  interface Window {
    ym?: (counterId: number, method: string, ...args: unknown[]) => void;
  }
}

export function trackMetrikaGoal(goal: string, params?: MetrikaParams) {
  if (typeof window === "undefined" || typeof window.ym !== "function") return;
  window.ym(YANDEX_METRIKA_ID, "reachGoal", goal, params ?? {});
}

export function trackMetrikaHit(url: string) {
  if (typeof window === "undefined" || typeof window.ym !== "function") return;
  window.ym(YANDEX_METRIKA_ID, "hit", url);
}

export function markMetrikaStaffVisit() {
  if (typeof window === "undefined") return;

  const params = new URLSearchParams(window.location.search);
  if (params.get("staff") === "1") {
    window.localStorage.setItem("chestnyprigon_metrika_staff", "1");
  }

  if (window.localStorage.getItem("chestnyprigon_metrika_staff") !== "1") return;
  if (typeof window.ym !== "function") return;

  window.ym(YANDEX_METRIKA_ID, "userParams", { staff: 1 });
}

export function currentMarketingParams() {
  if (typeof window === "undefined") return {};
  const params = new URLSearchParams(window.location.search);
  return {
    utmSource: params.get("utm_source"),
    utmMedium: params.get("utm_medium"),
    utmCampaign: params.get("utm_campaign"),
    utmContent: params.get("utm_content"),
    utmTerm: params.get("utm_term"),
  };
}
