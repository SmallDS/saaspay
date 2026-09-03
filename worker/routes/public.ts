import { bad, bodyJson, classifyContactInfo, id, json, nowIso, orderNo, parseCnyCents, paymentSuccess, recordValue, webhookContactFields } from "../http";
import { getSettingValue } from "../db/settings";
import { getLegalSettings, getSeoSettings } from "../seo";
import { createPagePayForm, verifyAlipayNotify } from "../payment/alipay";
import {
  createWechatH5Payment,
  createWechatNativePayment,
  decryptWechatResource,
  getWechatConfig,
  verifyWechatNotify,
} from "../payment/wechat";
import { asRecord } from "../payment/rsa";
import {
  closeExpiredOrder,
  loadPaymentOrder,
  markOrderClosed,
  markOrderPaid,
  maybeSyncProviderOrder,
  type PaymentOrder,
} from "../orders/lifecycle";
import { applyWechatRefundNotification } from "../orders/refunds";
import { enqueueBusinessEvent } from "../webhook/outbound";
import {
  defaultFooterSettings,
  defaultHeaderSettings,
  defaultThemeSettings,
  normalizeFooterSettings,
  normalizeHeaderSettings,
  normalizeThemeSettings,
  parseSettingJson,
} from "../site-settings";

function wechatSuccess(): Response {
  return json({ code: "SUCCESS", message: "成功" });
}

function wechatFailure(message: string): Response {
  return json({ code: "FAIL", message }, { status: 500 });
}

