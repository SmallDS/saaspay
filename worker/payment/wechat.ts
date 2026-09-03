import { base64ToBytes, bytesToBase64, toBytes } from "../crypto/base64";
import { getSettingValue, setSetting } from "../db/settings";
import type { ChannelCloseResult, ChannelQueryResult, ChannelRefundResult, PaymentChannel } from "./provider";
import { asRecord, importRsassaPrivateKey, importRsassaPublicKey } from "./rsa";
import type { PaymentOrder } from "../orders/lifecycle";
import type { PaymentRefund } from "../orders/refunds";

const WECHAT_API_BASE = "https://api.mch.weixin.qq.com";
const ORDER_EXPIRY_MINUTES = 30;

export type WechatConfig = {
  enabled: boolean;
  appId: string;
  mchId: string;
  mchSerialNo: string;
  apiV3Key: string;
  privateKey: string;
  publicKey: string;
  publicKeyId: string;
};

export class WechatPayError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export async function getWechatConfig(env: Env): Promise<WechatConfig> {
  return {
    enabled: (await getSettingValue(env, "payment.wechat.enabled", "false")) === "true",
    appId: await getSettingValue(env, "payment.wechat.app_id"),
    mchId: await getSettingValue(env, "payment.wechat.mch_id"),
    mchSerialNo: await getSettingValue(env, "payment.wechat.mch_serial_no"),
    apiV3Key: await getSettingValue(env, "payment.wechat.api_v3_key"),
    privateKey: await getSettingValue(env, "payment.wechat.private_key"),
    publicKey: await getSettingValue(env, "payment.wechat.public_key"),
    publicKeyId: await getSettingValue(env, "payment.wechat.public_key_id"),
  };
}

function ensureWechatConfigured(config: WechatConfig): void {
  if (!config.enabled) throw new Error("微信支付未启用");
  if (!config.appId || !config.mchId || !config.mchSerialNo || !config.apiV3Key || !config.privateKey) {
    throw new Error("微信支付配置不完整");
  }
}

function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function chinaRfc3339(date: Date): string {
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
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
}

function paymentExpiry(): string {
  return chinaRfc3339(new Date(Date.now() + ORDER_EXPIRY_MINUTES * 60 * 1000));
}

type WechatResponse = {
  ok: boolean;
  status: number;
  data: Record<string, unknown> | null;
};

async function wechatRequest(config: WechatConfig, method: "GET" | "POST", path: string, body?: unknown): Promise<WechatResponse> {
  const key = await importRsassaPrivateKey(config.privateKey);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = randomNonce();
  const bodyText = body === undefined ? "" : JSON.stringify(body);
  const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${bodyText}\n`;
  const signature = bytesToBase64(new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, toBytes(message))));
  const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${config.mchSerialNo}"`;
  const response = await fetch(WECHAT_API_BASE + path, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization,
      "user-agent": "saas-store-cf-wechatpay/1.0",
    },
    body: bodyText === "" ? undefined : bodyText,
  });
  const rawBody = await response.text();
  let data: Record<string, unknown> | null = null;
  if (rawBody) {
    try {
      data = asRecord(JSON.parse(rawBody));
    } catch {
      data = null;
    }
  }
  return { ok: response.ok, status: response.status, data };
}

function wechatError(data: Record<string, unknown> | null): { code: string; message: string } {
  return {
    code: String(data?.code ?? ""),
    message: String(data?.message ?? ""),
  };
}

async function decryptWithApiV3Key(apiV3Key: string, nonce: string, associatedData: string, ciphertextB64: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", toBytes(apiV3Key), { name: "AES-GCM" }, false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: toBytes(nonce), additionalData: associatedData ? toBytes(associatedData) : undefined },
    key,
    base64ToBytes(ciphertextB64),
  );
  return new TextDecoder().decode(plain);
}

export async function decryptWechatResource(apiV3Key: string, resource: Record<string, unknown>): Promise<Record<string, unknown>> {
  const plaintext = await decryptWithApiV3Key(
    apiV3Key,
    String(resource.nonce ?? ""),
    String(resource.associated_data ?? ""),
    String(resource.ciphertext ?? ""),
  );
  const parsed: unknown = JSON.parse(plaintext);
  return asRecord(parsed) ?? {};
}

type PlatformCerts = Record<string, string>;

async function loadPlatformCerts(env: Env): Promise<PlatformCerts> {
  const raw = await getSettingValue(env, "payment.wechat.platform_certs", "{}");
  try {
    const parsed: unknown = JSON.parse(raw);
    return asRecord(parsed) ? parsed as PlatformCerts : {};
  } catch {
    return {};
  }
}

