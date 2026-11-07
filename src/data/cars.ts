import type { BelarusPriceCalculation } from "@/lib/pricing/chestny-prigon-profile";
import type { RussiaPriceResult } from "@/lib/pricing/russia-pricing";

export type CarFuel = "Бензин" | "Дизель" | "Гибрид" | "Электро" | "Газ" | "Другое";

export type VehicleOption = {
  name: string;
  priceKrw: number | null;
  description: string | null;
};

export type InspectionSummary = {
  state: string | null;
  reportedAccident: boolean;
  simpleRepair: boolean;
  waterlog: boolean;
  tuning: boolean;
  recallCompleted: boolean;
  usageHistory: string[];
  firstRegistrationDate: string | null;
  inspectionMileage: number | null;
  checks: Array<{ title: string; status: string }>;
  bodyDiagnosisAvailable: boolean | null;
  bodyDiagnosisNotes: string[];
  bodyFindings: Array<{
    code: string | null;
    title: string;
    statuses: Array<{ code: string | null; title: string }>;
  }>;
  standardOptionCodes: string[];
  standardOptionCodesAvailable?: boolean;
  inspectionImages: Array<{ url: string; title: string }>;
};

export type AccidentSummary = {
  available: boolean;
  accidentCount: number;
  ownAccidentCount: number;
  otherAccidentCount: number;
  ownerChangeCount: number;
  ownAccidentCostKrw: number;
  otherAccidentCostKrw: number;
  totalLossCount: number;
  floodTotalLossCount: number;
  floodPartLossCount: number;
  theftCount: number;
  loanCount: number;
  insuranceEvents: Array<{
    date: string;
    type: string;
    amountKrw: number;
    partsKrw: number | null;
    paintingKrw: number | null;
    laborKrw: number | null;
  }>;
};

export type CatalogCar = {
  id: string;
  sourceListingId: string;
  brand: string;
  model: string;
  trim: string;
  generation: string | null;
  year: number;
  registrationDate: string | null;
  mileage: number;
  engine: string;
  engineCc: number | null;
  powerPs: number | null;
  electric30MinKw?: number | null;
  enginePowerKw?: number | null;
  electricPeakKw?: number | null;
  systemCombinedPowerKw?: number | null;
  powerBasis?: string | null;
  rawFuelType?: string | null;
  powerSourceRef?: string | null;
  powerConfidence: string | null;
  fuel: CarFuel;
  sourceFuel: string;
  drive: string;
  bodyType: string | null;
  color: string | null;
  transmission: string | null;
  vinMasked: string | null;
  price: number;
  sourcePriceKrw: number;
  location: string;
  images: string[];
  imageGroups: Array<{ url: string; group: "Кузов" | "Салон" | "Детали" | "Другие фото" }>;
  sourceUrl: string;
  publishedAt: string | null;
  sourceUpdatedAt: string | null;
  lastSeenAt: string | null;
  status: "Проверено";
  calculation: BelarusPriceCalculation;
  russiaCalculation?: RussiaPriceResult | null;
  destination?: "BY" | "RU";
  options: VehicleOption[];
  inspection: InspectionSummary | null;
  accidents: AccidentSummary | null;
  reportStatus: string | null;
  reportFetchedAt: string | null;
};
