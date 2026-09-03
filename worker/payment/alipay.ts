import { base64ToBytes, bytesToBase64, toBytes } from "../crypto/base64";
import { parseCnyCents } from "../http";
import { getSettingValue } from "../db/settings";
import type { ChannelCloseResult, ChannelQueryResult, ChannelRefundResult, PaymentChannel } from "./provider";
import { asRecord, importRsassaPrivateKey, importRsassaPublicKey } from "./rsa";
import type { PaymentOrder } from "../orders/lifecycle";
import type { PaymentRefund } from "../orders/refunds";

export type AlipayConfig = {
  enabled: boolean;
  appId: string;
  gateway: string;
  sellerId: string;
  privateKey: string;
  alipayPublicKey: string;
};

export type AlipayApiResult = {
  ok: boolean;
  code: string;
  message: string;
  subCode: string;
  subMessage: string;
  data: Record<string, unknown>;
};

function canonical(params: Record<string, string>, includeSignType = false): string {
  return Object.entries(params)
    .filter(([key, value]) => key !== "sign" && (includeSignType || key !== "sign_type") && value !== "")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
}

function extractSignedObject(raw: string, key: string): string | null {
  const marker = `"${key}"`;
  const markerIndex = raw.indexOf(marker);
  if (markerIndex < 0) return null;
  const colonIndex = raw.indexOf(":", markerIndex + marker.length);
  if (colonIndex < 0) return null;
  let start = colonIndex + 1;
  while (/\s/.test(raw.charAt(start))) start += 1;
  if (raw.charAt(start) !== "{") return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) return raw.slice(start, index + 1);
    }
  }
  return null;
}

async function verifyApiResponse(config: AlipayConfig, raw: string, responseKey: string, sign: string): Promise<boolean> {
  const content = extractSignedObject(raw, responseKey);
  if (!content) return false;
  const key = await importRsassaPublicKey(config.alipayPublicKey);
  return crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64ToBytes(sign),
    toBytes(content),
  );
}

function chinaTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export async function getAlipayConfig(env: Env): Promise<AlipayConfig> {
  return {
    enabled: (await getSettingValue(env, "payment.alipay.enabled", "false")) === "true",
    appId: await getSettingValue(env, "payment.alipay.app_id"),
    gateway: await getSettingValue(env, "payment.alipay.gateway", "https://openapi.alipay.com/gateway.do"),
    sellerId: await getSettingValue(env, "payment.alipay.seller_id"),
    privateKey: await getSettingValue(env, "payment.alipay.private_key"),
    alipayPublicKey: await getSettingValue(env, "payment.alipay.public_key"),
  };
}

export async function callAlipayApi(
  env: Env,
  method: string,
  bizContent: Record<string, unknown>,
): Promise<AlipayApiResult> {
  const config = await getAlipayConfig(env);
  if (!config.enabled) throw new Error("支付宝支付未启用");
  if (!config.appId || !config.privateKey || !config.alipayPublicKey) throw new Error("支付宝配置不完整");

  const params: Record<string, string> = {
    app_id: config.appId,
    method,
    format: "JSON",
    charset: "utf-8",
    sign_type: "RSA2",
    timestamp: chinaTimestamp(),
    version: "1.0",
    biz_content: JSON.stringify(bizContent),
  };
  const key = await importRsassaPrivateKey(config.privateKey);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, toBytes(canonical(params, true)));
  params.sign = bytesToBase64(new Uint8Array(signature));

  const body = new URLSearchParams(params).toString();
  const response = await fetch(config.gateway, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8", accept: "application/json" },
    body,
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`支付宝接口请求失败（HTTP ${response.status}）`);

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("支付宝接口返回内容不是有效 JSON");
  }
  const responseKey = `${method.replace(/\./g, "_")}_response`;
  const responseData = asRecord(parsed[responseKey]);
  const errorData = asRecord(parsed.error_response);
  const data = responseData ?? errorData;
  const responseSign = typeof parsed.sign === "string" ? parsed.sign : "";
  const signedKey = responseData ? responseKey : "error_response";
  if (!data || !responseSign || !(await verifyApiResponse(config, raw, signedKey, responseSign))) {
    throw new Error("支付宝接口响应验签失败");
  }

  const code = String(data.code ?? "");
  return {
    ok: code === "10000",
    code,
    message: String(data.msg ?? ""),
    subCode: String(data.sub_code ?? ""),
    subMessage: String(data.sub_msg ?? ""),
    data,
  };
}