async function refreshPlatformCerts(env: Env, config: WechatConfig): Promise<PlatformCerts> {
  const result = await wechatRequest(config, "GET", "/v3/certificates");
  if (!result.ok || !result.data) throw new WechatPayError("CERT_DOWNLOAD_FAILED", "微信支付平台证书下载失败");
  const items = Array.isArray(result.data.data) ? result.data.data : [];
  const certs: PlatformCerts = {};
  for (const item of items) {
    const record = asRecord(item);
    const serial = String(record?.serial_no ?? "");
    const encrypted = asRecord(record?.encrypt_certificate);
    if (!serial || !encrypted) continue;
    certs[serial] = await decryptWithApiV3Key(
      config.apiV3Key,
      String(encrypted.nonce ?? ""),
      String(encrypted.associated_data ?? ""),
      String(encrypted.ciphertext ?? ""),
    );
  }
  if (Object.keys(certs).length === 0) throw new WechatPayError("CERT_DOWNLOAD_FAILED", "微信支付平台证书下载失败");
  await setSetting(env, "payment.wechat.platform_certs", JSON.stringify(certs));
  return certs;
}

async function resolveWechatPublicKey(env: Env, config: WechatConfig, serial: string): Promise<CryptoKey | null> {
  if (serial.startsWith("PUB_KEY_ID_")) {
    if (!config.publicKey) return null;
    if (config.publicKeyId && config.publicKeyId !== serial) return null;
    return importRsassaPublicKey(config.publicKey);
  }
  let certs = await loadPlatformCerts(env);
  if (!certs[serial]) certs = await refreshPlatformCerts(env, config);
  const pem = certs[serial];
  return pem ? importRsassaPublicKey(pem) : null;
}

export async function verifyWechatNotify(env: Env, config: WechatConfig, headers: Headers, rawBody: string): Promise<boolean> {
  const timestamp = headers.get("wechatpay-timestamp") ?? "";
  const nonce = headers.get("wechatpay-nonce") ?? "";
  const signature = headers.get("wechatpay-signature") ?? "";
  const serial = headers.get("wechatpay-serial") ?? "";
  if (!timestamp || !nonce || !signature || !serial || !config.apiV3Key) return false;
  const timestampValue = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(timestampValue) || Math.abs(Date.now() / 1000 - timestampValue) > 600) return false;
  try {
    const publicKey = await resolveWechatPublicKey(env, config, serial);
    if (!publicKey) return false;
    const message = `${timestamp}\n${nonce}\n${rawBody}\n`;
    return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", publicKey, base64ToBytes(signature), toBytes(message));
  } catch {
    return false;
  }
}

export async function createWechatNativePayment(
  config: WechatConfig,
  input: { orderNo: string; amountCents: number; description: string; notifyUrl: string },
): Promise<{ code_url: string }> {
  ensureWechatConfigured(config);
  const result = await wechatRequest(config, "POST", "/v3/pay/transactions/native", {
    appid: config.appId,
    mchid: config.mchId,
    description: input.description.slice(0, 127),
    out_trade_no: input.orderNo,
    time_expire: paymentExpiry(),
    notify_url: input.notifyUrl,
    amount: { total: input.amountCents, currency: "CNY" },
  });
  const codeUrl = result.data?.code_url;
  if (!result.ok || typeof codeUrl !== "string" || !codeUrl.startsWith("weixin://")) {
    const error = wechatError(result.data);
    throw new WechatPayError(error.code, error.message || error.code || "微信支付下单失败");
  }
  return { code_url: codeUrl };
}

