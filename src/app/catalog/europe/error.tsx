"use client";
import Link from "next/link";
import { CatalogNavigation } from "@/components/mobile-de/CatalogNavigation";
import styles from "@/components/mobile-de/MobileDeCatalog.module.css";
export default function EuropeError({ retry }: { error: unknown; retry: () => void }) {
  return <main className={styles.page}><CatalogNavigation /><section className={styles.hero}><div><h1>Не удалось открыть автомобиль</h1><p>Попробуйте загрузить страницу снова или вернитесь к выбору автомобиля.</p><button className={styles.sourceButton} onClick={retry}>Повторить загрузку</button><Link className={styles.backLink} href="/catalog/europe">← В европейский каталог</Link></div></section></main>;
}
