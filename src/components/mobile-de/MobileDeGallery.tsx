"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";
import styles from "./MobileDeCatalog.module.css";

export function MobileDeGallery({ images, title }: { images: string[]; title: string }) {
  const [selected, setSelected] = useState(images[0]);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState<Record<string, boolean>>({});
  const available = images.filter((url) => !failed[url]);
  const index = Math.max(0, available.indexOf(selected));
  const active = available[index];
  const thumbnails = useRef<Array<HTMLButtonElement | null>>([]);
  const previousPhoto = useRef(active);
  const rejectImage = (url: string) => setFailed((current) => current[url] ? current : ({ ...current, [url]: true }));
  const move = (step: number) => { if (available.length) setSelected(available[(index + step + available.length) % available.length]); };
  useEffect(() => {
    if (previousPhoto.current !== active) thumbnails.current[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    previousPhoto.current = active;
  }, [active, index]);
  useEffect(() => {
    if (!expanded || !available.length) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
      if (event.key === "ArrowRight") setSelected(available[(index + 1) % available.length]);
      if (event.key === "ArrowLeft") setSelected(available[(index - 1 + available.length) % available.length]);
    };
    window.addEventListener("keydown", keydown);
    return () => { document.body.style.overflow = previous; window.removeEventListener("keydown", keydown); };
  }, [expanded, available, index]);
  if (!available.length) return <div className={styles.galleryEmpty}>Фотографии автомобиля пока недоступны</div>;
  const photo = <img ref={(element) => { if (element?.complete && !element.naturalWidth) rejectImage(active); }} key={active} referrerPolicy="no-referrer" src={active} alt={`${title} — фото ${index + 1}`} onError={() => rejectImage(active)} />;
  const controls = <><button onClick={() => move(-1)} aria-label="Предыдущее фото" disabled={available.length < 2}><ChevronLeft /></button><span>{index + 1} / {available.length}</span><button onClick={() => move(1)} aria-label="Следующее фото" disabled={available.length < 2}><ChevronRight /></button></>;
  return <div className={styles.gallery}>
    <div className={styles.galleryMain}><button className={styles.photoButton} onClick={() => setExpanded(true)} aria-label="Открыть фотографию на весь экран">{photo}<Maximize2 className={styles.expandIcon} /></button><div className={styles.galleryControls}>{controls}</div></div>
    <div className={styles.thumbnails}>{available.map((url, position) => <button ref={(element) => { thumbnails.current[position] = element; }} key={url} onClick={() => setSelected(url)} aria-label={`Фото ${position + 1}`} aria-pressed={position === index}><img ref={(element) => { if (element?.complete && !element.naturalWidth) rejectImage(url); }} src={url} referrerPolicy="no-referrer" alt="" loading="lazy" onError={() => rejectImage(url)} /></button>)}</div>
    {expanded && <div className={styles.lightbox} role="dialog" aria-modal="true" aria-label={`Фотографии ${title}`}><button className={styles.closeGallery} onClick={() => setExpanded(false)} aria-label="Закрыть галерею" autoFocus><X /></button>{photo}<div className={styles.galleryControls}>{controls}</div></div>}
  </div>;
}
