import type { Metadata } from "next";
import { Manrope } from "next/font/google";
import Script from "next/script";
import { MetrikaTracker } from "@/components/analytics/MetrikaTracker";
import "./globals.css";

const manrope = Manrope({ subsets: ["cyrillic", "latin"], variable: "--font-manrope" });
const isPreview = process.env.VERCEL_ENV === "preview";
const siteTitle = isPreview ? "Европейский каталог — Честный пригон" : "Честный пригон — автомобили из Кореи";
const siteDescription = isPreview
  ? "Проверка каталога Mobile.de по синхронизированным данным Master DB."
  : "Подбор, проверка, доставка и растаможка автомобилей из Кореи в Беларусь.";
const previewUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : undefined;

export const metadata: Metadata = {
  metadataBase: new URL(isPreview && previewUrl ? previewUrl : process.env.NEXT_PUBLIC_SITE_URL ?? "https://chestnyprigon.com"),
  title: siteTitle,
  description: siteDescription,
  ...(isPreview ? { robots: { index: false, follow: false } } : {}),
  icons: {
    icon: "/logo.jpeg",
    apple: "/logo.jpeg",
  },
  openGraph: {
    title: siteTitle,
    description: siteDescription,
    url: isPreview ? "/" : "https://chestnyprigon.com",
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
    title: siteTitle,
    description: siteDescription,
    images: ["/logo.jpeg"],
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className={manrope.variable}>
      <body>
        {children}
        {!isPreview && <MetrikaTracker />}
        {!isPreview && <Script id="yandex-metrika" strategy="afterInteractive">
          {`(function(m,e,t,r,i,k,a){
  m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
  m[i].l=1*new Date();
  for (var j = 0; j < document.scripts.length; j++) { if (document.scripts[j].src === r) { return; } }
  k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)
})(window, document, 'script', 'https://mc.yandex.ru/metrika/tag.js?id=112810644', 'ym');
ym(112810644, 'init', {ssr:true, webvisor:true, clickmap:true, ecommerce:"dataLayer", referrer: document.referrer, url: location.href, accurateTrackBounce:true, trackLinks:true, trackHash:true});`}
        </Script>}
        {!isPreview && <noscript>
          <div>
            <img src="https://mc.yandex.ru/watch/112810644" style={{ position: "absolute", left: "-9999px" }} alt="" />
          </div>
        </noscript>}
      </body>
    </html>
  );
}