async function queryWechatTrade(config: WechatConfig, orderNo: string): Promise<{ state: string; transactionId: string; totalCents: number | null }> {
  const result = await wechatRequest(config, "GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(config.mchId)}`);
  if (!result.ok) {
    const error = wechatError(result.data);
    if (["ORDER_NOT_EXIST", "ORDERNOTEXIST"].includes(error.code)) {
      return { state: "NOTPAY", transactionId: "", totalCents: null };
    }
    throw new WechatPayError(error.code, error.message || error.code || "微信支付查单失败");
  }
  const amount = asRecord(result.data?.amount);
  const total = amount ? Number(amount.total) : Number.NaN;
  return {
    state: String(result.data?.trade_state ?? ""),
    transactionId: String(result.data?.transaction_id ?? ""),
    totalCents: Number.isSafeInteger(total) ? total : null,
  };
}

async function closeWechatTrade(config: WechatConfig, orderNo: string): Promise<void> {
  const result = await wechatRequest(config, "POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`, { mchid: config.mchId });
  if (result.ok) return;
  const error = wechatError(result.data);
  if (["ORDER_CLOSED", "ORDER_NOT_EXIST", "ORDERNOTEXIST"].includes(error.code)) return;
  throw new WechatPayError(error.code, error.message || error.code || "微信支付关单失败");
}

async function createWechatRefund(
  config: WechatConfig,
  input: { orderNo: string; outRefundNo: string; amountCents: number; totalCents: number; reason: string; notifyUrl?: string },
): Promise<{ status: string; refundId: string }> {
  const body: Record<string, unknown> = {
    out_trade_no: input.orderNo,
    out_refund_no: input.outRefundNo,
    reason: input.reason || "订单退款",
    amount: { refund: input.amountCents, total: input.totalCents, currency: "CNY" },
  };
  if (input.notifyUrl) body.notify_url = input.notifyUrl;
  const result = await wechatRequest(config, "POST", "/v3/refund/domestic/refunds", body);
  if (!result.ok) {
    const error = wechatError(result.data);
    throw new WechatPayError(error.code, error.message || error.code || "微信支付拒绝退款");
  }
  return {
    status: String(result.data?.status ?? ""),
    refundId: String(result.data?.refund_id ?? ""),
  };
}

export const wechatChannel: PaymentChannel = {
  id: "wechat",

  async queryTrade(env: Env, order: PaymentOrder): Promise<ChannelQueryResult> {
    const config = await getWechatConfig(env);
    ensureWechatConfigured(config);
    const trade = await queryWechatTrade(config, order.order_no);
    const tradeNo = trade.transactionId || order.transaction_id || "";
    if (trade.state === "SUCCESS" || trade.state === "REFUND") {
      if (!tradeNo || trade.totalCents === null || trade.totalCents !== order.amount_cents) {
        throw new Error("微信支付查单金额校验失败");
      }
      return { ok: true, state: "paid", tradeNo };
    }
    if (trade.state === "CLOSED" || trade.state === "REVOKED") return { ok: true, state: "closed", tradeNo };
    if (trade.state === "NOTPAY" || trade.state === "USERPAYING") return { ok: true, state: "pending", tradeNo };
    if (trade.state === "PAYERROR") {
      return { ok: true, state: "pending", tradeNo, message: "微信支付交易失败，可重新发起支付" };
    }
    return { ok: false, state: "unknown", tradeNo, message: `微信支付交易状态：${trade.state || "未知"}` };
  },

  async closeTrade(env: Env, order: PaymentOrder): Promise<ChannelCloseResult> {
    const config = await getWechatConfig(env);
    ensureWechatConfigured(config);
    try {
      await closeWechatTrade(config, order.order_no);
      return { ok: true, closed: true };
    } catch (error) {
      if (error instanceof WechatPayError) return { ok: false, closed: false, message: error.message };
      throw error;
    }
  },

  async refund(env: Env, order: PaymentOrder, refund: PaymentRefund, amountCents: number, reason: string): Promise<ChannelRefundResult> {
    const config = await getWechatConfig(env);
    ensureWechatConfigured(config);
    const domain = (await getSettingValue(env, "site.primary_domain")).replace(/\/$/, "");
    try {
      const created = await createWechatRefund(config, {
        orderNo: order.order_no,
        outRefundNo: refund.out_request_no,
        amountCents,
        totalCents: order.amount_cents,
        reason,
        notifyUrl: domain ? `${domain}/api/payment/wechat/notify` : undefined,
      });
      if (created.status === "SUCCESS") {
        return { ok: true, state: "success", refundNo: created.refundId || undefined, code: "SUCCESS", message: "退款成功" };
      }
      if (created.status === "CLOSED" || created.status === "ABNORMAL") {
        return {
          ok: true,
          state: "failed",
          code: created.status,
          message: created.status === "CLOSED" ? "退款已关闭" : "退款异常，请联系微信支付客服处理",
        };
      }
      return { ok: true, state: "processing", code: created.status || "PROCESSING", message: "退款已受理，等待微信支付确认" };
    } catch (error) {
      if (error instanceof WechatPayError) {
        return { ok: false, state: "failed", code: error.code, message: error.message };
      }
      throw error;
    }
  },

  async queryRefund(env: Env, order: PaymentOrder, refund: PaymentRefund): Promise<ChannelRefundResult> {
    const config = await getWechatConfig(env);
    ensureWechatConfigured(config);
    const result = await wechatRequest(config, "GET", `/v3/refund/domestic/refunds/${encodeURIComponent(refund.out_request_no)}`);
    if (!result.ok) {
      const error = wechatError(result.data);
      throw new WechatPayError(error.code, error.message || error.code || "微信支付退款查询失败");
    }
    const status = String(result.data?.status ?? "");
    const refundId = String(result.data?.refund_id ?? "");
    if (status === "SUCCESS") {
      return {
        ok: true,
        state: "success",
        refundNo: refundId || undefined,
        tradeNo: String(result.data?.transaction_id ?? "") || undefined,
        code: "SUCCESS",
        message: "退款成功",
      };
    }
    if (status === "CLOSED") return { ok: true, state: "failed", code: "CLOSED", message: "退款已关闭" };
    if (status === "ABNORMAL") return { ok: true, state: "failed", code: "ABNORMAL", message: "退款异常，请联系微信支付客服处理" };
    return { ok: true, state: "processing", code: status || "PROCESSING", message: "退款仍在处理中" };
  },
};
