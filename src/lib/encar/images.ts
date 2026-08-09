const encarImageHost = "https://ci.encar.com";

/**
 * Encar returns a 640×360 legacy file when the photo path is used directly.
 * Its own frontend requests the same file through the `carpicture/` image
 * policy endpoint, which provides the 1280×768 gallery rendition.
 */
export function encarPhotoUrl(source: string) {
  const value = source.trim();
  if (!value) return value;

  let url: URL;
  try {
    url = new URL(value, encarImageHost);
  } catch {
    return value;
  }

  if (url.origin !== encarImageHost) return url.toString();
  if (!url.pathname.startsWith("/carpicture/") && /^\/carpicture\d+\//.test(url.pathname)) {
    url.pathname = `/carpicture${url.pathname}`;
  }

  if (!/^\/carpicture\/carpicture\d+\//.test(url.pathname)) return url.toString();

  url.searchParams.set("impolicy", "heightRate");
  url.searchParams.set("rh", "768");
  url.searchParams.set("cw", "1280");
  url.searchParams.set("ch", "768");
  url.searchParams.set("cg", "Center");
  url.searchParams.set("wtmk", `${encarImageHost}/wt_mark/w_mark_04.png`);
  return url.toString();
}
