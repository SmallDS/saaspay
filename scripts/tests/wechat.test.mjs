import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import "./register-typescript.mjs";

const { handlePublic } = await import("../../worker/routes/public.ts");
const { orderNo: generateOrderNo } = await import("../../worker/http.ts");
const { setSetting } = await import("../../worker/db/settings.ts");
const keys = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const privateKey = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64");
const origin = "https://shop.example";
const wxUA = "Mozilla/5.0 iPhone MicroMessenger/8.0";
const orderNo = "TEST_NATIVE_001";

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
    ["enabled", "true"], ["app_id", "wx_test"],
    ["mch_id", "123456"], ["mch_serial_no", "test_serial"], ["api_v3_key", "1".repeat(32), true], ["private_key", privateKey, true],
  ]) await setSetting(env, `payment.wechat.${key}`, value, encrypted);
  db.prepare("INSERT INTO orders(id,order_no,product_id,plan_id,product_name,plan_name,amount_cents,status) VALUES(?,?,?,?,?,?,?,?)")
    .run("native_order", orderNo, "test_product", "test_plan", "产品", "套餐", 1234, "pending");
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

test("Native signs server order data and ignores client amount/payer in every browser", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  const no = generateOrderNo();
  assert.match(no, /^[A-Za-z0-9_|*\-]{6,32}$/);
  db.prepare("UPDATE orders SET order_no=? WHERE order_no=?").run(no, orderNo);
  // Old JSAPI settings/cookies must not re-enable OAuth or affect Native.
  await setSetting(env, "payment.wechat.jsapi_enabled", "true");
  await setSetting(env, "payment.wechat.app_secret", "unused-old-secret");
  fetchMock.mock.mockImplementation(async (url, init) => {
    assert.equal(url, "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
    const body = JSON.parse(init.body);
    assert.equal(body.out_trade_no, no);
    assert.equal(body.appid, "wx_test");
    assert.equal(body.mchid, "123456");
    assert.equal(body.description, "产品 - 套餐");
    assert.equal(body.notify_url, origin + "/api/payment/wechat/notify");
    assert.deepEqual(body.amount, { total: 1234, currency: "CNY" });
    assert.equal(body.payer, undefined);
    assert.ok(Date.parse(body.time_expire) > Date.now());
    const auth = Object.fromEntries([...init.headers.authorization.matchAll(/(\w+)="([^"]+)"/g)].map((match) => [match[1], match[2]]));
    const signed = `POST\n/v3/pay/transactions/native\n${auth.timestamp}\n${auth.nonce_str}\n${init.body}\n`;
    assert.ok(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", keys.publicKey, Buffer.from(auth.signature, "base64"), new TextEncoder().encode(signed)));
    return Response.json({ code_url: "weixin://wxpay/bizpayurl?pr=test" });
  });
  for (const ua of ["Windows Chrome", "iPhone Safari", "Android Chrome", wxUA]) {
    const response = await handle(paymentRequest("__Host-saas_wechat_session=old-cookie", ua, { order_no: no, amount: 1, openid: "forged", payer: { openid: "forged" } }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, mode: "native", code_url: "weixin://wxpay/bizpayurl?pr=test" });
    assert.equal(response.headers.get("set-cookie"), null);
  }
  assert.equal(db.prepare("SELECT payment_provider FROM orders WHERE order_no=?").get(no).payment_provider, "wechat");
  assert.equal(db.prepare("SELECT count(*) n FROM orders").get().n, 1);
  assert.equal(db.prepare("SELECT count(*) n FROM wechat_oauth_states").get().n, 0);
});

test("legacy oversized order numbers fail before making provider requests", async (t) => {
  const { env, fetchMock } = await fixture(t);
  const response = await handle(paymentRequest("", wxUA, { order_no: "ORD20260903120000" + "A".repeat(24) }), env);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /订单号.*重新下单/);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Native uses the configured notification domain without OAuth redirects", async (t) => {
  const { env, fetchMock } = await fixture(t);
  await setSetting(env, "site.primary_domain", " HTTPS://CANONICAL.EXAMPLE:443/// ");
  fetchMock.mock.mockImplementation(async (url, init) => {
    assert.equal(new URL(url).pathname, "/v3/pay/transactions/native");
    assert.equal(JSON.parse(init.body).notify_url, "https://canonical.example/api/payment/wechat/notify");
    return Response.json({ code_url: "weixin://pay/test" });
  });
  const response = await handle(paymentRequest(), env);
  assert.equal((await response.json()).mode, "native");
  assert.equal(response.headers.get("set-cookie"), null);
});

test("Alipay desktop and mobile callback and return URLs use the same primary domain", async (t) => {
  const { env } = await fixture(t);
  await setSetting(env, "site.primary_domain", " HTTPS://CANONICAL.EXAMPLE:443/// ");
  await setSetting(env, "payment.alipay.enabled", "true");
  await setSetting(env, "payment.alipay.app_id", "test-app");
  await setSetting(env, "payment.alipay.private_key", privateKey, true);
  await setSetting(env, "payment.alipay.public_key", Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64"), true);
  for (const userAgent of ["Windows Chrome", "iPhone Safari"]) {
    const request = new Request(origin + "/api/payment/alipay/create", { method: "POST", headers: { "content-type": "application/json", "user-agent": userAgent }, body: JSON.stringify({ order_no: orderNo }) });
    const response = await handle(request, env);
    assert.equal(response.status, 200);
    const payment = await response.json();
    const fields = { ...Object.fromEntries(new URL(payment.payment_form.action).searchParams), ...payment.payment_form.fields };
    assert.equal(fields.notify_url, "https://canonical.example/api/payment/alipay/notify");
    assert.equal(fields.return_url, "https://canonical.example/payment/result?order_no=" + orderNo);
    if (payment.mode === "wap") assert.equal(JSON.parse(fields.biz_content).quit_url, fields.return_url);
    assert.ok(fields.sign);
  }
});

test("disabled or incomplete Native settings cannot initiate payment", async (t) => {
  const { env, fetchMock } = await fixture(t);
  await setSetting(env, "payment.wechat.enabled", "false");
  assert.equal((await handle(paymentRequest(), env)).status, 409);
  await setSetting(env, "payment.wechat.enabled", "true");
  await setSetting(env, "payment.wechat.app_id", "");
  const response = await handle(paymentRequest(), env);
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /配置不完整/);
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
  for (const [ua, mode] of [["iPhone Safari", "native"], ["Windows Chrome", "native"], [wxUA, "native"]]) {
    for (const headers of [{ referer: origin + "/checkout?plan=test" }, { "sec-fetch-site": "same-origin" }, { referer: origin + "/payment/result", "sec-fetch-site": "same-origin" }]) {
      const request = paymentRequest("", ua);
      request.headers.delete("origin");
      for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
      fetchMock.mock.mockImplementation(async (url) => {
        assert.equal(new URL(url).pathname, `/v3/pay/transactions/${mode}`);
        return Response.json({ code_url: "weixin://pay/test" });
      });
      const response = await handle(request, env);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).mode, mode);
    }
  }
  assert.equal(fetchMock.mock.callCount(), 9);
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

test("payment accepts the configured public origin when a proxy rewrites the upstream URL", async (t) => {
  const { env, fetchMock } = await fixture(t);
  const publicOrigin = "https://public-shop.example";
  env.WECHAT_PAYMENT_TRUSTED_ORIGINS = [publicOrigin];
  for (const headers of [{ origin: publicOrigin }, { referer: publicOrigin + "/checkout", "sec-fetch-site": "same-origin" }]) {
    const request = paymentRequest("", "Windows Chrome");
    request.headers.delete("origin");
    for (const [key, value] of Object.entries(headers)) request.headers.set(key, value);
    fetchMock.mock.mockImplementation(async (url, init) => {
      assert.equal(new URL(url).pathname, "/v3/pay/transactions/native");
      assert.equal(JSON.parse(init.body).out_trade_no, orderNo);
      return Response.json({ code_url: "weixin://pay/test" });
    });
    const response = await handle(request, env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).mode, "native");
  }
  assert.equal(fetchMock.mock.callCount(), 2);
});

