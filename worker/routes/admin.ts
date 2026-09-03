import { isAdmin, assertSameOrigin } from "../auth/session";
import { bad, bodyJson, id, json, nowIso } from "../http";
import { listSettings, setSetting } from "../db/settings";
import {
  AI_MODEL_OPTIONS,
  DEFAULT_AI_MODEL,
  AiBudgetExceededError,
  describeAssetImage,
  generateProductCopy,
  generateSectionProps,
  generateSeoMeta,
  getAiUsage,
} from "../ai";
import { deletePaymentOrder, closeProviderOrder, loadPaymentOrder, syncProviderOrder } from "../orders/lifecycle";
import { issueRefund, syncRefund } from "../orders/refunds";
import type { WebhookQueueMessage } from "../webhook/outbound";
import {
  normalizeCustomCodeSettings,
  normalizeLegalSettings,
  normalizeSeoSettings,
} from "../seo";
import {
  defaultFooterSettings,
  defaultHeaderSettings,
  defaultThemeSettings,
  normalizeFooterSettings,
  normalizeHeaderSettings,
  normalizeThemeSettings,
  parseSettingJson,
} from "../site-settings";

async function requireAdmin(request: Request, env: Env): Promise<Response | null> {
  if (!(await isAdmin(request, env))) return bad("未登录或会话已过期", 401);
  if (!assertSameOrigin(request)) return bad("请求来源校验失败", 403);
  return null;
}

async function adminSettings(env: Env): Promise<Record<string, unknown>> {
  const rows = await listSettings(env);
  const value = (key: string, fallback = "") => rows[key]?.value ?? fallback;
  return {
    site: {
      name: value("site.name", "SaaS Store"),
      tagline: value("site.tagline"),
      primary_domain: value("site.primary_domain"),
      theme: parseSettingJson(value("site.theme"), defaultThemeSettings, normalizeThemeSettings),
      header: parseSettingJson(value("site.header"), defaultHeaderSettings, normalizeHeaderSettings),
      footer: parseSettingJson(value("site.footer"), defaultFooterSettings, normalizeFooterSettings),
    },
    alipay: {
      enabled: value("payment.alipay.enabled", "false") === "true",
      app_id: value("payment.alipay.app_id"),
      gateway: value("payment.alipay.gateway", "https://openapi.alipay.com/gateway.do"),
      seller_id: value("payment.alipay.seller_id"),
      private_key_configured: Boolean(rows["payment.alipay.private_key"]?.value),
      public_key_configured: Boolean(rows["payment.alipay.public_key"]?.value),
    },
    wechat: {
      enabled: value("payment.wechat.enabled", "false") === "true",
      app_id: value("payment.wechat.app_id"),
      mch_id: value("payment.wechat.mch_id"),
      mch_serial_no: value("payment.wechat.mch_serial_no"),
      api_v3_key_configured: Boolean(rows["payment.wechat.api_v3_key"]?.value),
      private_key_configured: Boolean(rows["payment.wechat.private_key"]?.value),
      public_key_configured: Boolean(rows["payment.wechat.public_key"]?.value),
      public_key_id: value("payment.wechat.public_key_id"),
    },
    seo: parseSettingJson(value("site.seo"), { keywords: "", default_og_image: "", robots_allow: true }, normalizeSeoSettings),
    legal: parseSettingJson(value("site.legal"), { icp_no: "", copyright: "" }, normalizeLegalSettings),
    custom_code: parseSettingJson(value("site.custom_code"), { head_html: "", body_html: "" }, normalizeCustomCodeSettings),
    ai: {
      enabled: value("ai.enabled", "false") === "true",
      model: value("ai.model", DEFAULT_AI_MODEL),
    },
    webhook: {
      enabled: value("webhook.enabled", "false") === "true",
      url: value("webhook.url"),
      events: (() => { try { return JSON.parse(value("webhook.events", "[]")) as string[]; } catch { return []; } })(),
      secret_configured: Boolean(rows["webhook.secret"]?.value),
    },
  };
}

