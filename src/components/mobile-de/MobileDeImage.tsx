"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { loadMobileDeImage, loadedMobileDeImage } from "@/lib/mobile-de/image-loader";
import { mobileDeImageCandidates } from "@/lib/mobile-de/images";
import styles from "./MobileDeCatalog.module.css";
type Size = "thumbnail" | "main" | "full";
type Displayed = { source: string; url: string; alt: string; size: Size };
export function MobileDeImage({ src, alt, size, lazy = false }: { src: string; alt: string; size: Size; lazy?: boolean }) {
  const frame = useRef<HTMLSpanElement>(null);
  const [enabled, setEnabled] = useState(!lazy);
  const [displayed, setDisplayed] = useState<Displayed | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  useEffect(() => {
    if (!lazy || !frame.current) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setEnabled(true); observer.disconnect(); }
    }, { rootMargin: "160px" });
    observer.observe(frame.current);
    return () => observer.disconnect();
  }, [lazy]);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    // A decoded thumbnail/main shot provides an immediate preview in a newly opened lightbox.
    const cached = loadedMobileDeImage(src, size) || loadedMobileDeImage(src, "main") || loadedMobileDeImage(src, "thumbnail");
    if (cached) Promise.resolve().then(() => { if (!cancelled) setDisplayed({source:src,url:cached,alt,size:loadedMobileDeImage(src,size) ? size : "thumbnail"}); });
    loadMobileDeImage(src, size, size === "thumbnail" ? "low" : "high").then((url) => {
      if (!cancelled) { setDisplayed({source:src,url,alt,size}); setFailed(null); }
    }, () => { if (!cancelled) setFailed(src); });
    return () => { cancelled = true; };
  }, [src, alt, size, enabled]);
  const loading = displayed?.source !== src || displayed?.size !== size;
  const error = failed === src && loading;
  return <span ref={frame} className={styles.imageFrame} aria-busy={loading && !error}>
    <img src={displayed?.url || mobileDeImageCandidates(src,size)[0]} alt={displayed?.alt || ""} referrerPolicy="no-referrer" loading={lazy ? "lazy" : "eager"} className={!displayed ? styles.imageHidden : undefined} aria-hidden={!displayed} />
    {loading && <span className={styles.imageStatus} role="status">{error ? "Фото временно недоступно" : <><span className={styles.imageSpinner} />Загружаем фото…</>}</span>}
  </span>;
}
