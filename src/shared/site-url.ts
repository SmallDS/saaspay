export function normalizeSiteOrigin(value: unknown): string {
  if (typeof value !== "string") return "";
  const input = value.trim();
  if (!/^https?:\/\//i.test(input) || /[\s\\]/.test(input)) return "";
  try {
    const url = new URL(input);
    if (url.username || url.password || url.search || url.hash || /[^/]/.test(url.pathname)) return "";
    return url.origin;
  } catch {
    return "";
  }
}

export function canonicalPageUrl(origin: string, pathname: string): string {
  const path = pathname.replace(/^\/+|\/+$/g, "");
  const url = new URL(origin);
  url.pathname = path === "home" || !path ? "/" : `/${path}`;
  url.search = "";
  url.hash = "";
  return url.href;
}

export function siteImageUrl(value: unknown, origin: string): string {
  if (typeof value !== "string" || !/^(https:\/\/|\/(?!\/))/i.test(value.trim())) return "";
  try {
    return new URL(value.trim(), origin).href;
  } catch {
    return "";
  }
}
