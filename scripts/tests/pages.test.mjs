import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Render } from "@puckeditor/core";
import "./register-typescript.mjs";

const { createAiPageBlock, pageConfig } = await import("../../src/editor/config.tsx");
const { getPageHeading } = await import("../../src/shared/page-heading.ts");
const { handleHtmlPage, handleSeoFiles } = await import("../../worker/routes/html.ts");
const { handlePublic } = await import("../../worker/routes/public.ts");
const { handleAdmin } = await import("../../worker/routes/admin.ts");
const { createAdminSessionCookie } = await import("../../worker/auth/session.ts");
const { canonicalPageUrl, siteImageUrl } = await import("../../src/shared/site-url.ts");

function renderBlock(type, props) {
  return renderToStaticMarkup(createElement(Render, {
    config: pageConfig,
    data: { root: { props: {} }, content: [{ type, props: { id: "regression-block", ...props } }] },
  }));
}

test("published AI Hero without buttonHref renders with a usable default link", () => {
  const html = renderBlock("Hero", { title: "测试标题", description: "测试介绍", eyebrow: "产品", buttonText: "开始使用" });
  assert.match(html, /测试标题/);
  assert.match(html, /开始使用/);
  assert.match(html, /href="#pricing"/);
});

test("published AI CTA without buttonHref renders with a usable default link", () => {
  const html = renderBlock("CTA", { title: "开始使用", description: "测试介绍", buttonText: "立即购买" });
  assert.match(html, /href="#pricing"/);
});

test("invalid button link values do not crash or become executable links", () => {
  for (const buttonHref of [null, 42, {}, ["#pricing"], "javascript:alert(1)", "//attacker.example"]) {
    const html = renderBlock("Hero", { title: "页面仍可用", buttonText: "查看", buttonHref });
    assert.match(html, /页面仍可用/);
    assert.match(html, /href="#"/);
  }
});

test("explicit links on existing pages are preserved", () => {
  const html = renderBlock("Hero", { title: "登录", buttonText: "立即登录", buttonHref: " https://example.com/login " });
  assert.match(html, /href="https:\/\/example.com\/login"/);
});

test("AI-created blocks supply defaults and render after saving and reloading", () => {
  for (const type of ["Hero", "Features", "FAQ", "Text", "CTA"]) {
    const block = createAiPageBlock(type, { title: "AI 生成标题", buttonText: "开始使用", description: null, items: ["错误类型"], id: "untrusted-id", unknownField: "extra" });
    assert.notEqual(block.props.id, "untrusted-id");
    assert.equal(block.props.unknownField, undefined);
    const saved = JSON.parse(JSON.stringify(block));
    const html = renderBlock(saved.type, saved.props);
    assert.match(html, /AI 生成标题/);
    if (type === "Hero" || type === "CTA") assert.match(html, /href="#pricing"/);
  }
});

function htmlFixture(t) {
  const db = new DatabaseSync(":memory:");
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter((file) => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, migrations), "utf8"));
  t.after(() => db.close());
  const env = { ADMIN_USERNAME: "test-admin", ADMIN_PASSWORD: "test-password", DB: { prepare(sql) {
    const statement = db.prepare(sql);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return statement.get(...values) ?? null; },
      async all() { return { results: statement.all(...values) }; },
      async run() { return { meta: { changes: Number(statement.run(...values).changes) } }; },
    };
  } } };
  const template = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
  return {
    db,
    env,
    publish(data, title = "配镜工作台") {
      db.prepare("UPDATE pages SET title=?,status='published',published_json=?,draft_json=? WHERE slug='home'")
        .run(title, JSON.stringify(data), JSON.stringify({ content: [{ type: "Hero", props: { title: "未发布的草稿标题" } }] }));
    },
    async html(path = "/", userAgent = "Mozilla/5.0") {
      const request = new Request("https://shop.example" + path, { headers: { "user-agent": userAgent } });
      const response = await handleHtmlPage(request, env, new URL(request.url), new Response(template));
      assert.equal(response.status, 200);
      return response.text();
    },
  };
}

function renderPage(data, fallbackTitle) {
  return renderToStaticMarkup(createElement(Render, {
    config: pageConfig,
    data,
    metadata: { pageHeading: getPageHeading(data, fallbackTitle) },
  }));
}

