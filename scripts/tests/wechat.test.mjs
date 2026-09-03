import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import "./register-typescript.mjs";

const { handlePublic } = await import("../../worker/routes/public.ts");
const { orderNo: generateOrderNo } = await import("../../worker/http.ts");
const { getWechatConfig, createWechatJsapiPayment } = await import("../../worker/payment/wechat.ts");
const { getWechatOpenId } = await import("../../worker/payment/wechat-oauth.ts");
const { setSetting } = await import("../../worker/db/settings.ts");
const { encryptSecret } = await import("../../worker/crypto/secrets.ts");
const { invokeWechatJsapi } = await import("../../src/shared/wechat.ts");
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
const origin = "https://shop.example";
const wxUA = "Mozilla/5.0 iPhone MicroMessenger/8.0";
const orderNo = "TEST_JSAPI_001";

async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  t.after(() => db.close());
  const env = {
    SETTINGS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        let values = [];
        return {
          bind(...args) { values = args; return this; },
          async run() { return { meta: { changes: Number(stmt.run(...values).changes) } }; },
          async first() { return stmt.get(...values) ?? null; },
          async all() { return { results: stmt.all(...values) }; },
        };
      },
    },
  };
  for (const [key, value, encrypted = false] of [
    ["enabled", "true"], ["jsapi_enabled", "true"], ["app_id", "wx_test"], ["app_secret", "test_app_secret", true],
    ["mch_id", "123456"], ["mch_serial_no", "test_serial"], ["api_v3_key", "1".repeat(32), true], ["private_key", privateKey, true],
  ]) await setSetting(env, `payment.wechat.${key}`, value, encrypted);
  db.prepare("INSERT INTO orders(id,order_no,product_id,plan_id,product_name,plan_name,amount_cents,status) VALUES(?,?,?,?,?,?,?,?)")
    .run("jsapi_order", orderNo, "test_product", "test_plan", "产品", "套餐", 1234, "pending");
  // Every payment test must explicitly provide its simulated provider response.
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected outbound request"); });
  return { db, env, fetchMock };
}

function paymentRequest(cookie = "", userAgent = wxUA, body = {}, requestOrigin = origin) {
  return new Request(`${requestOrigin}/api/payment/wechat/create`, {
    method: "POST", headers: { "content-type": "application/json", origin: requestOrigin, "user-agent": userAgent, cookie, "cf-connecting-ip": "203.0.113.1" },
    body: JSON.stringify({ order_no: orderNo, ...body }),
  });
}
async function handle(request, env) { return handlePublic(request, env, new URL(request.url)); }
function cookiePair(response) { return response.headers.get("set-cookie")?.split(";")[0] ?? ""; }

test("generated order numbers fit the WeChat contract and reach every payment mode unchanged", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  const no = generateOrderNo();
  assert.match(no, /^[A-Za-z0-9_|*\-]{6,32}$/);
  db.prepare("UPDATE orders SET order_no=? WHERE order_no=?").run(no, orderNo);
  const token = await encryptSecret(env, JSON.stringify({ purpose: "wechat-jsapi", appid: "wx_test", openid: "openid", exp: Math.floor(Date.now() / 1000) + 300 }));
  for (const [ua, mode] of [["Windows Chrome", "native"], ["iPhone Safari", "h5"], [wxUA, "jsapi"]]) {
    fetchMock.mock.mockImplementation(async (url, init) => {
      assert.equal(new URL(url).pathname, `/v3/pay/transactions/${mode}`);
      assert.equal(JSON.parse(init.body).out_trade_no, no);
      return Response.json({ code_url: "weixin://pay/test", h5_url: "https://wx.tenpay.com/pay", prepay_id: "wx_test_prepay" });
    });
    const response = await handle(paymentRequest(`__Host-saas_wechat_session=${encodeURIComponent(token)}`, ua, { order_no: no }), env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, mode);
  }
});

test("legacy oversized order numbers show an actionable error without initiating payment", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  const legacyNo = "ORD20260903120000" + "A".repeat(24);
  db.prepare("UPDATE orders SET order_no=? WHERE order_no=?").run(legacyNo, orderNo);
  for (const ua of ["Windows Chrome", "iPhone Safari", wxUA]) {
    const response = await handle(paymentRequest("", ua, { order_no: legacyNo }), env);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /订单号.*重新下单/);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(db.prepare("SELECT count(*) n FROM wechat_oauth_states").get().n, 0);
  assert.equal(db.prepare("SELECT status FROM orders WHERE order_no=?").get(legacyNo).status, "pending");
});

