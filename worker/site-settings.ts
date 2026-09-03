import { recordValue } from "./http";

export type SiteLink = { label: string; href: string };
export type SiteThemeSettings = {
  primary_color: string;
  accent_color: string;
  surface_color: string;
  page_background: string;
  text_color: string;
  muted_color: string;
  font_family: string;
  radius: string;
  container_width: string;
  section_spacing: string;
  header_height: string;
};
export type SiteHeaderSettings = { enabled: boolean; show_nav: boolean; links: SiteLink[]; cta_text: string; cta_href: string };
export type SiteFooterSettings = { enabled: boolean; tagline: string; links: SiteLink[] };

export const defaultThemeSettings: SiteThemeSettings = {
  primary_color: "#3159ca",
  accent_color: "#172033",
  surface_color: "#ffffff",
  page_background: "#f6f8fb",
  text_color: "#172033",
  muted_color: "#667085",
  font_family: "Inter, ui-sans-serif, system-ui, sans-serif",
  radius: "16px",
  container_width: "1120px",
  section_spacing: "86px",
  header_height: "68px",
};
export const defaultHeaderSettings: SiteHeaderSettings = {
  enabled: true,
  show_nav: true,
  links: [{ label: "套餐", href: "#pricing" }, { label: "管理后台", href: "/admin" }],
  cta_text: "",
  cta_href: "",
};
export const defaultFooterSettings: SiteFooterSettings = { enabled: true, tagline: "", links: [] };

export function textValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}
function safeHexColor(value: unknown, fallback: string): string {
  const color = textValue(value);
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color : fallback;
}
export function safeSiteHref(value: unknown): string {
  const href = textValue(value).slice(0, 500);
  return /^(?:#|\/(?!\/)|https:\/\/|mailto:)/i.test(href) ? href : "";
}
function normalizeSiteLinks(value: unknown): SiteLink[] {
  if (!Array.isArray(value)) return [];
  return value.map((item): SiteLink | null => {
    const link = recordValue(item);
    const label = textValue(link.label).slice(0, 80);
    const href = safeSiteHref(link.href);
    return label && href ? { label, href } : null;
  }).filter((item): item is SiteLink => Boolean(item)).slice(0, 20);
}
export function normalizeThemeSettings(value: unknown): SiteThemeSettings {
  const input = recordValue(value);
  const dimension = (key: string, fallback: string, pattern: RegExp) => {
    const candidate = textValue(input[key], fallback);
    return pattern.test(candidate) ? candidate : fallback;
  };
  return {
    primary_color: safeHexColor(input.primary_color, defaultThemeSettings.primary_color),
    accent_color: safeHexColor(input.accent_color, defaultThemeSettings.accent_color),
    surface_color: safeHexColor(input.surface_color, defaultThemeSettings.surface_color),
    page_background: safeHexColor(input.page_background, defaultThemeSettings.page_background),
    text_color: safeHexColor(input.text_color, defaultThemeSettings.text_color),
    muted_color: safeHexColor(input.muted_color, defaultThemeSettings.muted_color),
    font_family: textValue(input.font_family, defaultThemeSettings.font_family).replace(/[<>]/g, "").slice(0, 200),
    radius: dimension("radius", defaultThemeSettings.radius, /^\d+(?:\.\d+)?px$/),
    container_width: dimension("container_width", defaultThemeSettings.container_width, /^\d+(?:\.\d+)?px$/),
    section_spacing: dimension("section_spacing", defaultThemeSettings.section_spacing, /^\d+(?:\.\d+)?px$/),
    header_height: dimension("header_height", defaultThemeSettings.header_height, /^\d+(?:\.\d+)?px$/),
  };
}
export function normalizeHeaderSettings(value: unknown): SiteHeaderSettings {
  const input = recordValue(value);
  return {
    enabled: input.enabled !== false,
    show_nav: input.show_nav !== false,
    links: normalizeSiteLinks(input.links),
    cta_text: textValue(input.cta_text).slice(0, 80),
    cta_href: safeSiteHref(input.cta_href),
  };
}
export function normalizeFooterSettings(value: unknown): SiteFooterSettings {
  const input = recordValue(value);
  return {
    enabled: input.enabled !== false,
    tagline: textValue(input.tagline).slice(0, 240),
    links: normalizeSiteLinks(input.links),
  };
}
export function parseSettingJson<T>(raw: string | undefined, fallback: T, normalize: (value: unknown) => T): T {
  try {
    return normalize(JSON.parse(raw ?? ""));
  } catch {
    return fallback;
  }
}
