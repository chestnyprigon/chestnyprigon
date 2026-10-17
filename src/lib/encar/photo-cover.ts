const NON_COVER_TYPES = new Set(["inner", "inside", "interior", "option", "салон", "детали"]);
const EXTERIOR_TYPES = new Set(["outer", "outside", "exterior", "кузов"]);

/** Same cover priorities as TL Auto: full-car 001, frontal 003, then rear views. */
export function encarCoverScore(source: string, type?: string | null) {
  const category = type?.toLowerCase() ?? "";
  if (NON_COVER_TYPES.has(category)) return 0;

  try {
    const url = new URL(source, "https://ci.encar.com");
    if (url.hostname === "ci.encar.com" && /^\/carpicture(?:\/carpicture)?\d+\//i.test(url.pathname)) {
      const code = Number(url.pathname.match(/_(\d{3})\.(?:jpg|jpeg|webp)$/i)?.[1]);
      if (code === 1) return 1000;
      if (code === 3) return 900;
      if (code === 2) return 800;
      if (code === 4) return 700;
      return 100;
    }
  } catch {
    // Keep the existing gallery usable for non-Encar or malformed legacy URLs.
  }
  if (EXTERIOR_TYPES.has(category)) return 400;
  if (category === "thumbnail") return 300;
  return 120;
}
