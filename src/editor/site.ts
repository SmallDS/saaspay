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

export type SiteHeaderSettings = {
  enabled: boolean;
  show_nav: boolean;
  links: SiteLink[];
  cta_text: string;
  cta_href: string;
};

export type SiteFooterSettings = {
  enabled: boolean;
  tagline: string;
  links: SiteLink[];
};

export type SiteVisualSettings = {
  theme: SiteThemeSettings;
  header: SiteHeaderSettings;
  footer: SiteFooterSettings;
};

export type SiteSeoSettings = {
  keywords: string;
  default_og_image: string;
  robots_allow: boolean;
};

export type SiteLegalSettings = {
  icp_no: string;
  copyright: string;
};

export const defaultSeo: SiteSeoSettings = { keywords: "", default_og_image: "", robots_allow: true };
export const defaultLegal: SiteLegalSettings = { icp_no: "", copyright: "" };

export const defaultTheme: SiteThemeSettings = {
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

export const defaultHeader: SiteHeaderSettings = {
  enabled: true,
  show_nav: true,
  links: [{ label: "套餐", href: "#pricing" }, { label: "管理后台", href: "/admin" }],
  cta_text: "",
  cta_href: "",
};

export const defaultFooter: SiteFooterSettings = { enabled: true, tagline: "", links: [] };

export function safeSiteHref(value: string): string {
  const href = value.trim();
  return /^(?:#|\/(?!\/)|https:\/\/|mailto:)/i.test(href) ? href : "#";
}