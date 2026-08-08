import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["cyrillic", "latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  title: "Честный пригон — автомобили из Кореи",
  description: "Подбор, проверка, доставка и растаможка автомобилей из Кореи в Беларусь.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="ru" className={manrope.variable}><body>{children}</body></html>;
}