export async function handleAdmin(request: Request, env: Env, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (!pathname.startsWith("/api/admin/")) return null;
  const denied = await requireAdmin(request, env);
  if (denied) return denied;

  if (pathname === "/api/admin/dashboard" && request.method === "GET") {
    const [orders, revenue, products, pages] = await env.DB.batch([
      env.DB.prepare("SELECT COUNT(*) count FROM orders"),
      env.DB.prepare("SELECT COALESCE(SUM(amount_cents-refunded_cents),0) total FROM orders WHERE status IN ('paid','refunded')"),
      env.DB.prepare("SELECT COUNT(*) count FROM products WHERE status='active'"),
      env.DB.prepare("SELECT COUNT(*) count FROM pages WHERE status='published'"),
    ]);
    const recent = await env.DB.prepare("SELECT order_no,product_name,plan_name,amount_cents,status,created_at FROM orders ORDER BY created_at DESC LIMIT 8").all();
    return json({
      ok: true,
      stats: {
        orders: (orders.results?.[0] as { count?: number } | undefined)?.count ?? 0,
        revenue_cents: (revenue.results?.[0] as { total?: number } | undefined)?.total ?? 0,
        products: (products.results?.[0] as { count?: number } | undefined)?.count ?? 0,
        pages: (pages.results?.[0] as { count?: number } | undefined)?.count ?? 0,
      },
      recent_orders: recent.results,
    });
  }

  if (pathname === "/api/admin/settings" && request.method === "GET") return json({ ok: true, settings: await adminSettings(env) });
  if (pathname === "/api/admin/settings" && request.method === "PUT") {
    const input = await bodyJson<{
      site?: { name?: string; tagline?: string; primary_domain?: string; theme?: Record<string, unknown>; header?: Record<string, unknown>; footer?: Record<string, unknown> };
      alipay?: { enabled?: boolean; app_id?: string; gateway?: string; seller_id?: string; private_key?: string; public_key?: string };
      wechat?: { enabled?: boolean; app_id?: string; mch_id?: string; mch_serial_no?: string; api_v3_key?: string; private_key?: string; public_key?: string; public_key_id?: string };
      seo?: Record<string, unknown>;
      legal?: Record<string, unknown>;
      custom_code?: Record<string, unknown>;
      ai?: { enabled?: boolean; model?: string };
      webhook?: { enabled?: boolean; url?: string; events?: string[]; secret?: string; regenerate_secret?: boolean };
    }>(request);
    if (input.wechat?.api_v3_key?.trim() && input.wechat.api_v3_key.trim().length !== 32) {
      return bad("微信支付 APIv3 密钥必须为 32 位字符");
    }
    const writes: Promise<void>[] = [];
    if (input.site) {
      if (typeof input.site.name === "string") writes.push(setSetting(env, "site.name", input.site.name.trim()));
      if (typeof input.site.tagline === "string") writes.push(setSetting(env, "site.tagline", input.site.tagline.trim()));
      if (typeof input.site.primary_domain === "string") writes.push(setSetting(env, "site.primary_domain", input.site.primary_domain.trim().replace(/\/$/, "")));
      if (input.site.theme) writes.push(setSetting(env, "site.theme", JSON.stringify(normalizeThemeSettings(input.site.theme))));
      if (input.site.header) writes.push(setSetting(env, "site.header", JSON.stringify(normalizeHeaderSettings(input.site.header))));
      if (input.site.footer) writes.push(setSetting(env, "site.footer", JSON.stringify(normalizeFooterSettings(input.site.footer))));
    }
    if (input.alipay) {
      if (typeof input.alipay.enabled === "boolean") writes.push(setSetting(env, "payment.alipay.enabled", String(input.alipay.enabled)));
      if (typeof input.alipay.app_id === "string") writes.push(setSetting(env, "payment.alipay.app_id", input.alipay.app_id.trim()));
      if (typeof input.alipay.gateway === "string") writes.push(setSetting(env, "payment.alipay.gateway", input.alipay.gateway.trim()));
      if (typeof input.alipay.seller_id === "string") writes.push(setSetting(env, "payment.alipay.seller_id", input.alipay.seller_id.trim()));
      if (input.alipay.private_key?.trim()) writes.push(setSetting(env, "payment.alipay.private_key", input.alipay.private_key.trim(), true));
      if (input.alipay.public_key?.trim()) writes.push(setSetting(env, "payment.alipay.public_key", input.alipay.public_key.trim(), true));
    }
    if (input.wechat) {
      if (typeof input.wechat.enabled === "boolean") writes.push(setSetting(env, "payment.wechat.enabled", String(input.wechat.enabled)));
      if (typeof input.wechat.app_id === "string") writes.push(setSetting(env, "payment.wechat.app_id", input.wechat.app_id.trim()));
      if (typeof input.wechat.mch_id === "string") writes.push(setSetting(env, "payment.wechat.mch_id", input.wechat.mch_id.trim()));
      if (typeof input.wechat.mch_serial_no === "string") writes.push(setSetting(env, "payment.wechat.mch_serial_no", input.wechat.mch_serial_no.trim()));
      if (typeof input.wechat.public_key_id === "string") writes.push(setSetting(env, "payment.wechat.public_key_id", input.wechat.public_key_id.trim()));
      if (input.wechat.api_v3_key?.trim()) writes.push(setSetting(env, "payment.wechat.api_v3_key", input.wechat.api_v3_key.trim(), true));
      if (input.wechat.private_key?.trim()) writes.push(setSetting(env, "payment.wechat.private_key", input.wechat.private_key.trim(), true));
      if (input.wechat.public_key?.trim()) writes.push(setSetting(env, "payment.wechat.public_key", input.wechat.public_key.trim(), true));
    }
    if (input.seo) writes.push(setSetting(env, "site.seo", JSON.stringify(normalizeSeoSettings(input.seo))));
    if (input.legal) writes.push(setSetting(env, "site.legal", JSON.stringify(normalizeLegalSettings(input.legal))));
    if (input.custom_code) writes.push(setSetting(env, "site.custom_code", JSON.stringify(normalizeCustomCodeSettings(input.custom_code))));
    if (input.ai) {
      if (typeof input.ai.enabled === "boolean") writes.push(setSetting(env, "ai.enabled", String(input.ai.enabled)));
      if (typeof input.ai.model === "string") {
        const allowed = AI_MODEL_OPTIONS.some((option) => option.value === input.ai?.model);
        if (!allowed) return bad("不支持的 AI 模型");
        writes.push(setSetting(env, "ai.model", input.ai.model));
      }
    }
    if (input.webhook) {
      if (typeof input.webhook.enabled === "boolean") writes.push(setSetting(env, "webhook.enabled", String(input.webhook.enabled)));
      if (typeof input.webhook.url === "string") {
        const hookUrl = input.webhook.url.trim();
        if (hookUrl && !/^https:\/\//i.test(hookUrl)) return bad("Webhook URL 必须使用 HTTPS");
        writes.push(setSetting(env, "webhook.url", hookUrl));
      }
      if (Array.isArray(input.webhook.events)) writes.push(setSetting(env, "webhook.events", JSON.stringify(input.webhook.events)));
      if (input.webhook.secret?.trim()) writes.push(setSetting(env, "webhook.secret", input.webhook.secret.trim(), true));
      if (input.webhook.regenerate_secret) {
        const generated = `whsec_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
        writes.push(setSetting(env, "webhook.secret", generated, true));
      }
    }
    await Promise.all(writes);
    return json({ ok: true, settings: await adminSettings(env) });
  }

  function aiError(error: unknown): Response {
    const message = error instanceof Error ? error.message : "AI 调用失败";
    return bad(message, error instanceof AiBudgetExceededError ? 429 : 502);
  }

  if (pathname === "/api/admin/ai/usage" && request.method === "GET") {
    return json({ ok: true, usage: await getAiUsage(env) });
  }
  if (pathname === "/api/admin/ai/product-copy" && request.method === "POST") {
    const input = await bodyJson<{ name?: string; points?: string }>(request);
    if (!input.name?.trim()) return bad("请先填写产品名称");
    try {
      return json({ ok: true, copy: await generateProductCopy(env, { name: input.name.trim(), points: input.points ?? "" }) });
    } catch (error) {
      return aiError(error);
    }
  }
  if (pathname === "/api/admin/ai/seo" && request.method === "POST") {
    const input = await bodyJson<{ page_title?: string; page_text?: string }>(request);
    const pageText = typeof input.page_text === "string" ? input.page_text.trim() : "";
    if (!pageText) return bad("页面还没有内容，先添加区块再生成 SEO 信息");
    try {
      return json({ ok: true, seo: await generateSeoMeta(env, { pageTitle: input.page_title?.trim() || "", pageText }) });
    } catch (error) {
      return aiError(error);
    }
  }
  if (pathname === "/api/admin/ai/section" && request.method === "POST") {
    const input = await bodyJson<{ component?: string; brief?: string }>(request);
    if (!input.component) return bad("请选择组件类型");
    try {
      return json({ ok: true, props: await generateSectionProps(env, { component: input.component, brief: input.brief ?? "" }) });
    } catch (error) {
      return aiError(error);
    }
  }
  if (pathname === "/api/admin/ai/alt-text" && request.method === "POST") {
    const input = await bodyJson<{ asset_id?: string }>(request);
    if (!input.asset_id) return bad("缺少素材 ID");
    const asset = await env.DB.prepare("SELECT object_key,mime_type,size_bytes FROM assets WHERE id=?").bind(input.asset_id).first<{ object_key: string; mime_type: string; size_bytes: number }>();
    if (!asset || !asset.mime_type.startsWith("image/")) return bad("素材不存在或不是图片", 404);
    if (asset.size_bytes > 5 * 1024 * 1024) return bad("图片超过 5MB，暂不支持生成描述");
    const object = await env.MEDIA.get(asset.object_key);
    if (!object) return bad("图片文件不存在", 404);
    try {
      const bytes = new Uint8Array(await object.arrayBuffer());
      return json({ ok: true, alt: await describeAssetImage(env, bytes) });
    } catch (error) {
      return aiError(error);
    }
  }

  if (pathname === "/api/admin/webhook/secret" && request.method === "POST") {
    const secret = `whsec_${crypto.randomUUID().replace(/-/g, "")}${crypto.randomUUID().replace(/-/g, "")}`;
    await setSetting(env, "webhook.secret", secret, true);
    return json({ ok: true, secret });
  }
  if (pathname === "/api/admin/webhook/test" && request.method === "POST") {
    const event = { id: `evt_${crypto.randomUUID()}`, type: "order.paid" as const, created_at: nowIso(), data: { test: true, message: "SaaS Store Webhook 测试事件" } };
    await env.WEBHOOK_QUEUE.send({ event } satisfies WebhookQueueMessage);
    return json({ ok: true, event_id: event.id });
  }
  if (pathname === "/api/admin/webhook/deliveries" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM webhook_deliveries ORDER BY created_at DESC LIMIT 100").all();
    return json({ ok: true, deliveries: rows.results });
  }
  const webhookRetry = pathname.match(/^\/api\/admin\/webhook\/deliveries\/([^/]+)\/retry$/);
  if (webhookRetry && request.method === "POST") {
    const row = await env.DB.prepare("SELECT event_id,event_type,order_id,request_body FROM webhook_deliveries WHERE id=?").bind(webhookRetry[1]).first<{ event_id: string; event_type: string; order_id: string | null; request_body: string }>();
    if (!row) return bad("投递记录不存在", 404);
    let event: WebhookQueueMessage["event"];
    try { event = JSON.parse(row.request_body) as WebhookQueueMessage["event"]; } catch { return bad("历史事件内容损坏", 409); }
    await env.WEBHOOK_QUEUE.send({ event, orderId: row.order_id ?? undefined } satisfies WebhookQueueMessage);
    return json({ ok: true, event_id: row.event_id });
  }

  if (pathname === "/api/admin/products" && request.method === "GET") {
    const products = await env.DB.prepare("SELECT * FROM products ORDER BY sort_order, created_at DESC").all<Record<string, unknown>>();
    const plans = await env.DB.prepare("SELECT * FROM plans ORDER BY sort_order, created_at").all<Record<string, unknown>>();
    return json({ ok: true, products: products.results, plans: plans.results });
  }
  if (pathname === "/api/admin/products" && request.method === "POST") {
    const input = await bodyJson<{ name?: string; slug?: string; summary?: string; description?: string; status?: string }>(request);
    if (!input.name?.trim() || !input.slug?.trim()) return bad("产品名称和 slug 必填");
    const productId = id("prod");
    await env.DB.prepare("INSERT INTO products(id,name,slug,summary,description,status) VALUES(?,?,?,?,?,?)")
      .bind(productId, input.name.trim(), input.slug.trim(), input.summary?.trim() ?? "", input.description?.trim() ?? "", input.status === "inactive" ? "inactive" : "active").run();
    return json({ ok: true, id: productId }, { status: 201 });
  }

  const productMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (productMatch && request.method === "PUT") {
    const input = await bodyJson<{ name?: string; slug?: string; summary?: string; description?: string; status?: string; sort_order?: number }>(request);
    if (!input.name?.trim() || !input.slug?.trim()) return bad("产品名称和 slug 必填");
    await env.DB.prepare("UPDATE products SET name=?,slug=?,summary=?,description=?,status=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(input.name.trim(), input.slug.trim(), input.summary?.trim() ?? "", input.description?.trim() ?? "", input.status === "inactive" ? "inactive" : "active", input.sort_order ?? 0, productMatch[1]).run();
    return json({ ok: true });
  }
  if (productMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM products WHERE id=?").bind(productMatch[1]).run();
    return json({ ok: true });
  }

  if (pathname === "/api/admin/plans" && request.method === "POST") {
    const input = await bodyJson<{ product_id?: string; name?: string; description?: string; amount_cents?: number; original_amount_cents?: number | null; billing_label?: string; highlighted?: boolean; status?: string }>(request);
    if (!input.product_id || !input.name?.trim() || !Number.isInteger(input.amount_cents) || (input.amount_cents ?? -1) < 0) return bad("套餐参数不完整");
    const planId = id("plan");
    await env.DB.prepare("INSERT INTO plans(id,product_id,name,description,amount_cents,original_amount_cents,billing_label,highlighted,status) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(planId, input.product_id, input.name.trim(), input.description?.trim() ?? "", input.amount_cents, input.original_amount_cents ?? null, input.billing_label?.trim() || "一次性", input.highlighted ? 1 : 0, input.status === "inactive" ? "inactive" : "active").run();
    return json({ ok: true, id: planId }, { status: 201 });
  }
  const planMatch = pathname.match(/^\/api\/admin\/plans\/([^/]+)$/);
  if (planMatch && request.method === "PUT") {
    const input = await bodyJson<{ name?: string; description?: string; amount_cents?: number; original_amount_cents?: number | null; billing_label?: string; highlighted?: boolean; status?: string; sort_order?: number }>(request);
    if (!input.name?.trim() || !Number.isInteger(input.amount_cents) || (input.amount_cents ?? -1) < 0) return bad("套餐参数不完整");
    await env.DB.prepare("UPDATE plans SET name=?,description=?,amount_cents=?,original_amount_cents=?,billing_label=?,highlighted=?,status=?,sort_order=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(input.name.trim(), input.description?.trim() ?? "", input.amount_cents, input.original_amount_cents ?? null, input.billing_label?.trim() || "一次性", input.highlighted ? 1 : 0, input.status === "inactive" ? "inactive" : "active", input.sort_order ?? 0, planMatch[1]).run();
    return json({ ok: true });
  }
  if (planMatch && request.method === "DELETE") {
    await env.DB.prepare("DELETE FROM plans WHERE id=?").bind(planMatch[1]).run();
    return json({ ok: true });
  }

  if (pathname === "/api/admin/orders/batch" && request.method === "POST") {
    const input = await bodyJson<{ action?: "query" | "close" | "delete" | "force-delete"; order_nos?: unknown }>(request);
    if (!input.action || !["query", "close", "delete", "force-delete"].includes(input.action)) return bad("批量操作类型无效");
    if (!Array.isArray(input.order_nos) || !input.order_nos.every((value): value is string => typeof value === "string")) {
      return bad("订单号列表无效");
    }
    const orderNos = [...new Set(input.order_nos.map((value) => value.trim()).filter(Boolean))];
    if (orderNos.length === 0) return bad("请选择至少一个订单");
    if (orderNos.length > 20) return bad("单次最多管理 20 个订单");

    const results: Array<{
      order_no: string;
      ok: boolean;
      changed: boolean;
      status: string | null;
      provider_ok?: boolean;
      trade_status?: string | null;
      message: string;
    }> = [];

    for (const orderNoValue of orderNos) {
      try {
        if (input.action === "delete" || input.action === "force-delete") {
          const result = await deletePaymentOrder(env, orderNoValue, { force: input.action === "force-delete" });
          results.push({
            order_no: orderNoValue,
            ok: result.deleted,
            changed: result.deleted,
            status: result.order?.status ?? null,
            message: result.message ?? (result.deleted ? "订单已删除" : "订单未删除"),
          });
          continue;
        }

        if (input.action === "query") {
          const result = await syncProviderOrder(env, orderNoValue, true);
          results.push({
            order_no: orderNoValue,
            ok: result.provider_ok,
            changed: result.changed,
            status: result.order?.status ?? null,
            provider_ok: result.provider_ok,
            trade_status: result.trade_status ?? null,
            message: result.message ?? (result.provider_ok ? "订单已同步" : "支付渠道暂未确认交易"),
          });
          continue;
        }

        const result = await closeProviderOrder(env, orderNoValue);
        results.push({
          order_no: orderNoValue,
          ok: result.provider_ok,
          changed: result.changed,
          status: result.order?.status ?? null,
          provider_ok: result.provider_ok,
          message: result.message ?? (result.changed ? "订单已关闭" : "订单状态已更新"),
        });
      } catch (error) {
        results.push({
          order_no: orderNoValue,
          ok: false,
          changed: false,
          status: null,
          message: error instanceof Error ? error.message : "批量操作失败",
        });
      }
    }

    const succeeded = results.filter((result) => result.ok).length;
    return json({
      ok: true,
      action: input.action,
      total: results.length,
      succeeded,
      failed: results.length - succeeded,
      results,
    });
  }

  const adminOrderDelete = pathname.match(/^\/api\/admin\/orders\/([^/]+)(\/force-delete)?$/);
  const forceDelete = Boolean(adminOrderDelete?.[2]);
  if (adminOrderDelete && adminOrderDelete[1] !== "batch" && request.method === (forceDelete ? "POST" : "DELETE")) {
    try {
      const result = await deletePaymentOrder(env, decodeURIComponent(adminOrderDelete[1]), { force: forceDelete });
      if (!result.order) return bad("订单不存在", 404);
      if (!result.deleted) return bad(result.message ?? "订单未删除", 409);
      return json({ ok: true, order_no: result.order.order_no, message: result.message ?? "订单已删除" });
    } catch (error) {
      return bad(error instanceof Error ? error.message : "删除订单失败", 409);
    }
  }
  const adminOrderAction = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/(query|close)$/);
  if (adminOrderAction && request.method === "POST") {
    const orderNoValue = decodeURIComponent(adminOrderAction[1]);
    try {
      if (adminOrderAction[2] === "query") {
        const result = await syncProviderOrder(env, orderNoValue, true);
        if (!result.order) return bad("订单不存在", 404);
        return json({
          ok: true,
          provider_ok: result.provider_ok,
          order: result.order,
          changed: result.changed,
          trade_status: result.trade_status ?? null,
          message: result.message ?? (result.provider_ok ? "订单已同步" : "支付渠道暂未确认交易"),
        });
      }
      const result = await closeProviderOrder(env, orderNoValue);
      if (!result.order) return bad("订单不存在", 404);
      if (!result.provider_ok && !result.changed) return bad(result.message ?? "支付渠道未关闭订单", 409);
      return json({
        ok: true,
        order: result.order,
        changed: result.changed,
        message: result.message ?? (result.changed ? "订单已关闭" : "订单状态已更新"),
      });
    } catch (error) {
      return bad(error instanceof Error ? error.message : "支付渠道交易操作失败", 502);
    }
  }

  const adminOrderRefunds = pathname.match(/^\/api\/admin\/orders\/([^/]+)\/refunds$/);
  if (adminOrderRefunds && request.method === "GET") {
    const orderNoValue = decodeURIComponent(adminOrderRefunds[1]);
    const order = await loadPaymentOrder(env, orderNoValue);
    if (!order) return bad("订单不存在", 404);
    const rows = await env.DB.prepare("SELECT * FROM payment_refunds WHERE order_no=? ORDER BY created_at DESC").bind(orderNoValue).all();
    return json({ ok: true, order, refunds: rows.results });
  }
  if (adminOrderRefunds && request.method === "POST") {
    const input = await bodyJson<{ amount_cents?: number; reason?: string; out_request_no?: string }>(request);
    const amountCents = input.amount_cents;
    if (typeof amountCents !== "number" || !Number.isSafeInteger(amountCents) || amountCents <= 0) return bad("退款金额必须是正整数分");
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length > 256) return bad("退款原因不能超过 256 个字符");
    try {
      const result = await issueRefund(env, decodeURIComponent(adminOrderRefunds[1]), amountCents, reason, input.out_request_no);
      const success = result.refund.status === "success";
      const responseStatus = success ? 200 : result.pending ? 202 : 409;
      return json({
        ok: success || result.pending,
        refund: result.refund,
        pending: result.pending,
        message: result.message ?? (success ? "退款已完成" : "退款未完成"),
        ...(success || result.pending ? {} : { error: result.message ?? "支付渠道拒绝退款" }),
      }, { status: responseStatus });
    } catch (error) {
      return bad(error instanceof Error ? error.message : "退款失败", 409);
    }
  }

  const adminRefundQuery = pathname.match(/^\/api\/admin\/refunds\/([^/]+)\/query$/);
  if (adminRefundQuery && request.method === "POST") {
    try {
      const result = await syncRefund(env, decodeURIComponent(adminRefundQuery[1]));
      return json({ ok: true, refund: result.refund, pending: result.pending, message: result.message ?? "退款状态已查询" });
    } catch (error) {
      return bad(error instanceof Error ? error.message : "退款查询失败", 502);
    }
  }
  if (pathname === "/api/admin/orders" && request.method === "GET") {
    const status = url.searchParams.get("status");
    const query = status && ["pending", "paid", "closed", "refunded"].includes(status)
      ? env.DB.prepare("SELECT * FROM orders WHERE status=? ORDER BY created_at DESC LIMIT 200").bind(status)
      : env.DB.prepare("SELECT * FROM orders ORDER BY created_at DESC LIMIT 200");
    const rows = await query.all();
    return json({ ok: true, orders: rows.results });
  }

  if (pathname === "/api/admin/pages" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,title,slug,status,seo_title,seo_description,seo_keywords,og_image,noindex,created_at,updated_at,published_at FROM pages ORDER BY updated_at DESC").all();
    return json({ ok: true, pages: rows.results });
  }
  if (pathname === "/api/admin/pages" && request.method === "POST") {
    const input = await bodyJson<{ title?: string; slug?: string; seo_title?: string; seo_description?: string; seo_keywords?: string; og_image?: string; noindex?: boolean; draft_json?: unknown }>(request);
    if (!input.title?.trim() || !input.slug?.trim()) return bad("页面标题和 slug 必填");
    const pageId = id("page");
    await env.DB.prepare("INSERT INTO pages(id,title,slug,seo_title,seo_description,seo_keywords,og_image,noindex,draft_json) VALUES(?,?,?,?,?,?,?,?,?)")
      .bind(pageId, input.title.trim(), input.slug.trim(), input.seo_title?.trim() ?? "", input.seo_description?.trim() ?? "", input.seo_keywords?.trim() ?? "", input.og_image?.trim() ?? "", input.noindex ? 1 : 0, JSON.stringify(input.draft_json ?? { content: [], root: {} })).run();
    return json({ ok: true, id: pageId }, { status: 201 });
  }
  const pageVersionMatch = pathname.match(/^\/api\/admin\/pages\/([^/]+)\/versions(?:\/(\d+))?$/);
  if (pageVersionMatch && request.method === "GET" && !pageVersionMatch[2]) {
    const rows = await env.DB.prepare("SELECT id,version,title,slug,seo_title,seo_description,seo_keywords,og_image,noindex,created_at FROM page_versions WHERE page_id=? ORDER BY version DESC LIMIT 100")
      .bind(pageVersionMatch[1]).all();
    return json({ ok: true, versions: rows.results });
  }
  if (pageVersionMatch && pageVersionMatch[2] && request.method === "POST") {
    const version = await env.DB.prepare("SELECT content_json,title,slug,seo_title,seo_description,seo_keywords,og_image,noindex FROM page_versions WHERE page_id=? AND version=?")
      .bind(pageVersionMatch[1], Number(pageVersionMatch[2])).first<{ content_json: string; title: string | null; slug: string | null; seo_title: string | null; seo_description: string | null; seo_keywords: string | null; og_image: string | null; noindex: number | null }>();
    if (!version) return bad("版本不存在", 404);
    await env.DB.prepare("UPDATE pages SET title=COALESCE(?,title),slug=COALESCE(?,slug),seo_title=COALESCE(?,seo_title),seo_description=COALESCE(?,seo_description),seo_keywords=COALESCE(?,seo_keywords),og_image=COALESCE(?,og_image),noindex=COALESCE(?,noindex),draft_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(version.title, version.slug, version.seo_title, version.seo_description, version.seo_keywords, version.og_image, version.noindex, version.content_json, pageVersionMatch[1]).run();
    return json({ ok: true, restored_version: Number(pageVersionMatch[2]) });
  }
  const pageMatch = pathname.match(/^\/api\/admin\/pages\/([^/]+)$/);
  if (pageMatch && request.method === "GET") {
    const row = await env.DB.prepare("SELECT * FROM pages WHERE id=?").bind(pageMatch[1]).first();
    if (!row) return bad("页面不存在", 404);
    return json({ ok: true, page: row });
  }
  if (pageMatch && request.method === "PUT") {
    const input = await bodyJson<{ title?: string; slug?: string; seo_title?: string; seo_description?: string; seo_keywords?: string; og_image?: string; noindex?: boolean; draft_json?: unknown; create_version?: boolean }>(request);
    if (!input.title?.trim() || !input.slug?.trim()) return bad("页面标题和 slug 必填");
    const draftJson = JSON.stringify(input.draft_json ?? { content: [], root: {} });
    const updated = await env.DB.prepare("UPDATE pages SET title=?,slug=?,seo_title=?,seo_description=?,seo_keywords=?,og_image=?,noindex=?,draft_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(input.title.trim(), input.slug.trim(), input.seo_title?.trim() ?? "", input.seo_description?.trim() ?? "", input.seo_keywords?.trim() ?? "", input.og_image?.trim() ?? "", input.noindex ? 1 : 0, draftJson, pageMatch[1]).run();
    if (updated.meta.changes !== 1) return bad("页面不存在", 404);
    if (input.create_version) {
      const snapshot = await env.DB.prepare("SELECT title,slug,seo_title,seo_description,seo_keywords,og_image,noindex,draft_json FROM pages WHERE id=?").bind(pageMatch[1]).first<{ title: string; slug: string; seo_title: string; seo_description: string; seo_keywords: string; og_image: string; noindex: number; draft_json: string }>();
      const next = await env.DB.prepare("SELECT COALESCE(MAX(version),0)+1 next_version FROM page_versions WHERE page_id=?").bind(pageMatch[1]).first<{ next_version: number }>();
      if (snapshot) {
        await env.DB.prepare("INSERT INTO page_versions(id,page_id,version,content_json,title,slug,seo_title,seo_description,seo_keywords,og_image,noindex) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
          .bind(id("pv"), pageMatch[1], next?.next_version ?? 1, snapshot.draft_json, snapshot.title, snapshot.slug, snapshot.seo_title, snapshot.seo_description, snapshot.seo_keywords, snapshot.og_image, snapshot.noindex).run();
      }
      return json({ ok: true, version: next?.next_version ?? 1 });
    }
    return json({ ok: true });
  }
  if (pageMatch && request.method === "DELETE") {
    const page = await env.DB.prepare("SELECT slug FROM pages WHERE id=?").bind(pageMatch[1]).first<{ slug: string }>();
    if (page?.slug === "home") return bad("首页不能删除", 409);
    await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(pageMatch[1]).run();
    return json({ ok: true });
  }
  const publishMatch = pathname.match(/^\/api\/admin\/pages\/([^/]+)\/publish$/);
  if (publishMatch && request.method === "POST") {
    const page = await env.DB.prepare("SELECT draft_json,title,slug,seo_title,seo_description,seo_keywords,og_image,noindex FROM pages WHERE id=?").bind(publishMatch[1]).first<{ draft_json: string; title: string; slug: string; seo_title: string; seo_description: string; seo_keywords: string; og_image: string; noindex: number }>();
    if (!page) return bad("页面不存在", 404);
    if (!page.draft_json) return bad("页面草稿为空", 409);
    const v = await env.DB.prepare("SELECT COALESCE(MAX(version),0)+1 next_version FROM page_versions WHERE page_id=?").bind(publishMatch[1]).first<{ next_version: number }>();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO page_versions(id,page_id,version,content_json,title,slug,seo_title,seo_description,seo_keywords,og_image,noindex) VALUES(?,?,?,?,?,?,?,?,?,?,?)").bind(id("pv"), publishMatch[1], v?.next_version ?? 1, page.draft_json, page.title, page.slug, page.seo_title, page.seo_description, page.seo_keywords, page.og_image, page.noindex),
      env.DB.prepare("UPDATE pages SET published_json=draft_json,status='published',published_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(publishMatch[1]),
    ]);
    return json({ ok: true, version: v?.next_version ?? 1 });
  }
  if (pathname === "/api/admin/assets" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT * FROM assets ORDER BY created_at DESC LIMIT 200").all();
    return json({ ok: true, assets: rows.results });
  }
  if (pathname === "/api/admin/assets" && request.method === "POST") {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return bad("请选择文件");
    if (file.size > 10 * 1024 * 1024) return bad("单个文件暂时限制为 10MB");
    const assetId = id("asset");
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "_");
    const objectKey = `${assetId}/${safeName}`;
    await env.MEDIA.put(objectKey, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" } });
    const publicUrl = `/media/${encodeURIComponent(objectKey)}`;
    await env.DB.prepare("INSERT INTO assets(id,object_key,filename,mime_type,size_bytes,public_url) VALUES(?,?,?,?,?,?)")
      .bind(assetId, objectKey, file.name, file.type || "application/octet-stream", file.size, publicUrl).run();
    return json({ ok: true, asset: { id: assetId, filename: file.name, public_url: publicUrl } }, { status: 201 });
  }
  const assetMatch = pathname.match(/^\/api\/admin\/assets\/([^/]+)$/);
  if (assetMatch && request.method === "DELETE") {
    const asset = await env.DB.prepare("SELECT object_key FROM assets WHERE id=?").bind(assetMatch[1]).first<{ object_key: string }>();
    if (asset) await env.MEDIA.delete(asset.object_key);
    await env.DB.prepare("DELETE FROM assets WHERE id=?").bind(assetMatch[1]).run();
    return json({ ok: true });
  }

  return bad("管理接口不存在", 404);
}
