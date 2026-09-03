import { bytesToBase64, toBytes } from "../crypto/base64";
import { decryptSecret, encryptSecret } from "../crypto/secrets";
import { json } from "../http";
import { asRecord } from "./rsa";
import { getWechatConfig, type WechatConfig } from "./wechat";

const BROWSER_COOKIE = "__Host-saas_wechat_oauth";
const SESSION_COOKIE = "__Host-saas_wechat_session";
const OAUTH_TTL = 600;
const SESSION_TTL = 7200;
const CALLBACK_PATH = "/api/payment/wechat/oauth/callback";

function readCookie(request: Request, name: string): string {
  const item = (request.headers.get("cookie") ?? "").split(";").find((part) => part.trim().startsWith(`${name}=`));
  try { return item ? decodeURIComponent(item.trim().slice(name.length + 1)) : ""; } catch { return ""; }
}

function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function timestamp(): number { return Math.floor(Date.now() / 1000); }

async function browserHash(value: string): Promise<string> {
  return bytesToBase64(new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(value))));
}

function ensureOAuthConfigured(config: WechatConfig): void {
  if (!config.enabled || !config.jsapiEnabled) throw new Error("微信内支付未启用");
  if (!config.appId || !config.appSecret) throw new Error("请在后台配置微信支付的公众号 AppID 和 AppSecret");
}

export async function getWechatOpenId(request: Request, env: Env, appId: string): Promise<string | null> {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  try {
    const session = asRecord(JSON.parse(await decryptSecret(env, token)));
    if (session?.purpose !== "wechat-jsapi" || session.appid !== appId || typeof session.exp !== "number" || session.exp <= timestamp()) return null;
    return typeof session.openid === "string" && session.openid.length > 0 && session.openid.length <= 128 ? session.openid : null;
  } catch { return null; }
}

export async function startWechatOAuth(request: Request, env: Env, config: WechatConfig, orderNo: string): Promise<Response> {
  ensureOAuthConfigured(config);
  const origin = new URL(request.url).origin;
  if (!origin.startsWith("https://")) throw new Error("微信内支付需要使用 HTTPS 域名");
  const existing = readCookie(request, BROWSER_COOKIE);
  const browser = /^[a-f0-9]{32}$/.test(existing) ? existing : crypto.randomUUID().replace(/-/g, "");
  const state = crypto.randomUUID().replace(/-/g, "");
  const now = timestamp();
  await env.DB.prepare("DELETE FROM wechat_oauth_states WHERE expires_at<=?").bind(now).run();
  await env.DB.prepare("INSERT INTO wechat_oauth_states(state,browser_hash,order_no,app_id,expires_at) VALUES(?,?,?,?,?)")
    .bind(state, await browserHash(browser), orderNo, config.appId, now + OAUTH_TTL).run();
  const authorize = new URL("https://open.weixin.qq.com/connect/oauth2/authorize");
  authorize.search = new URLSearchParams({ appid: config.appId, redirect_uri: origin + CALLBACK_PATH, response_type: "code", scope: "snsapi_base", state }).toString();
  authorize.hash = "wechat_redirect";
  return json({ ok: true, mode: "redirect", redirect_url: authorize.href }, { headers: { "set-cookie": cookie(BROWSER_COOKIE, browser, OAUTH_TTL) } });
}

export async function handleWechatOAuthCallback(request: Request, env: Env, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  const browser = readCookie(request, BROWSER_COOKIE);
  const destination = new URL("/payment/result", url.origin);
  const headers = new Headers({ "cache-control": "no-store", "referrer-policy": "no-referrer" });
  const redirect = (error?: string): Response => {
    if (error) destination.searchParams.set("wechat_auth", error);
    else destination.searchParams.set("pay", "wxjsapi");
    headers.set("location", destination.href);
    return new Response(null, { status: 303, headers });
  };
  if (!/^[a-f0-9]{32}$/.test(state) || !/^[a-f0-9]{32}$/.test(browser)) return redirect("expired");
  // 原子消费一次性 state，同时绑定发起授权的浏览器和订单。
  const pending = await env.DB.prepare("DELETE FROM wechat_oauth_states WHERE state=? AND browser_hash=? AND expires_at>? RETURNING order_no,app_id")
    .bind(state, await browserHash(browser), timestamp()).first<{ order_no: string; app_id: string }>();
  if (!pending) return redirect("expired");
  destination.searchParams.set("order_no", pending.order_no);
  const code = url.searchParams.get("code");
  if (!code || code.length > 512) return redirect("denied");
  try {
    const config = await getWechatConfig(env);
    ensureOAuthConfigured(config);
    if (config.appId !== pending.app_id) return redirect("expired");
    const tokenUrl = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
    tokenUrl.search = new URLSearchParams({ appid: config.appId, secret: config.appSecret, code, grant_type: "authorization_code" }).toString();
    const response = await fetch(tokenUrl, { redirect: "error", signal: AbortSignal.timeout(10000) });
    const data = asRecord(await response.json());
    if (!response.ok || data?.errcode || typeof data?.openid !== "string" || !data.openid || data.openid.length > 128) return redirect("failed");
    // 不把 OpenID、AppSecret 或网页授权 access_token 交给前端。
    const session = await encryptSecret(env, JSON.stringify({ purpose: "wechat-jsapi", appid: config.appId, openid: data.openid, exp: timestamp() + SESSION_TTL }));
    headers.append("set-cookie", cookie(SESSION_COOKIE, session, SESSION_TTL));
    return redirect();
  } catch {
    // 请求地址含 AppSecret，避免将底层请求错误或授权响应写入日志/回跳地址。
    return redirect("failed");
  }
}
