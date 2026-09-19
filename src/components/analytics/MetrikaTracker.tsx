"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef } from "react";
import { trackMetrikaHit } from "@/lib/analytics/metrika";

function MetrikaTrackerContent() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const firstRender = useRef(true);

  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    const query = searchParams.toString();
    trackMetrikaHit(`${window.location.origin}${pathname}${query ? `?${query}` : ""}`);
  }, [pathname, searchParams]);

  return null;
}

export function MetrikaTracker() {
  return <Suspense fallback={null}><MetrikaTrackerContent /></Suspense>;
}