async function begin(env) {
  const response = await handle(paymentRequest(), env);
  assert.equal(response.status, 200);
  const payment = await response.json();
  assert.equal(payment.mode, "redirect");
  const authorize = new URL(payment.redirect_url);
  assert.equal(authorize.origin, "https://open.weixin.qq.com");
  assert.equal(authorize.searchParams.get("scope"), "snsapi_base");
  const callback = new URL(authorize.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", authorize.searchParams.get("state"));
  callback.searchParams.set("code", "test_code");
  return { response, callback, browser: cookiePair(response) };
}

test("JSAPI signs the server order and client bridge parameters with the merchant RSA key", async (t) => {
  const { env, fetchMock } = await fixture(t);
  fetchMock.mock.mockImplementation(async (url, init) => {
    assert.equal(url, "https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.payer, { openid: "authorized_openid" });
    assert.deepEqual(body.amount, { total: 1234, currency: "CNY" });
    assert.equal(body.appid, "wx_test");
    assert.equal(body.mchid, "123456");
    assert.equal(body.out_trade_no, orderNo);
    assert.equal(body.notify_url, `${origin}/api/payment/wechat/notify`);
    const auth = Object.fromEntries([...init.headers.authorization.matchAll(/(\w+)="([^"]+)"/g)].map((match) => [match[1], match[2]]));
    const signed = `POST\n/v3/pay/transactions/jsapi\n${auth.timestamp}\n${auth.nonce_str}\n${init.body}\n`;
    assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, Buffer.from(auth.signature, "base64"), new TextEncoder().encode(signed)));
    return Response.json({ prepay_id: "wx_test_prepay" });
  });
  const params = await createWechatJsapiPayment(await getWechatConfig(env), { orderNo, amountCents: 1234, description: "产品", notifyUrl: `${origin}/api/payment/wechat/notify`, openid: "authorized_openid" });
  assert.equal(params.signType, "RSA");
  assert.equal(params.package, "prepay_id=wx_test_prepay");
  assert.match(params.timeStamp, /^\d{10}$/);
  assert.equal(params.nonceStr.length, 32);
  const signed = `${params.appId}\n${params.timeStamp}\n${params.nonceStr}\n${params.package}\n`;
  assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, Buffer.from(params.paySign, "base64"), new TextEncoder().encode(signed)));
});

