import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import "./globals.css";

const manrope = Manrope({ subsets: ["cyrillic", "latin"], variable: "--font-manrope" });

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "https://chestnyprigon.com"),
  title: "Честный пригон — автомобили из Кореи",
  description: "Подбор, проверка, доставка и растаможка автомобилей из Кореи в Беларусь.",
  icons: {
    icon: "/logo.jpeg",
    apple: "/logo.jpeg",
  },
  openGraph: {
    title: "Честный пригон — автомобили из Кореи",
    description: "Подбор, проверка, доставка и растаможка автомобилей из Кореи в Беларусь.",
    url: "https://chestnyprigon.com",
    siteName: "Честный пригон",
    locale: "ru_RU",
    type: "website",
    images: [
      {
        url: "/logo.jpeg",
        width: 1280,
        height: 1280,
        alt: "Логотип Честный пригон",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "Честный пригон — автомобили из Кореи",
    description: "Подбор, проверка, доставка и растаможка автомобилей из Кореи в Беларусь.",
    images: ["/logo.jpeg"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return <html lang="ru" className={manrope.variable}><body>{children}</body></html>;
}
