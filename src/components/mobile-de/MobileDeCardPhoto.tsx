"use client";

import { useState } from "react";
import styles from "./MobileDeCatalog.module.css";

export function MobileDeCardPhoto({ src, alt }: { src: string; alt: string }) {
  const [failed, setFailed] = useState(false);

  if (failed) {
    return (
      <span className={styles.noImage} role="img" aria-label={`Фото временно недоступно: ${alt}`}>
        Фото временно недоступно
      </span>
    );
  }

  return <img referrerPolicy="no-referrer" src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}
