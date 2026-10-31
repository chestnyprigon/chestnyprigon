import Link from "next/link";
import { CatalogNavigation } from "@/components/mobile-de/CatalogNavigation";
import styles from "@/components/mobile-de/MobileDeCatalog.module.css";
export default function EuropeNotFound() {
  return <main className={styles.page}><CatalogNavigation /><section className={styles.hero}><div><h1>Объявление не найдено</h1><p>Возможно, автомобиль уже снят с продажи. Посмотрите другие предложения.</p><Link className={styles.sourceButton} href="/catalog/europe">Выбрать другой автомобиль</Link></div></section></main>;
}