test("trusted payment domains require exact matching and cannot be supplied through proxy headers", async (t) => {
  const { env, fetchMock } = await fixture(t);
  const publicOrigin = "https://public-shop.example";
  env.WECHAT_PAYMENT_TRUSTED_ORIGINS = [publicOrigin];
  for (const source of ["https://other.example", publicOrigin + ".other.example", "http://public-shop.example", publicOrigin + ":8443", "null"]) {
    const request = paymentRequest();
    request.headers.set("origin", source);
    request.headers.set("x-forwarded-host", new URL(source === "null" ? publicOrigin : source).host);
    request.headers.set("x-forwarded-proto", "https");
    request.headers.set("referer", publicOrigin + "/");
    assert.equal((await handle(request, env)).status, 403);
  }
  delete env.WECHAT_PAYMENT_TRUSTED_ORIGINS;
  const unconfigured = paymentRequest();
  unconfigured.headers.set("origin", publicOrigin);
  unconfigured.headers.set("x-forwarded-host", "public-shop.example");
  assert.equal((await handle(unconfigured, env)).status, 403);
  assert.equal(fetchMock.mock.callCount(), 0);
});


test("invalid Native responses do not become unusable QR codes and allow the same order to retry", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  for (const payload of [{}, { code_url: 42 }, { code_url: {} }, { code_url: "   " }, { code_url: "https://other.example" }]) {
    fetchMock.mock.mockImplementation(async () => Response.json(payload));
    const response = await handle(paymentRequest(), env);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code_url, undefined);
  }
  fetchMock.mock.mockImplementation(async () => Response.json({ code: "APPID_MCHID_NOT_MATCH", message: "AppID未绑定" }, { status: 400 }));
  const denied = await handle(paymentRequest(), env);
  assert.match((await denied.json()).error, /AppID未绑定/);
  fetchMock.mock.mockImplementation(async () => Response.json({ code_url: "weixin://pay/retry" }));
  assert.equal((await handle(paymentRequest(), env)).status, 200);
  assert.equal(db.prepare("SELECT count(*) n FROM orders").get().n, 1);
  assert.equal(db.prepare("SELECT status FROM orders WHERE order_no=?").get(orderNo).status, "pending");
});

