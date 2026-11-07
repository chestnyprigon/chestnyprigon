import { formatPowerPs } from "@/lib/format/power";

/** Keep 30-minute electric power distinct from engine/system horsepower. */
export function formatCatalogPower(powerPs: number | null, electric30MinKw?: number | null): string | null {
  if (powerPs != null) return `${formatPowerPs(powerPs)} л. с.`;
  if (electric30MinKw != null) return `${formatPowerPs(electric30MinKw)} кВт (30 мин)`;
  return null;
}
