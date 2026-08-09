import type { BelarusPriceCalculation } from "@/lib/pricing/emavto-profile";

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
  bodyFindings: Array<{ title: string; statuses: string[] }>;
  standardOptionCodes: string[];
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
  sourceUrl: string;
  sourceUpdatedAt: string | null;
  lastSeenAt: string | null;
  status: "Проверено";
  calculation: BelarusPriceCalculation;
  options: VehicleOption[];
  inspection: InspectionSummary | null;
  accidents: AccidentSummary | null;
  reportStatus: string | null;
  reportFetchedAt: string | null;
};
