"use client";
import { useState, type ReactNode } from "react";
import { Filter, ChevronDown } from "lucide-react";
import styles from "./MobileDeCatalog.module.css";
export function MobileDeFilterPanel({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <div className={styles.filterPanel} data-open={open}><button className={styles.filterToggle} type="button" aria-expanded={open} aria-controls="europe-filters" onClick={() => setOpen(!open)}><Filter size={17} />Фильтры<ChevronDown size={16} /></button><div id="europe-filters" className={styles.filterContent}>{children}</div></div>;
}