test("published heading is present in the initial body for browsers and Bingbot and matches the rendered page", async (t) => {
  const fixture = htmlFixture(t);
  const data = { root: { props: {} }, content: [{ type: "Hero", props: { id: "hero", title: "全新的配镜工作台", buttonHref: "#pricing" } }] };
  fixture.publish(data);
  const html = await fixture.html();
  assert.match(html, /<body>[\s\S]*<main>[\s\S]*<h1 data-page-heading>全新的配镜工作台<\/h1>[\s\S]*<\/main>[\s\S]*<\/body>/);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /未发布的草稿标题|display:\s*none|<noscript/);
  assert.match(html, /<script type="module" src="\/src\/main.tsx"><\/script>/);
  assert.equal(await fixture.html("/", "Mozilla/5.0 (compatible; bingbot/2.0)"), html);
  const rendered = renderPage(data, "配镜工作台");
  assert.match(rendered, /<h1>全新的配镜工作台<\/h1>/);
  assert.equal((rendered.match(/<h1\b/g) ?? []).length, 1);
});

test("pages without a usable Hero retain a visible page-title H1 before and after rendering", async (t) => {
  const fixture = htmlFixture(t);
  for (const content of [[], [{ type: "Text", props: { id: "text", title: "使用说明", content: "说明正文" } }], [{ type: "Hero", props: { id: "hero", title: "  " } }], [{ type: "Hero", props: { id: "hero", title: {} } }]]) {
    const data = { root: { props: {} }, content };
    fixture.publish(data, "帮助中心");
    assert.match(await fixture.html(), /<h1 data-page-heading>帮助中心<\/h1>/);
    const rendered = renderPage(data, "帮助中心");
    assert.match(rendered, /<h1>帮助中心<\/h1>/);
    assert.equal((rendered.match(/<h1\b/g) ?? []).length, 1);
  }
  for (const invalid of ["not-json", "null", "{}", "[]"]) {
    fixture.db.prepare("UPDATE pages SET published_json=? WHERE slug='home'").run(invalid);
    assert.match(await fixture.html(), /<h1 data-page-heading>帮助中心<\/h1>/);
  }
});

test("page headings are escaped as text and limited to 150 Unicode characters in both render paths", async (t) => {
  const fixture = htmlFixture(t);
  const data = { root: { props: {} }, content: [{ type: "Hero", props: { id: "hero", title: 'A & <script>alert("x")</script> $&' } }] };
  fixture.publish(data);
  const html = await fixture.html();
  assert.match(html, /<h1 data-page-heading>A &amp; &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; \$&amp;<\/h1>/);
  assert.doesNotMatch(html, /<script>alert/);
  data.content[0].props.title = "  " + "配镜😀".repeat(60) + "  ";
  fixture.publish(data);
  const expected = "配镜😀".repeat(50);
  assert.ok((await fixture.html()).includes(`<h1 data-page-heading>${expected}</h1>`));
  assert.ok(renderPage(data, "配镜工作台").includes(`<h1>${expected}</h1>`));
});

test("unpublished, missing and transactional pages do not receive storefront headings", async (t) => {
  const fixture = htmlFixture(t);
  fixture.publish({ root: { props: {} }, content: [{ type: "Hero", props: { id: "hero", title: "私人草稿" } }] });
  fixture.db.prepare("UPDATE pages SET status='draft' WHERE slug='home'").run();
  for (const path of ["/", "/missing", "/admin", "/checkout", "/payment/result"]) {
    const html = await fixture.html(path);
    assert.doesNotMatch(html, /<h1\b|私人草稿/);
    assert.match(html, /name="robots" content="noindex, nofollow"/);
  }
});