export type AlipayPagePayForm = {
  action: string;
  fields: Record<string, string>;
};

// 电脑网站支付（alipay.trade.page.pay / FAST_INSTANT_TRADE_PAY）与手机网站支付
// （alipay.trade.wap.pay / QUICK_WAP_WAY）签名参数结构一致，仅 method 与 product_code 不同。
async function buildPayForm(
  env: Env,
  input: { orderNo: string; amountCents: number; subject: string; origin: string },
  variant: { method: "alipay.trade.page.pay" | "alipay.trade.wap.pay"; productCode: string; quitUrl?: string },
): Promise<AlipayPagePayForm> {
  const config = await getAlipayConfig(env);
  if (!config.enabled) throw new Error("支付宝支付未启用");
  if (!config.appId || !config.privateKey || !config.alipayPublicKey) throw new Error("支付宝配置不完整");

  const bizContent: Record<string, unknown> = {
    out_trade_no: input.orderNo,
    product_code: variant.productCode,
    total_amount: (input.amountCents / 100).toFixed(2),
    subject: input.subject.slice(0, 256),
    timeout_express: "30m",
  };
  if (variant.quitUrl) bizContent.quit_url = variant.quitUrl;

  const params: Record<string, string> = {
    app_id: config.appId,
    method: variant.method,
    format: "JSON",
    charset: "UTF-8",
    sign_type: "RSA2",
    timestamp: chinaTimestamp(),
    version: "1.0",
    notify_url: `${input.origin}/api/payment/alipay/notify`,
    return_url: `${input.origin}/payment/result?order_no=${encodeURIComponent(input.orderNo)}`,
    biz_content: JSON.stringify(bizContent),
  };

  const key = await importRsassaPrivateKey(config.privateKey);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, toBytes(canonical(params, true)));
  params.sign = bytesToBase64(new Uint8Array(signature));

  const actionUrl = new URL(config.gateway);
  const actionParams: Record<string, string> = {};
  for (const [keyName, value] of Object.entries(params)) {
    if (keyName !== "biz_content") actionParams[keyName] = value;
  }
  actionUrl.search = new URLSearchParams(actionParams).toString();
  return { action: actionUrl.toString(), fields: { biz_content: params.biz_content } };
}

export function createPagePayForm(
  env: Env,
  input: { orderNo: string; amountCents: number; subject: string; origin: string },
): Promise<AlipayPagePayForm> {
  return buildPayForm(env, input, { method: "alipay.trade.page.pay", productCode: "FAST_INSTANT_TRADE_PAY" });
}

export function createWapPayForm(
  env: Env,
  input: { orderNo: string; amountCents: number; subject: string; origin: string },
): Promise<AlipayPagePayForm> {
  return buildPayForm(env, input, {
    method: "alipay.trade.wap.pay",
    productCode: "QUICK_WAP_WAY",
    quitUrl: `${input.origin}/payment/result?order_no=${encodeURIComponent(input.orderNo)}`,
  });
}