test("Native polling confirms the provider amount before marking paid and skips paid orders", async (t) => {
  const { env, db, fetchMock } = await fixture(t);
  db.prepare("UPDATE orders SET payment_provider='wechat' WHERE order_no=?").run(orderNo);
  fetchMock.mock.mockImplementation(async (url) => {
    assert.match(url, /transactions\/out-trade-no\//);
    return Response.json({ trade_state: "SUCCESS", transaction_id: "wx_transaction", amount: { total: 1 } });
  });
  const request = () => new Request(origin + "/api/orders/" + orderNo);
  assert.equal((await (await handle(request(), env)).json()).order.status, "pending");
  fetchMock.mock.mockImplementation(async () => Response.json({ trade_state: "SUCCESS", transaction_id: "wx_transaction", amount: { total: 1234 } }));
  assert.equal((await (await handle(request(), env)).json()).order.status, "paid");
  assert.equal(db.prepare("SELECT transaction_id FROM orders WHERE order_no=?").get(orderNo).transaction_id, "wx_transaction");
  const calls = fetchMock.mock.callCount();
  assert.equal((await (await handle(request(), env)).json()).order.status, "paid");
  assert.equal(fetchMock.mock.callCount(), calls);
});

test("signed encrypted Native notifications reject tampering and wrong amounts, then confirm payment idempotently", async (t) => {
  const { env, db } = await fixture(t);
  const publicKey = Buffer.from(await crypto.subtle.exportKey("spki", keys.publicKey)).toString("base64");
  await setSetting(env, "payment.wechat.public_key", publicKey);
  await setSetting(env, "payment.wechat.public_key_id", "PUB_KEY_ID_TEST");
  db.prepare("UPDATE orders SET payment_provider='wechat' WHERE order_no=?").run(orderNo);
  const aesKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("1".repeat(32)), "AES-GCM", false, ["encrypt"]);
  async function notification(amount) {
    const resource = { appid: "wx_test", mchid: "123456", out_trade_no: orderNo, transaction_id: "wx_notify_transaction", amount: { total: amount, currency: "CNY" } };
    const nonce = "123456789012";
    const associated_data = "transaction";
    const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv: new TextEncoder().encode(nonce), additionalData: new TextEncoder().encode(associated_data) }, aesKey, new TextEncoder().encode(JSON.stringify(resource)));
    const body = JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { nonce, associated_data, ciphertext: Buffer.from(encrypted).toString("base64") } });
    const timestamp = String(Math.floor(Date.now()/1000));
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(`${timestamp}\n${nonce}\n${body}\n`));
    return new Request(origin + "/api/payment/wechat/notify", { method: "POST", body, headers: { "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-serial": "PUB_KEY_ID_TEST", "wechatpay-signature": Buffer.from(signature).toString("base64") } });
  }
  const tampered = await notification(1234);
  tampered.headers.set("wechatpay-signature", Buffer.alloc(256).toString("base64"));
  assert.equal((await handle(tampered, env)).status, 500);
  assert.equal((await handle(await notification(1), env)).status, 500);
  assert.equal(db.prepare("SELECT status FROM orders WHERE order_no=?").get(orderNo).status, "pending");
  for (let i = 0; i < 2; i++) assert.equal((await handle(await notification(1234), env)).status, 200);
  const order = db.prepare("SELECT status,transaction_id,payment_provider FROM orders WHERE order_no=?").get(orderNo);
  assert.deepEqual({ ...order }, { status: "paid", transaction_id: "wx_notify_transaction", payment_provider: "wechat" });
});
