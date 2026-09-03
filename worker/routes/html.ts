import { getSettingValue } from "../db/settings";
import { getPageHeading } from "../../src/shared/page-heading";
import { canonicalPageUrl } from "../../src/shared/site-url";
import { getSiteOrigin } from "../site-origin";
import {
  buildRobotsTxt,
  buildSeoHeadTags,
  buildSitemapXml,
  getSeoSettings,
  injectSeoIntoHtml,
  normalizeCustomCodeSettings,
  type SeoPageMeta,
} from "../seo";

type SiteBase = { name: string; tagline: string; origin: string };

async function loadSiteBase(env: Env, fallbackOrigin: string): Promise<SiteBase> {
  const [name, tagline, origin] = await Promise.all([
    getSettingValue(env, "site.name", "SaaS Store"),
    getSettingValue(env, "site.tagline", ""),
    getSiteOrigin(env, fallbackOrigin),
  ]);
  return { name, tagline, origin };
}

export async function handleSeoFiles(env: Env, url: URL): Promise<Response | null> {
  if (url.pathname === "/robots.txt") {
    const [seo, origin] = await Promise.all([getSeoSettings(env), getSiteOrigin(env, url.origin)]);
    return new Response(buildRobotsTxt(seo, origin), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  }
  if (url.pathname === "/sitemap.xml") {
    const origin = await getSiteOrigin(env, url.origin);
    const rows = await env.DB.prepare("SELECT slug,published_at FROM pages WHERE status='published' AND noindex=0 ORDER BY CASE WHEN slug='home' THEN 0 ELSE 1 END, created_at").all<{ slug: string; published_at: string | null }>();
    const entries = rows.results.map((row): { loc: string; lastmod?: string | null; priority: number } => ({
      loc: row.slug === "home" ? "/" : `/${encodeURIComponent(row.slug)}`,
      lastmod: row.published_at,
      priority: row.slug === "home" ? 1.0 : 0.8,
    }));
    return new Response(buildSitemapXml(entries, origin), {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "no-store" },
    });
  }
  return null;
}

export async function handleHtmlPage(request: Request, env: Env, url: URL, assetResponse: Response): Promise<Response> {
  const [site, seo, customRaw] = await Promise.all([
    loadSiteBase(env, url.origin),
    getSeoSettings(env),
    getSettingValue(env, "site.custom_code", "{}"),
  ]);
  const custom = normalizeCustomCodeSettings(safeJsonParse(customRaw));

  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const slug = pathname === "/" ? "home" : decodeURIComponent(pathname.slice(1));
  const canonical = canonicalPageUrl(site.origin, pathname);

  let meta: SeoPageMeta;
  let pageHeading = "";
  if (pathname === "/checkout" || pathname === "/payment/result" || pathname === "/admin") {
    meta = {
      title: pathname === "/checkout" ? "确认订单" : pathname === "/payment/result" ? "支付结果" : "管理后台",
      description: site.tagline,
      keywords: seo.keywords,
      og_image: seo.default_og_image,
      noindex: true,
      canonical,
    };
  } else {
    const page = await env.DB.prepare(
      "SELECT title,seo_title,seo_description,seo_keywords,og_image,noindex,published_json FROM pages WHERE slug=? AND status='published'",
    ).bind(slug).first<{ title: string; seo_title: string | null; seo_description: string | null; seo_keywords: string | null; og_image: string | null; noindex: number; published_json: string | null }>();
    if (page) pageHeading = getPageHeading(safeJsonParse(page.published_json || "{}"), page.title || site.name).title;
    meta = {
      title: page?.seo_title || page?.title || site.name,
      description: page?.seo_description || site.tagline,
      keywords: page?.seo_keywords || seo.keywords,
      og_image: page?.og_image || seo.default_og_image,
      noindex: !page || page.noindex === 1,
      canonical,
    };
  }

  const headTags = buildSeoHeadTags(meta, { origin: site.origin, siteName: site.name, seo, customHead: custom.head_html });
  const html = await assetResponse.text();
  const injected = injectSeoIntoHtml(html, headTags, custom.body_html, pageHeading);
  const headers = new Headers();
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(injected, { status: assetResponse.status, headers });
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}