export async function verifyAlipayNotify(env: Env, params: Record<string, string>): Promise<boolean> {
  const config = await getAlipayConfig(env);
  const sign = params.sign;
  if (!sign || !config.alipayPublicKey) return false;
  if (!config.appId || params.app_id !== config.appId) return false;
  if (config.sellerId && params.seller_id !== config.sellerId) return false;
  try {
    const key = await importRsassaPublicKey(config.alipayPublicKey);
    const signature = base64ToBytes(sign);
    for (const includeSignType of [true, false]) {
      if (await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        key,
        signature,
        toBytes(canonical(params, includeSignType)),
      )) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const alipayChannel: PaymentChannel = {
  id: "alipay",
  async queryTrade(env: Env, order: PaymentOrder): Promise<ChannelQueryResult> {
    const result = await callAlipayApi(env, "alipay.trade.query", { out_trade_no: order.order_no });
    const tradeStatus = String(result.data.trade_status ?? "");
    const tradeNo = String(result.data.trade_no ?? order.alipay_trade_no ?? "");
    const buyerId = result.data.buyer_user_id === undefined && result.data.buyer_id === undefined
      ? order.buyer_id
      : String(result.data.buyer_user_id ?? result.data.buyer_id ?? "");
    if (!result.ok) {
      return {
        ok: false,
        state: "unknown",
        tradeNo,
        buyerId,
        message: result.subMessage || result.message || result.subCode || "支付宝暂未返回交易结果",
      };
    }
    if (["TRADE_SUCCESS", "TRADE_FINISHED"].includes(tradeStatus)) {
      const totalCents = parseCnyCents(String(result.data.total_amount ?? ""));
      if (!tradeNo || totalCents === null || totalCents !== order.amount_cents) throw new Error("支付宝查询金额校验失败");
      return { ok: true, state: "paid", tradeNo, buyerId };
    }
    if (tradeStatus === "TRADE_CLOSED") return { ok: true, state: "closed", tradeNo, buyerId };
    return { ok: true, state: "pending", tradeNo, buyerId };
  },

  async closeTrade(env: Env, order: PaymentOrder): Promise<ChannelCloseResult> {
    const result = await callAlipayApi(env, "alipay.trade.close", { out_trade_no: order.order_no });
    if (result.ok || /TRADE_NOT_EXIST/.test(result.subCode)) return { ok: true, closed: true };
    if (/TRADE_HAS_SUCCESS/.test(result.subCode)) {
      return { ok: true, closed: false, paidInstead: true, message: "支付宝交易已成功，未关闭订单" };
    }
    return { ok: false, closed: false, message: result.subMessage || result.message || result.subCode || "支付宝未关闭订单" };
  },

  async refund(env: Env, order: PaymentOrder, refund: PaymentRefund, amountCents: number, reason: string): Promise<ChannelRefundResult> {
    const bizContent: Record<string, unknown> = {
      out_trade_no: order.order_no,
      refund_amount: (amountCents / 100).toFixed(2),
      refund_reason: reason || "订单退款",
      out_request_no: refund.out_request_no,
    };
    if (order.alipay_trade_no) bizContent.trade_no = order.alipay_trade_no;
    const result = await callAlipayApi(env, "alipay.trade.refund", bizContent);
    if (!result.ok) {
      return {
        ok: false,
        state: "failed",
        code: result.subCode || result.code,
        message: result.subMessage || result.message || "支付宝拒绝退款",
      };
    }
    return {
      ok: true,
      state: "success",
      refundNo: String(result.data.refund_no ?? "") || undefined,
      tradeNo: String(result.data.trade_no ?? "") || undefined,
      code: result.code,
      message: result.message,
    };
  },

  async queryRefund(env: Env, order: PaymentOrder, refund: PaymentRefund): Promise<ChannelRefundResult> {
    const bizContent: Record<string, unknown> = { out_trade_no: order.order_no, out_request_no: refund.out_request_no };
    if (order.alipay_trade_no) bizContent.trade_no = order.alipay_trade_no;
    const result = await callAlipayApi(env, "alipay.trade.fastpay.refund.query", bizContent);
    if (result.ok) {
      return {
        ok: true,
        state: "success",
        refundNo: String(result.data.refund_no ?? "") || undefined,
        tradeNo: String(result.data.trade_no ?? "") || undefined,
        code: result.code,
        message: result.message,
      };
    }
    return {
      ok: false,
      state: "unknown",
      code: result.subCode || result.code,
      message: result.subMessage || result.message || "支付宝暂未确认退款结果",
    };
  },
};
