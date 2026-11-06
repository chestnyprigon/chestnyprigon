import { PremiumLanding } from "@/components/landing/PremiumLanding";
import { HomeCatalogShowcase } from "@/components/landing/HomeCatalogShowcase";

export const dynamic = "force-dynamic";

export default function Home() {
  return <PremiumLanding catalogShowcase={<HomeCatalogShowcase />} />;
}