export async function handlePublic(request: Request, env: Env, url: URL): Promise<Response | null> {
  const pathname = url.pathname;
  if (pathname === "/api/health") return json({ ok: true, service: "saas-store-cf", time: nowIso() });
  if (pathname === "/api/public/site" && request.method === "GET") {
    const [name, tagline, themeRaw, headerRaw, footerRaw, seo, legal] = await Promise.all([
      getSettingValue(env, "site.name", "SaaS Store"),
      getSettingValue(env, "site.tagline", ""),
      getSettingValue(env, "site.theme", JSON.stringify(defaultThemeSettings)),
      getSettingValue(env, "site.header", JSON.stringify(defaultHeaderSettings)),
      getSettingValue(env, "site.footer", JSON.stringify(defaultFooterSettings)),
      getSeoSettings(env),
      getLegalSettings(env),
    ]);
    return json({ ok: true, site: {
      name,
      tagline,
      theme: parseSettingJson(themeRaw, defaultThemeSettings, normalizeThemeSettings),
      header: parseSettingJson(headerRaw, defaultHeaderSettings, normalizeHeaderSettings),
      footer: parseSettingJson(footerRaw, defaultFooterSettings, normalizeFooterSettings),
      seo,
      legal,
    } });
  }
  if (pathname === "/api/public/payment-methods" && request.method === "GET") {
    const [alipay, wechat] = await Promise.all([
      getSettingValue(env, "payment.alipay.enabled", "false"),
      getSettingValue(env, "payment.wechat.enabled", "false"),
    ]);
    return json({ ok: true, methods: { alipay: alipay === "true", wechat: wechat === "true" } });
  }
  if (pathname === "/api/public/products" && request.method === "GET") {
    const products = await env.DB.prepare("SELECT * FROM products WHERE status='active' ORDER BY sort_order,created_at DESC").all<Record<string, unknown>>();
    const plans = await env.DB.prepare("SELECT * FROM plans WHERE status='active' ORDER BY sort_order,created_at").all<Record<string, unknown>>();
    return json({ ok: true, products: products.results, plans: plans.results });
  }
  if (pathname === "/api/public/assets" && request.method === "GET") {
    const rows = await env.DB.prepare("SELECT id,filename,mime_type,public_url FROM assets WHERE mime_type LIKE 'image/%' ORDER BY created_at DESC LIMIT 200").all();
    return json({ ok: true, assets: rows.results });
  }
  const publicPage = pathname.match(/^\/api\/public\/pages\/(.+)$/);
  if (publicPage && request.method === "GET") {
    const slug = decodeURIComponent(publicPage[1]);
    const row = await env.DB.prepare("SELECT id,title,slug,seo_title,seo_description,seo_keywords,og_image,noindex,published_json,published_at FROM pages WHERE slug=? AND status='published'").bind(slug).first();
    if (!row) return bad("页面不存在", 404);
    return json({ ok: true, page: row });
  }

  if (pathname === "/api/orders" && request.method === "POST") {
    const input = await bodyJson<{ plan_id?: string; metadata?: Record<string, unknown>; request_id?: string; contact_name?: string; contact_info?: string }>(request);
    if (!input.plan_id) return bad("请选择套餐");
    const contactInfo = typeof input.contact_info === "string" ? input.contact_info.trim() : "";
    const contactType = classifyContactInfo(contactInfo);
    if (!contactType) return bad("联系方式必须是手机号或邮箱");
    const contactName = typeof input.contact_name === "string" ? input.contact_name.trim() : "";
    if (contactName.length > 100) return bad("联系人不能超过 100 个字符");
    const metadata = {
      ...recordValue(input.metadata),
      contact_name: contactName,
      contact_info: contactInfo,
      contact_type: contactType,
    };
    const requestId = (request.headers.get("Idempotency-Key") ?? input.request_id ?? "").trim();
    if (requestId.length > 128 || /[\r\n]/.test(requestId)) return bad("幂等请求标识无效");

    if (requestId) {
      const existing = await env.DB.prepare(
        "SELECT id,order_no,plan_id,amount_cents,status FROM orders WHERE checkout_request_id=?",
      ).bind(requestId).first<{ id: string; order_no: string; plan_id: string; amount_cents: number; status: string }>();
      if (existing) {
        if (existing.plan_id !== input.plan_id) return bad("同一个幂等请求已用于其他套餐", 409);
        return json({ ok: true, order: { id: existing.id, order_no: existing.order_no, amount_cents: existing.amount_cents, status: existing.status } });
      }
    }

    const row = await env.DB.prepare(
      "SELECT p.id product_id,p.name product_name,pl.id plan_id,pl.name plan_name,pl.amount_cents FROM plans pl JOIN products p ON p.id=pl.product_id WHERE pl.id=? AND pl.status='active' AND p.status='active'",
    ).bind(input.plan_id).first<{ product_id: string; product_name: string; plan_id: string; plan_name: string; amount_cents: number }>();
    if (!row) return bad("套餐不存在或已下架", 404);

    const orderId = id("order");
    const no = orderNo();
    const initialStatus = row.amount_cents === 0 ? "paid" : "pending";
    const insert = env.DB.prepare(
      "INSERT INTO orders(id,order_no,product_id,plan_id,product_name,plan_name,amount_cents,status,metadata_json,checkout_request_id,paid_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    ).bind(
      orderId,
      no,
      row.product_id,
      row.plan_id,
      row.product_name,
      row.plan_name,
      row.amount_cents,
      initialStatus,
      JSON.stringify(metadata),
      requestId || null,
      initialStatus === "paid" ? nowIso() : null,
    );

    try {
      await insert.run();
    } catch (error) {
      if (!requestId) throw error;
      const existing = await env.DB.prepare(
        "SELECT id,order_no,plan_id,amount_cents,status FROM orders WHERE checkout_request_id=?",
      ).bind(requestId).first<{ id: string; order_no: string; plan_id: string; amount_cents: number; status: string }>();
      if (!existing) throw error;
      if (existing.plan_id !== input.plan_id) return bad("同一个幂等请求已用于其他套餐", 409);
      return json({ ok: true, order: { id: existing.id, order_no: existing.order_no, amount_cents: existing.amount_cents, status: existing.status } });
    }

    await enqueueBusinessEvent(env, "order.created", { order_no: no, product_id: row.product_id, plan_id: row.plan_id, amount_cents: row.amount_cents, currency: "CNY", ...webhookContactFields(metadata), metadata }, orderId);
    if (initialStatus === "paid") {
      await enqueueBusinessEvent(env, "order.paid", {
        order_no: no,
        product: { id: row.product_id, name: row.product_name },
        plan: { id: row.plan_id, name: row.plan_name },
        amount_cents: 0,
        currency: "CNY",
        payment: { provider: "free", trade_no: "" },
        ...webhookContactFields(metadata),
        metadata,
      }, orderId);
    }
    return json({ ok: true, order: { id: orderId, order_no: no, amount_cents: row.amount_cents, status: initialStatus } }, { status: 201 });
  }

  if (pathname === "/api/payment/alipay/create" && request.method === "POST") {
    const input = await bodyJson<{ order_no?: string }>(request);
    if (!input.order_no) return bad("订单号不能为空");
    await closeExpiredOrder(env, input.order_no);
    const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no=?").bind(input.order_no).first<{ id: string; order_no: string; amount_cents: number; product_name: string; plan_name: string; status: string }>();
    if (!order) return bad("订单不存在", 404);
    if (order.status === "closed") return bad("订单已关闭，请重新下单", 409);
    if (order.status !== "pending") return bad("订单当前状态不可支付", 409);
    await env.DB.prepare("UPDATE orders SET payment_provider='alipay',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(order.id).run();
    const configuredDomain = await getSettingValue(env, "site.primary_domain");
    const origin = configuredDomain || url.origin;
    const paymentForm = await createPagePayForm(env, { orderNo: order.order_no, amountCents: order.amount_cents, subject: `${order.product_name} - ${order.plan_name}`, origin });
    return json({ ok: true, payment_form: paymentForm });
  }

  if (pathname === "/api/payment/alipay/notify" && request.method === "POST") {
    const form = await request.formData();
    const params: Record<string, string> = {};
    form.forEach((value, key) => { if (typeof value === "string") params[key] = value; });
    if (!(await verifyAlipayNotify(env, params))) return new Response("failure", { status: 400 });

    const no = params.out_trade_no;
    const tradeStatus = params.trade_status;
    if (!no) return new Response("failure", { status: 400 });

    const order = await env.DB.prepare(
      "SELECT id,order_no,amount_cents,status,product_id,plan_id,product_name,plan_name,metadata_json,payment_provider,transaction_id,alipay_trade_no,buyer_id FROM orders WHERE order_no=?",
    ).bind(no).first<PaymentOrder>();
    if (!order) return new Response("failure", { status: 404 });

    if (tradeStatus === "TRADE_CLOSED") {
      if (order.status === "pending") await markOrderClosed(env, order);
      return paymentSuccess();
    }
    if (!["TRADE_SUCCESS", "TRADE_FINISHED"].includes(tradeStatus)) return paymentSuccess();
    if (!params.trade_no) return new Response("failure", { status: 400 });

    const totalCents = parseCnyCents(params.total_amount ?? "");
    if (totalCents === null || totalCents !== order.amount_cents) return new Response("failure", { status: 400 });
    if (order.status === "paid" || order.status === "refunded") return paymentSuccess();

    await markOrderPaid(env, order, params.trade_no, params.buyer_id ?? null);
    return paymentSuccess();
  }

  if (pathname === "/api/payment/wechat/create" && request.method === "POST") {
    const input = await bodyJson<{ order_no?: string }>(request);
    if (!input.order_no) return bad("订单号不能为空");
    await closeExpiredOrder(env, input.order_no);
    const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no=?").bind(input.order_no).first<{ id: string; order_no: string; amount_cents: number; product_name: string; plan_name: string; status: string }>();
    if (!order) return bad("订单不存在", 404);
    if (order.status === "closed") return bad("订单已关闭，请重新下单", 409);
    if (order.status !== "pending") return bad("订单当前状态不可支付", 409);
    const config = await getWechatConfig(env);
    if (!config.enabled) return bad("微信支付未启用", 409);
    const claimed = await env.DB.prepare("UPDATE orders SET payment_provider='wechat',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'").bind(order.id).run();
    if (claimed.meta.changes !== 1) return bad("订单状态已变化，请刷新后重试", 409);
    const configuredDomain = (await getSettingValue(env, "site.primary_domain")).replace(/\/$/, "");
    const origin = configuredDomain || url.origin;
    const description = `${order.product_name} - ${order.plan_name}`;
    const notifyUrl = `${origin}/api/payment/wechat/notify`;
    const isMobile = /android|iphone|ipod|ipad|mobile/i.test(request.headers.get("user-agent") ?? "");
    const clientIp = request.headers.get("cf-connecting-ip") ?? "";
    try {
      if (isMobile) {
        const payment = await createWechatH5Payment(config, { orderNo: order.order_no, amountCents: order.amount_cents, description, notifyUrl, payerClientIp: clientIp });
        return json({ ok: true, mode: "h5", h5_url: payment.h5_url });
      }
      const payment = await createWechatNativePayment(config, { orderNo: order.order_no, amountCents: order.amount_cents, description, notifyUrl });
      return json({ ok: true, mode: "native", code_url: payment.code_url });
    } catch (error) {
      return bad(error instanceof Error ? error.message : "微信支付下单失败", 502);
    }
  }

  if (pathname === "/api/payment/wechat/notify" && request.method === "POST") {
    const rawBody = await request.text();
    const config = await getWechatConfig(env);
    if (!config.enabled || !config.apiV3Key) return wechatFailure("微信支付未启用");
    if (!(await verifyWechatNotify(env, config, request.headers, rawBody))) return wechatFailure("验签失败");
    let envelope: Record<string, unknown>;
    try {
      envelope = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      return wechatFailure("报文解析失败");
    }
    let resource: Record<string, unknown>;
    try {
      resource = await decryptWechatResource(config.apiV3Key, asRecord(envelope.resource) ?? {});
    } catch {
      return wechatFailure("报文解密失败");
    }
    const eventType = String(envelope.event_type ?? "");

    if (eventType === "TRANSACTION.SUCCESS") {
      const no = String(resource.out_trade_no ?? "");
      const tradeNo = String(resource.transaction_id ?? "");
      const amount = asRecord(resource.amount);
      const total = amount ? Number(amount.total) : Number.NaN;
      if (!no || !tradeNo) return wechatFailure("报文缺少订单信息");
      const order = await loadPaymentOrder(env, no);
      if (!order) return wechatFailure("订单不存在");
      if (!Number.isSafeInteger(total) || total !== order.amount_cents) return wechatFailure("订单金额校验失败");
      await markOrderPaid(env, order, tradeNo, null);
      return wechatSuccess();
    }
    if (eventType === "TRANSACTION.CLOSED") {
      const no = String(resource.out_trade_no ?? "");
      if (no) {
        const order = await loadPaymentOrder(env, no);
        if (order && order.status === "pending") await markOrderClosed(env, order);
      }
      return wechatSuccess();
    }
    if (eventType.startsWith("REFUND.")) {
      const outRefundNo = String(resource.out_refund_no ?? "");
      const refundStatus = String(resource.refund_status ?? "");
      if (outRefundNo && refundStatus) await applyWechatRefundNotification(env, outRefundNo, refundStatus);
      return wechatSuccess();
    }
    return wechatSuccess();
  }

  const orderStatus = pathname.match(/^\/api\/orders\/([^/]+)$/);
  if (orderStatus && request.method === "GET") {
    try { await maybeSyncProviderOrder(env, orderStatus[1]); } catch {}
    await closeExpiredOrder(env, orderStatus[1]);
    const row = await env.DB.prepare("SELECT order_no,product_name,plan_name,amount_cents,currency,status,payment_provider,paid_at,refunded_cents,created_at FROM orders WHERE order_no=?").bind(orderStatus[1]).first();
    if (!row) return bad("订单不存在", 404);
    return json({ ok: true, order: row });
  }

  return null;
}