test("OAuth round trip resumes the same order, keeps secrets encrypted, and ignores client payer/amount", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  const { response, callback, browser } = await begin(env);
  assert.match(response.headers.get("set-cookie"), /HttpOnly; Secure; SameSite=Lax/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const secret = db.prepare("SELECT value,encrypted FROM settings WHERE key='payment.wechat.app_secret'").get();
  assert.equal(secret.encrypted, 1);
  assert.notEqual(secret.value, "test_app_secret");
  fetchMock.mock.mockImplementation(async (url) => {
    const target = new URL(url);
    assert.equal(target.origin, "https://api.weixin.qq.com");
    assert.equal(target.pathname, "/sns/oauth2/access_token");
    assert.equal(target.searchParams.get("secret"), "test_app_secret");
    assert.equal(target.searchParams.get("code"), "test_code");
    assert.equal(target.searchParams.get("appid"), "wx_test");
    return Response.json({ openid: "authorized_openid", access_token: "do_not_expose" });
  });
  callback.searchParams.set("order_no", "attacker_order");
  callback.searchParams.set("redirect_uri", "https://attacker.example");
  const completed = await handle(new Request(callback, { headers: { cookie: browser } }), env);
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get("location"), `${origin}/payment/result?order_no=${orderNo}&pay=wxjsapi`);
  assert.equal(completed.headers.get("referrer-policy"), "no-referrer");
  const session = cookiePair(completed);
  assert.ok(session);
  assert.doesNotMatch(session, /authorized_openid|do_not_expose|test_app_secret/);
  fetchMock.mock.mockImplementation(async (url, init) => {
    assert.equal(new URL(url).pathname, "/v3/pay/transactions/jsapi");
    const body = JSON.parse(init.body);
    assert.equal(body.payer.openid, "authorized_openid");
    assert.equal(body.amount.total, 1234);
    return Response.json({ prepay_id: "wx_prepay" });
  });
  const paidRequest = await handle(paymentRequest(session, wxUA, { openid: "attacker", amount_cents: 1 }), env);
  assert.equal((await paidRequest.json()).mode, "jsapi");
  assert.equal(db.prepare("SELECT status FROM orders WHERE order_no=?").get(orderNo).status, "pending");
  assert.equal(db.prepare("SELECT count(*) n FROM wechat_oauth_states").get().n, 0);
  const replay = await handle(new Request(callback, { headers: { cookie: browser } }), env);
  assert.match(replay.headers.get("location"), /wechat_auth=expired$/);
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("OAuth rejects missing/wrong browser, expired state, denied authorization and changed AppID", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  const flow = await begin(env);
  for (const cookie of ["", "__Host-saas_wechat_oauth=" + "0".repeat(32)]) {
    const result = await handle(new Request(flow.callback, { headers: { cookie } }), env);
    assert.match(result.headers.get("location"), /wechat_auth=expired$/);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM wechat_oauth_states").get().n, 1);
  db.exec("UPDATE wechat_oauth_states SET expires_at=1");
  const expired = await handle(new Request(flow.callback, { headers: { cookie: flow.browser } }), env);
  assert.match(expired.headers.get("location"), /wechat_auth=expired$/);
  const denied = await begin(env);
  denied.callback.searchParams.delete("code");
  const deniedResult = await handle(new Request(denied.callback, { headers: { cookie: denied.browser } }), env);
  assert.match(deniedResult.headers.get("location"), /wechat_auth=denied$/);
  const changed = await begin(env);
  await setSetting(env, "payment.wechat.app_id", "wx_changed");
  const changedResult = await handle(new Request(changed.callback, { headers: { cookie: changed.browser } }), env);
  assert.match(changedResult.headers.get("location"), /wechat_auth=expired$/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("OAuth failures return a retry page without leaking provider responses", async (t) => {
  const { env, fetchMock } = await fixture(t);
  for (const payload of [{ errcode: 40029, errmsg: "secret_provider_error" }, {}, { openid: 123 }]) {
    const flow = await begin(env);
    fetchMock.mock.mockImplementation(async () => Response.json(payload));
    const response = await handle(new Request(flow.callback, { headers: { cookie: flow.browser } }), env);
    assert.match(response.headers.get("location"), /wechat_auth=failed$/);
    assert.equal(response.headers.get("set-cookie"), null);
    assert.doesNotMatch(response.headers.get("location"), /secret_provider_error/);
  }
  await setSetting(env, "payment.wechat.app_secret", "");
  const missing = await handle(paymentRequest(), env);
  assert.match((await missing.json()).error, /公众号 AppID 和 AppSecret/);
});

test("OpenID sessions reject tampering, expiration, wrong purpose and different AppID", async (t) => {
  const { env } = await fixture(t);
  const valid = { purpose: "wechat-jsapi", appid: "wx_test", openid: "openid", exp: Math.floor(Date.now() / 1000) + 300 };
  for (const override of [{ exp: 0 }, { appid: "wx_other" }, { purpose: "other" }, { openid: 123 }]) {
    const token = await encryptSecret(env, JSON.stringify({ ...valid, ...override }));
    assert.equal(await getWechatOpenId(paymentRequest(`__Host-saas_wechat_session=${encodeURIComponent(token)}`), env, "wx_test"), null);
  }
  assert.equal(await getWechatOpenId(paymentRequest("__Host-saas_wechat_session=forged"), env, "wx_test"), null);
  const token = await encryptSecret(env, JSON.stringify(valid));
  assert.equal(await getWechatOpenId(paymentRequest(`__Host-saas_wechat_session=${encodeURIComponent(token)}`), env, "wx_test"), "openid");
});

test("browser routing preserves H5/Native and uses Native in WeChat when JSAPI is off", async (t) => {
  const { env, fetchMock } = await fixture(t);
  for (const [ua, enabled, mode] of [["iPhone Safari", "true", "h5"], ["Windows Chrome", "true", "native"], [wxUA, "false", "native"]]) {
    await setSetting(env, "payment.wechat.jsapi_enabled", enabled);
    fetchMock.mock.mockImplementation(async (url) => {
      assert.equal(new URL(url).pathname, `/v3/pay/transactions/${mode}`);
      return Response.json(mode === "h5" ? { h5_url: "https://wx.tenpay.com/pay" } : { code_url: "weixin://pay/test" });
    });
    const response = await handle(paymentRequest("", ua), env);
    assert.equal((await response.json()).mode, mode);
  }
});

test("canonical domain is reached before OAuth cookies are created", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  await setSetting(env, "site.primary_domain", origin);
  const response = await handle(paymentRequest("", wxUA, {}, "https://alias.example"), env);
  assert.equal((await response.json()).redirect_url, `${origin}/payment/result?order_no=${orderNo}&pay=wxjsapi`);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(db.prepare("SELECT count(*) n FROM wechat_oauth_states").get().n, 0);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("paid/closed orders and cross-origin requests never initiate a payment", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  const forged = paymentRequest();
  forged.headers.set("origin", "https://attacker.example");
  assert.equal((await handle(forged, env)).status, 403);
  for (const status of ["paid", "closed", "refunded"]) {
    db.prepare("UPDATE orders SET status=? WHERE order_no=?").run(status, orderNo);
    assert.equal((await handle(paymentRequest(), env)).status, 409);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("browser payments without Origin accept verified same-origin Referer or Fetch Metadata", async (t) => {
  const { env, fetchMock } = await fixture(t);
  for (const [ua, mode] of [["iPhone Safari", "h5"], ["Windows Chrome", "native"], [wxUA, "redirect"]]) {
    for (const headers of [{ referer: origin + "/checkout?plan=test" }, { "sec-fetch-site": "same-origin" }, { referer: origin + "/payment/result", "sec-fetch-site": "same-origin" }]) {
      const request = paymentRequest("", ua);
      request.headers.delete("origin");
      for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
      fetchMock.mock.mockImplementation(async (url) => {
        assert.equal(new URL(url).pathname, `/v3/pay/transactions/${mode}`);
        return Response.json(mode === "h5" ? { h5_url: "https://wx.tenpay.com/pay" } : { code_url: "weixin://pay/test" });
      });
      const response = await handle(request, env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).mode, mode);
    }
  }
  assert.equal(fetchMock.mock.callCount(), 6);
});

test("payment origin fallback rejects foreign, opaque, conflicting and unverifiable sources", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  for (const headers of [
    {}, { origin: "null", referer: origin + "/", "sec-fetch-site": "same-origin" },
    { origin: "https://other.example", referer: origin + "/", "sec-fetch-site": "same-origin" },
    { referer: origin + ".other.example/" }, { referer: "https://other.example/?from=" + origin },
    { referer: "http://shop.example/" }, { referer: "https://shop.example:8443/" },
    { referer: "not-a-url" }, { referer: "/checkout" }, { referer: "https://other.example/", "sec-fetch-site": "same-origin" },
    { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-site": "none" },
    { referer: origin + "/", "sec-fetch-site": "cross-site" },
  ]) {
    const request = paymentRequest();
    request.headers.delete("origin");
    for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
    const response = await handle(request, env);
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  assert.equal(fetchMock.mock.callCount(), 0);
  assert.equal(db.prepare("SELECT count(*) n FROM wechat_oauth_states").get().n, 0);
});

test("invalid JSAPI provider responses fail without creating bridge parameters", async (t) => {
  const { env, fetchMock } = await fixture(t);
  for (const payload of [{}, { prepay_id: 42 }, { code: "APPID_MCHID_NOT_MATCH", message: "AppID未绑定" }]) {
    fetchMock.mock.mockImplementation(async () => Response.json(payload));
    await assert.rejects(createWechatJsapiPayment(await getWechatConfig(env), { orderNo, amountCents: 1234, description: "产品", notifyUrl: `${origin}/notify`, openid: "openid" }));
  }
});

function browserFixture(t, bridge) {
  const previous = new Map(["window", "document", "navigator"].map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const document = new EventTarget();
  const window = { WeixinJSBridge: bridge, setTimeout, clearTimeout };
  for (const [name, value] of Object.entries({ window, document, navigator: { userAgent: wxUA } })) Object.defineProperty(globalThis, name, { value, configurable: true });
  t.after(() => { for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; } });
  return { window, document };
}

test("JSBridge handles submit, cancel, failure and delayed readiness", async (t) => {
  const { window, document } = browserFixture(t);
  const params = { appId: "wx_test", timeStamp: "1234567890", nonceStr: "nonce", package: "prepay_id=test", signType: "RSA", paySign: "signature" };
  const waiting = invokeWechatJsapi(params);
  window.WeixinJSBridge = { invoke(method, input, callback) { assert.equal(method, "getBrandWCPayRequest"); assert.equal(input, params); callback({ err_msg: "get_brand_wcpay_request:ok" }); } };
  document.dispatchEvent(new Event("WeixinJSBridgeReady"));
  assert.equal(await waiting, "submitted");
  window.WeixinJSBridge.invoke = (_, __, callback) => callback({ err_msg: "get_brand_wcpay_request:cancel" });
  assert.equal(await invokeWechatJsapi(params), "cancelled");
  window.WeixinJSBridge.invoke = (_, __, callback) => callback({ err_msg: "get_brand_wcpay_request:fail" });
  await assert.rejects(invokeWechatJsapi(params), /微信支付未完成/);
});
