export type UnknownRecord = Record<string, unknown>;

export type EncarSearchListing = {
  Id: string | number;
  Manufacturer?: string;
  Model?: string;
  Badge?: string;
  BadgeDetail?: string;
  FuelType?: string;
  Year?: string | number;
  FormYear?: string | number;
  Mileage?: string | number;
  Price?: string | number;
  Photo?: string;
  Photos?: string[];
  ServiceCopyCar?: string;
  SellType?: string;
  BuyType?: string;
  OfficeCityState?: string;
  [key: string]: unknown;
};

export type EncarPhoto = {
  code?: string;
  path?: string;
  type?: string;
  updateDateTime?: string;
  [key: string]: unknown;
};

export type EncarDetail = {
  vehicleId?: string | number;
  vehicleNo?: string;
  vin?: string;
  manage?: UnknownRecord;
  category?: UnknownRecord;
  advertisement?: UnknownRecord;
  spec?: UnknownRecord;
  condition?: UnknownRecord;
  contents?: UnknownRecord;
  photos?: EncarPhoto[];
  [key: string]: unknown;
};

export type EncarBundle = {
  fetchedAt: string;
  search: EncarSearchListing;
  detail: EncarDetail;
};

export type ScreeningDecision = "approved" | "rejected" | "manual_review";

export type ScreeningResult = {
  decision: ScreeningDecision;
  isLease: boolean;
  isRental: boolean;
  isTaxi: boolean;
  isCommercial: boolean;
  isElectric: boolean;
  isHydrogen: boolean;
  isHybrid: boolean;
  isUnsupportedPowertrain: boolean;
  isProblematic: boolean;
  reasonCodes: string[];
  matchedTerms: Record<string, string[]>;
  rulesVersion: string;
};

export type NormalizedVehicle = {
  sourceListingId: string;
  manufacturer: string;
  model: string;
  generation: string | null;
  trim: string | null;
  modelYear: number;
  firstRegistrationDate: string | null;
  mileageKm: number;
  priceKrw: number;
  engineCc: number | null;
  fuelType: string;
  transmission: string | null;
  driveType: string | null;
  bodyType: string | null;
  exteriorColor: string | null;
  location: string | null;
  vinMasked: string | null;
  sourceUrl: string;
  sourceUpdatedAt: string | null;
  imageUrls: string[];
};

export type PilotItem = {
  bundle: EncarBundle;
  screening: ScreeningResult;
  normalized: NormalizedVehicle | null;
};
