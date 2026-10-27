"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import styles from "./MobileDeCatalog.module.css";

export function MobileDeGallery({ images, title }: { images: string[]; title: string }) {
  const [index, setIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const move = (step: number) => setIndex((current) => (current + step + images.length) % images.length);
  useEffect(() => {
    if (!expanded) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (event.key === "ArrowRight") setIndex((current) => (current + 1) % images.length);
      if (event.key === "ArrowLeft") setIndex((current) => (current - 1 + images.length) % images.length);
    };
    window.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", keydown); };
  }, [expanded, images.length]);
  if (!images.length) return <div className={styles.galleryEmpty}>Фотографии автомобиля пока недоступны</div>;
  const photo = failed[images[index]] ? <div className={styles.galleryEmpty}>Не удалось загрузить фото. Выберите другое изображение.</div> : <img src={images[index]} alt={`${title} — фото ${index + 1}`} onError={() => setFailed((current) => ({ ...current, [images[index]]: true }))} />;
  const controls = <><button onClick={() => move(-1)} aria-label="Предыдущее фото"><ChevronLeft /></button><span>{index + 1} / {images.length}</span><button onClick={() => move(1)} aria-label="Следующее фото"><ChevronRight /></button></>;
  return <div className={styles.gallery}>
    <div className={styles.galleryMain}><button className={styles.photoButton} onClick={() => setExpanded(true)} aria-label="Открыть фотографию на весь экран">{photo}<Maximize2 className={styles.expandIcon} /></button><div className={styles.galleryControls}>{controls}</div></div>
    <div className={styles.thumbnails}>{images.map((url, position) => <button key={url} onClick={() => setIndex(position)} aria-label={`Фото ${position + 1}`} aria-pressed={position === index}><img src={url} alt="" loading="lazy" /></button>)}</div>
    {expanded && <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label={`Фотографии ${title}`}><button className={styles.closeGallery} onClick={() => setExpanded(false)} aria-label="Закрыть галерею" autoFocus><X /></button>{photo}<div className={styles.galleryControls}>{controls}</div></div>}
  </div>;
}
