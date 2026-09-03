import { base64UrlDecode, base64UrlEncode, toBytes } from "../crypto/base64";

const COOKIE_NAME = "saas_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 12;

async function deriveHmacKey(env: Env): Promise<CryptoKey> {
  const source = await crypto.subtle.importKey(
    "raw",
    toBytes(`${env.ADMIN_USERNAME}\n${env.ADMIN_PASSWORD}`),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const salt = await crypto.subtle.digest("SHA-256", toBytes("saas-store-cf:v1"));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: toBytes("admin-session-v1") },
    source,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

function parseCookies(request: Request): Record<string, string> {
  const cookie = request.headers.get("Cookie") ?? "";
  const out: Record<string, string> = {};
  for (const part of cookie.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return out;
}

async function constantTimeTextEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", toBytes(a)),
    crypto.subtle.digest("SHA-256", toBytes(b)),
  ]);
  const aa = new Uint8Array(da);
  const bb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export async function verifyAdminCredentials(env: Env, username: string, password: string): Promise<boolean> {
  const [userOk, passOk] = await Promise.all([
    constantTimeTextEqual(username, env.ADMIN_USERNAME),
    constantTimeTextEqual(password, env.ADMIN_PASSWORD),
  ]);
  return userOk && passOk;
}

export async function createAdminSessionCookie(env: Env): Promise<string> {
  const payload = {
    sub: "admin",
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    nonce: crypto.randomUUID(),
  };
  const payloadB64 = base64UrlEncode(toBytes(JSON.stringify(payload)));
  const key = await deriveHmacKey(env);
  const signature = await crypto.subtle.sign("HMAC", key, toBytes(payloadB64));
  const token = `${payloadB64}.${base64UrlEncode(new Uint8Array(signature))}`;
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

export function clearAdminSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function isAdmin(request: Request, env: Env): Promise<boolean> {
  const token = parseCookies(request)[COOKIE_NAME];
  if (!token) return false;
  const [payloadB64, signatureB64] = token.split(".");
  if (!payloadB64 || !signatureB64) return false;
  try {
    const key = await deriveHmacKey(env);
    const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signatureB64), toBytes(payloadB64));
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as { sub?: string; exp?: number };
    return payload.sub === "admin" && typeof payload.exp === "number" && payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

export function assertSameOrigin(request: Request, options: { allowBrowserFallback?: boolean } = {}): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return true;
  const expectedOrigin = new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  // An explicit foreign or opaque Origin must never be overridden by fallback headers.
  if (origin !== null) return origin === expectedOrigin;
  if (!options.allowBrowserFallback) return false;

  const fetchSite = request.headers.get("Sec-Fetch-Site");
  if (fetchSite !== null && fetchSite !== "same-origin") return false;
  const referer = request.headers.get("Referer");
  if (referer !== null) {
    try { return new URL(referer).origin === expectedOrigin; } catch { return false; }
  }
  return fetchSite === "same-origin";
}
