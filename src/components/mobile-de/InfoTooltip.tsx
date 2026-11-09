"use client";

import { Info } from "lucide-react";
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";

type Position = { left: number; top: number };

export function InfoTooltip({ label, children }: { label: string; children: string }) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !tooltipRef.current) return;
    const place = () => {
      if (!triggerRef.current || !tooltipRef.current) return;
      const anchor = triggerRef.current.getBoundingClientRect();
      const bubble = tooltipRef.current.getBoundingClientRect();
      const gutter = 12;
      const left = Math.min(Math.max(gutter, anchor.left), window.innerWidth - bubble.width - gutter);
      const top = anchor.top >= bubble.height + gutter
        ? anchor.top - bubble.height - 8
        : Math.min(window.innerHeight - bubble.height - gutter, anchor.bottom + 8);
      setPosition({ left, top: Math.max(gutter, top) });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, children]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !tooltipRef.current?.contains(target)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return <span className="info-tooltip" ref={rootRef}>
    <button
      className="info-tooltip-trigger"
      ref={triggerRef}
      type="button"
      aria-label={label}
      aria-expanded={open}
      aria-describedby={open ? tooltipId : undefined}
      onClick={() => setOpen((value) => !value)}
    >
      <Info size={15} strokeWidth={2} aria-hidden="true" />
    </button>
    {open && typeof document !== "undefined" ? createPortal(
      <span
        className="info-tooltip-content"
        id={tooltipId}
        ref={tooltipRef}
        role="tooltip"
        onClick={(event) => event.stopPropagation()}
        style={position ? { left: position.left, top: position.top, visibility: "visible" } : { visibility: "hidden" }}
      >
        {children}
      </span>,
      document.body,
    ) : null}
  </span>;
}
