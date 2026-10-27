"use client";
/* eslint-disable @next/next/no-img-element */
import { useEffect, useRef, useState } from "react";
import { mobileDeImageCandidates } from "@/lib/mobile-de/images";

export function MobileDeImage({ src, alt, size, lazy = false }: { src: string; alt: string; size: "thumbnail" | "main" | "full"; lazy?: boolean }) {
  const candidates = mobileDeImageCandidates(src, size);
  const [attempt, setAttempt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Retry each URL once: the image CDN also intermittently returns 403 for valid photos.
  const exhausted = attempt >= candidates.length * 2;
  const candidate = candidates[Math.floor(attempt / 2)];
  const retry = () => {
    if (timer.current || exhausted) return;
    timer.current = setTimeout(() => { timer.current = null; setAttempt((current) => current + 1); }, attempt % 2 === 0 ? 500 : 100);
  };
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  if (exhausted) return <span style={{display:"grid",placeItems:"center",height:"100%",padding:8,color:"#91a0ab",fontSize:11}}>Фото временно недоступно</span>;
  return <img key={`${candidate}-${attempt}`} src={candidate} alt={alt} referrerPolicy="no-referrer" loading={lazy ? "lazy" : "eager"} onError={retry} ref={(element) => { if (element?.complete && !element.naturalWidth) retry(); }} />;
}
