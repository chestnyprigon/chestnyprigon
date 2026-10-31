"use client";
import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { ArrowRight, Menu, X } from "lucide-react";
import styles from "./MobileDeCatalog.module.css";

export function CatalogNavigation() {
  const [open, setOpen] = useState(false);
  return <header className="catalog-header">
    <Link className="premium-brand" href="/" aria-label="Честный пригон — главная"><span className="premium-brand-art"><Image className="premium-brand-mark" src="/assets/logo-header-dark.png" alt="Честный пригон" width={2172} height={724} priority /></span></Link>
    <nav className={`catalog-nav ${styles.navigation} ${open ? styles.navigationOpen : ""}`} aria-label="Основная навигация"><Link href="/">Главная</Link><Link href="/catalog">Корея</Link><Link href="/catalog/europe" className="is-active" onClick={() => setOpen(false)}>Европа</Link><Link href="/#services">Услуги</Link><Link href="/#contacts">Контакты</Link></nav>
    <Link className="premium-header-cta" href="/#contacts">Получить консультацию <ArrowRight size={16} /></Link>
    <button className={styles.menuButton} onClick={() => setOpen(!open)} aria-label={open ? "Закрыть меню" : "Открыть меню"} aria-expanded={open}>{open ? <X /> : <Menu />}</button>
  </header>;
}

export function CatalogDirections({ active = "korea" }: { active?: "korea" | "europe" }) {
  return <nav className={styles.directions} aria-label="Выбор каталога"><Link href="/catalog" aria-current={active === "korea" ? "page" : undefined}>🇰🇷 Корея</Link><Link href="/catalog/europe" aria-current={active === "europe" ? "page" : undefined}>🇪🇺 Европа</Link></nav>;
}
