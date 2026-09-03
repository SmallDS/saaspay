import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import "./register-typescript.mjs";

const { handleAdmin } = await import("../../worker/routes/admin.ts");
const { createAdminSessionCookie } = await import("../../worker/auth/session.ts");
const origin = "https://shop.example";

async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(dir).filter((file) => file.endsWith(".sql")).sort()) db.exec(readFileSync(new URL(file, dir), "utf8"));
  t.after(() => db.close());
  const env = {
    ADMIN_USERNAME: "test-admin", ADMIN_PASSWORD: "test-password",
    DB: { prepare(sql) {
      const stmt = db.prepare(sql);
      let values = [];
      return {
        bind(...args) { values = args; return this; },
        async run() { return { meta: { changes: Number(stmt.run(...values).changes) } }; },
        async first() { return stmt.get(...values) ?? null; },
        async all() { return { results: stmt.all(...values) }; },
      };
    } },
    WEBHOOK_QUEUE: { async send() { throw new Error("Deletion must not send a business event"); } },
  };
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("Deletion must not call a payment provider"); });
  const cookie = (await createAdminSessionCookie(env)).split(";")[0];
  function insert(no, status = "pending", amount = 100, refunded = 0) {
    db.prepare("INSERT INTO orders(id,order_no,product_id,plan_id,product_name,plan_name,amount_cents,status,refunded_cents) VALUES(?,?,?,?,?,?,?,?,?)")
      .run(no, no, "test-product", "test-plan", "测试产品", "测试套餐", amount, status, refunded);
  }
  function call(path, method = "POST", body, headers = {}) {
    const request = new Request(origin + "/api/admin/orders" + path, {
      method, headers: { origin, cookie, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return handleAdmin(request, env, new URL(request.url));
  }
  return { db, insert, call, fetchMock };
}

test("ordinary deletion still protects pending, paid and partially refunded orders", async (t) => {
  const { db, insert, call, fetchMock } = await fixture(t);
  for (const [no, status, amount, refunded, expected] of [
    ["pending", "pending", 100, 0, 409], ["paid", "paid", 100, 0, 409],
    ["partial", "paid", 100, 50, 409], ["closed", "closed", 100, 0, 200],
    ["refunded", "refunded", 100, 100, 200], ["free", "paid", 0, 0, 200],
  ]) {
    insert(no, status, amount, refunded);
    // A stray flag must not turn the ordinary endpoint into forced deletion.
    const response = await call(`/${no}?force=true`, "DELETE", { force: true });
    assert.equal(response.status, expected);
    assert.equal(Boolean(db.prepare("SELECT id FROM orders WHERE order_no=?").get(no)), expected === 409);
  }
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("force deletion removes only the chosen order and cascades related refunds and OAuth states", async (t) => {
  const { db, insert, call, fetchMock } = await fixture(t);
  insert("keep", "paid");
  for (const status of ["pending", "paid", "closed", "refunded"]) {
    const no = "ORD20260903120000" + status.padEnd(24, "A");
    insert(no, status);
    db.prepare("INSERT INTO payment_refunds(id,order_id,order_no,amount_cents,out_request_no) VALUES(?,?,?,?,?)").run(no, no, no, 1, no);
    db.prepare("INSERT INTO wechat_oauth_states(state,browser_hash,order_no,app_id,expires_at) VALUES(?,?,?,?,?)").run(no, "browser", no, "wx-test", 9999999999);
    const response = await call(`/${no}/force-delete`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).message, "订单已强制删除");
    assert.equal(db.prepare("SELECT count(*) n FROM payment_refunds WHERE order_id=?").get(no).n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM wechat_oauth_states WHERE order_no=?").get(no).n, 0);
    assert.equal((await call(`/${no}/force-delete`)).status, 404);
  }
  assert.deepEqual(db.prepare("SELECT order_no FROM orders").all().map((row) => row.order_no), ["keep"]);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("single and batch force deletion require an admin session and same-origin request", async (t) => {
  const { db, insert, call } = await fixture(t);
  insert("protected");
  for (const [path, body] of [["/protected/force-delete", undefined], ["/batch", { action: "force-delete", order_nos: ["protected"] }]]) {
    for (const [headers, status] of [[{ cookie: "" }, 401], [{ cookie: "saas_admin_session=forged" }, 401], [{ origin: "https://other.example" }, 403]]) {
      assert.equal((await call(path, "POST", body, headers)).status, status);
    }
  }
  assert.equal(db.prepare("SELECT count(*) n FROM orders").get().n, 1);
});

test("batch force deletion deduplicates selection and reports missing orders without affecting others", async (t) => {
  const { db, insert, call, fetchMock } = await fixture(t);
  insert("pending"); insert("paid", "paid"); insert("keep");
  const normal = await call("/batch", "POST", { action: "delete", order_nos: ["pending", "paid"] });
  assert.equal((await normal.json()).failed, 2);
  const response = await call("/batch", "POST", { action: "force-delete", order_nos: ["pending", "paid", "pending", "missing"] });
  const data = await response.json();
  assert.equal(data.total, 3);
  assert.equal(data.succeeded, 2);
  assert.equal(data.failed, 1);
  assert.equal(data.results.find((row) => row.order_no === "missing").ok, false);
  assert.deepEqual(db.prepare("SELECT order_no FROM orders").all().map((row) => row.order_no), ["keep"]);
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("invalid batch selections and unsupported methods cannot delete orders", async (t) => {
  const { db, insert, call } = await fixture(t);
  insert("keep");
  for (const body of [
    { action: "force-delete", order_nos: [] }, { action: "force-delete", order_nos: ["keep", 42] },
    { action: "force-delete", order_nos: Array.from({ length: 21 }, (_, i) => String(i)) },
    { action: "unknown", order_nos: ["keep"] },
  ]) assert.equal((await call("/batch", "POST", body)).status, 400);
  for (const method of ["GET", "DELETE"]) {
    const response = await call("/keep/force-delete", method);
    assert.ok(response === null || response.status >= 400);
  }
  assert.equal(db.prepare("SELECT count(*) n FROM orders").get().n, 1);
});
