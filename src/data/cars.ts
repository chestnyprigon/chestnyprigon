import type { BelarusPriceCalculation } from "@/lib/pricing/emavto-profile";

export type CarFuel = "Бензин" | "Дизель" | "Гибрид" | "Электро" | "Газ" | "Другое";

export type CatalogCar = {
  id: string;
  sourceListingId: string;
  brand: string;
  model: string;
  trim: string;
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
  price: number;
  sourcePriceKrw: number;
  location: string;
  images: string[];
  sourceUrl: string;
  status: "Проверено";
  calculation: BelarusPriceCalculation;
};