test("the configured primary domain controls server SEO, sitemaps and the origin supplied to the client", async (t) => {
  const fixture = htmlFixture(t);
  fixture.db.prepare("UPDATE pages SET og_image='/media/cover.png' WHERE slug='home'").run();
  for (const domain of ["HTTPS://PUBLIC.EXAMPLE:443///", "https://new.example/"]) {
    fixture.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('site.primary_domain',?)").run(domain);
    const expected = new URL(domain).origin;
    const html = await fixture.html();
    assert.ok(html.includes(`<link rel="canonical" href="${expected}/">`));
    assert.ok(html.includes(`<meta property="og:url" content="${expected}/">`));
    assert.ok(html.includes(`<meta property="og:image" content="${expected}/media/cover.png">`));
    assert.ok(html.includes(`"url":"${expected}"`));
    const robots = await handleSeoFiles(fixture.env, new URL("https://shop.example/robots.txt"));
    assert.ok((await robots.text()).includes(`Sitemap: ${expected}/sitemap.xml`));
    const sitemap = await handleSeoFiles(fixture.env, new URL("https://shop.example/sitemap.xml"));
    assert.ok((await sitemap.text()).includes(`<loc>${expected}/</loc>`));
    const request = new Request("https://shop.example/api/public/site");
    const response = await handlePublic(request, fixture.env, new URL(request.url));
    const { site } = await response.json();
    assert.equal(site.public_origin, expected);
    assert.equal(canonicalPageUrl(site.public_origin, "/home/"), `${expected}/`);
    assert.equal(canonicalPageUrl(site.public_origin, "/%E5%B8%AE%E5%8A%A9/"), `${expected}/%E5%B8%AE%E5%8A%A9`);
    assert.ok((await fixture.html("/%E5%B8%AE%E5%8A%A9/")).includes(`href="${expected}/%E5%B8%AE%E5%8A%A9"`));
    assert.equal(siteImageUrl("/media/cover.png", site.public_origin), `${expected}/media/cover.png`);
    assert.equal(siteImageUrl("https://images.example/cover.png", site.public_origin), "https://images.example/cover.png");
    assert.equal(siteImageUrl("https://[invalid", site.public_origin), "");
  }
});

test("blank or invalid legacy primary domains fall back to the request origin without trusting proxy headers", async (t) => {
  const fixture = htmlFixture(t);
  for (const value of ["", " ", "not-a-url", "https://public.example/subpath", "javascript:alert(1)"]) {
    fixture.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES('site.primary_domain',?)").run(value);
    const request = new Request("https://shop.example/api/public/site", { headers: { "x-forwarded-host": "attacker.example", "x-forwarded-proto": "http" } });
    const response = await handlePublic(request, fixture.env, new URL(request.url));
    assert.equal((await response.json()).site.public_origin, "https://shop.example");
    assert.match(await fixture.html(), /rel="canonical" href="https:\/\/shop.example\/"/);
  }
});

test("saving the primary domain normalizes origins and rejects invalid input before changing settings", async (t) => {
  const fixture = htmlFixture(t);
  const cookie = (await createAdminSessionCookie(fixture.env)).split(";")[0];
  const call = async (site) => {
    const request = new Request("https://shop.example/api/admin/settings", { method: "PUT", headers: { cookie, origin: "https://shop.example", "content-type": "application/json" }, body: JSON.stringify({ site }) });
    return handleAdmin(request, fixture.env, new URL(request.url));
  };
  assert.equal((await call({ primary_domain: " HTTPS://PUBLIC.EXAMPLE:443/// " })).status, 200);
  assert.equal(fixture.db.prepare("SELECT value FROM settings WHERE key='site.primary_domain'").get().value, "https://public.example");
  const nameBefore = fixture.db.prepare("SELECT value FROM settings WHERE key='site.name'").get().value;
  for (const value of ["example.com", "https://example.com/path", "https://example.com/?a=1", "https://example.com/#a", "https://user:password@example.com", "javascript:alert(1)", {}, 42]) {
    const response = await call({ primary_domain: value, name: "should not be saved" });
    assert.equal(response.status, 400);
    assert.equal(fixture.db.prepare("SELECT value FROM settings WHERE key='site.name'").get().value, nameBefore);
    assert.equal(fixture.db.prepare("SELECT value FROM settings WHERE key='site.primary_domain'").get().value, "https://public.example");
  }
  assert.equal((await call({ primary_domain: "" })).status, 200);
  assert.equal(fixture.db.prepare("SELECT value FROM settings WHERE key='site.primary_domain'").get().value, "");
});
