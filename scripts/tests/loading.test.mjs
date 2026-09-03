import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import "./register-typescript.mjs";

const { ApiError, readApi } = await import("../../src/shared/api.ts");
const { StorefrontSkeleton, CheckoutSkeleton, ResultSkeleton, DashboardSkeleton, AuthSkeleton } = await import("../../src/shared/LoadingStates.tsx");

function waitForAbort(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

test("a stalled page read times out and cancels its request without retrying", async (t) => {
  let requestSignal;
  const fetchMock = t.mock.method(globalThis, "fetch", (_path, init) => {
    requestSignal = init.signal;
    assert.equal(init.method, undefined);
    return waitForAbort(init.signal);
  });
  await assert.rejects(readApi("/api/public/site", undefined, 10), /加载超时/);
  assert.equal(requestSignal.aborted, true);
  assert.equal(fetchMock.mock.callCount(), 1);
});

test("the timeout covers a stalled response body as well as response headers", async (t) => {
  t.mock.method(globalThis, "fetch", async (_path, init) => ({
    ok: true,
    headers: new Headers({ "content-type": "application/json" }),
    json: () => waitForAbort(init.signal),
  }));
  await assert.rejects(readApi("/api/orders/test", undefined, 10), /加载超时/);
});

test("leaving a page cancels outstanding reads instead of reporting a timeout", async (t) => {
  let requestSignal;
  t.mock.method(globalThis, "fetch", (_path, init) => { requestSignal = init.signal; return waitForAbort(init.signal); });
  const controller = new AbortController();
  const pending = readApi("/api/public/products", controller.signal);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(requestSignal.aborted, true);
  await assert.rejects(readApi("/api/public/products", controller.signal), { name: "AbortError" });
});

test("page reads distinguish missing content from temporary service failures", async (t) => {
  for (const status of [401, 404, 503]) {
    const mock = t.mock.method(globalThis, "fetch", async () => Response.json({ error: "请求暂时失败" }, { status }));
    await assert.rejects(readApi("/api/orders/test"), (error) => error instanceof ApiError && error.status === status && error.message === "请求暂时失败");
    mock.mock.restore();
  }
  t.mock.method(globalThis, "fetch", async () => Response.json({ order: { status: "pending" } }));
  assert.deepEqual(await readApi("/api/orders/test"), { order: { status: "pending" } });
});

test("loading layouts preserve the real H1 and do not expose fake data or interactive controls", () => {
  const storefront = renderToStaticMarkup(createElement(StorefrontSkeleton, { title: "全新的配镜工作台" }));
  assert.match(storefront, /<h1>全新的配镜工作台<\/h1>/);
  assert.equal((storefront.match(/<h1\b/g) ?? []).length, 1);
  for (const Component of [CheckoutSkeleton, ResultSkeleton, DashboardSkeleton, AuthSkeleton]) {
    const html = renderToStaticMarkup(createElement(Component));
    assert.match(html, /aria-busy="true"/);
    assert.match(html, /role="status"/);
    assert.doesNotMatch(html, /暂无数据|支付成功|<button|<input|¥0|￥0/);
  }
});
