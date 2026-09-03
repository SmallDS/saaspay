import { getSettingValue } from "./db/settings";
import { recordValue } from "./http";
import { parseSettingJson, textValue } from "./site-settings";

export type SeoSettings = {
  keywords: string;
  default_og_image: string;
  robots_allow: boolean;
};

export type LegalSettings = {
  icp_no: string;
  copyright: string;
};

export type CustomCodeSettings = {
  head_html: string;
  body_html: string;
};

export const defaultSeoSettings: SeoSettings = { keywords: "", default_og_image: "", robots_allow: true };
export const defaultLegalSettings: LegalSettings = { icp_no: "", copyright: "" };
export const defaultCustomCodeSettings: CustomCodeSettings = { head_html: "", body_html: "" };

export function normalizeSeoSettings(value: unknown): SeoSettings {
  const input = recordValue(value);
  const image = textValue(input.default_og_image).slice(0, 500);
  return {
    keywords: textValue(input.keywords).slice(0, 200),
    default_og_image: /^(https:\/\/|\/(?!\/))/i.test(image) ? image : "",
    robots_allow: input.robots_allow !== false,
  };
}

export function normalizeLegalSettings(value: unknown): LegalSettings {
  const input = recordValue(value);
  return {
    icp_no: textValue(input.icp_no).slice(0, 60),
    copyright: textValue(input.copyright).slice(0, 120),
  };
}

export function normalizeCustomCodeSettings(value: unknown): CustomCodeSettings {
  const input = recordValue(value);
  return {
    head_html: textValue(input.head_html).slice(0, 20000),
    body_html: textValue(input.body_html).slice(0, 20000),
  };
}

export async function getSeoSettings(env: Env): Promise<SeoSettings> {
  return parseSettingJson(await getSettingValue(env, "site.seo", "{}"), defaultSeoSettings, normalizeSeoSettings);
}

export async function getLegalSettings(env: Env): Promise<LegalSettings> {
  return parseSettingJson(await getSettingValue(env, "site.legal", "{}"), defaultLegalSettings, normalizeLegalSettings);
}

export type SeoPageMeta = {
  title: string;
  description: string;
  keywords: string;
  og_image: string;
  noindex: boolean;
  canonical: string;
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function buildSeoHeadTags(meta: SeoPageMeta, options: { origin: string; siteName: string; seo: SeoSettings; customHead: string }): string {
  const title = escapeHtml(meta.title || options.siteName);
  const description = escapeHtml(stripTags(meta.description).slice(0, 200));
  const keywords = escapeHtml(meta.keywords || options.seo.keywords);
  const ogImage = meta.og_image || options.seo.default_og_image;
  const ogImageAbs = ogImage && !/^https:\/\//i.test(ogImage) ? `${options.origin}${ogImage}` : ogImage;
  const tags: string[] = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    keywords ? `<meta name="keywords" content="${keywords}">` : "",
    meta.noindex ? `<meta name="robots" content="noindex, nofollow">` : `<meta name="robots" content="index, follow">`,
    `<meta property="og:site_name" content="${escapeHtml(options.siteName)}">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${escapeHtml(meta.canonical)}">`,
    ogImageAbs ? `<meta property="og:image" content="${escapeHtml(ogImageAbs)}">` : "",
    `<meta name="twitter:card" content="${ogImageAbs ? "summary_large_image" : "summary"}">`,
    `<link rel="canonical" href="${escapeHtml(meta.canonical)}">`,
    `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: options.siteName,
      url: options.origin,
    })}</script>`,
    options.customHead,
  ];
  return tags.filter(Boolean).join("\n");
}

// 将 SEO 标签注入 SPA 的 index.html：<title> 整体替换，其余插入 </head> 前、自定义代码插入 </body> 前。
export function injectSeoIntoHtml(html: string, headTags: string, customBody: string): string {
  let output = html;
  const titleMatch = /<title>[\s\S]*?<\/title>/i.exec(headTags);
  if (titleMatch) {
    output = /<title>[\s\S]*?<\/title>/i.test(output)
      ? output.replace(/<title>[\s\S]*?<\/title>/i, titleMatch[0])
      : output;
  }
  const restTags = headTags.replace(/<title>[\s\S]*?<\/title>/i, "");
  const headAnchor = /<\/head>/i;
  output = headAnchor.test(output) ? output.replace(headAnchor, `${restTags}\n</head>`) : output + restTags;
  if (customBody) {
    const bodyAnchor = /<\/body>/i;
    output = bodyAnchor.test(output) ? output.replace(bodyAnchor, `${customBody}\n</body>`) : output + customBody;
  }
  return output;
}

export function buildRobotsTxt(seo: SeoSettings, origin: string): string {
  if (!seo.robots_allow) {
    return "User-agent: *\nDisallow: /\n";
  }
  return [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /checkout",
    "Disallow: /payment/result",
    "",
    `Sitemap: ${origin}/sitemap.xml`,
    "",
  ].join("\n");
}

export type SitemapEntry = { loc: string; lastmod?: string | null; priority: number };

export function buildSitemapXml(entries: SitemapEntry[], origin: string): string {
  const urls = entries.map((entry) => {
    const lastmod = entry.lastmod ? `<lastmod>${escapeHtml(entry.lastmod)}</lastmod>` : "";
    return `<url><loc>${escapeHtml(origin + entry.loc)}</loc>${lastmod}<priority>${entry.priority.toFixed(1)}</priority></url>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}
