import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Честный пригон — автомобили из Кореи",
  description: "Подбор, проверка, доставка и растаможка автомобилей из Кореи в Беларусь.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="ru"><body>{children}</body></html>;
}
