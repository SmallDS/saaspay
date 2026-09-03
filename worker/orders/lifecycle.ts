import { parseOrderMetadata, webhookContactFields } from "../http";
import { channelFor } from "../payment/provider";
import { enqueueBusinessEvent } from "../webhook/outbound";

export type PaymentOrder = {
  id: string;
  order_no: string;
  amount_cents: number;
  status: string;
  product_id: string;
  plan_id: string;
  product_name: string;
  plan_name: string;
  metadata_json: string;
  payment_provider?: string;
  transaction_id?: string | null;
  alipay_trade_no?: string | null;
  buyer_id?: string | null;
  refunded_cents?: number;
  alipay_last_checked_at?: string | null;
};

export function orderProvider(order: PaymentOrder): string {
  return order.payment_provider ?? "alipay";
}

export async function loadPaymentOrder(env: Env, orderNoValue: string): Promise<PaymentOrder | null> {
  return env.DB.prepare("SELECT * FROM orders WHERE order_no=?").bind(orderNoValue).first<PaymentOrder>();
}

export type OrderDeletionResult = {
  order: PaymentOrder | null;
  deleted: boolean;
  message?: string;
};

export async function deletePaymentOrder(env: Env, orderNoValue: string, options: { force?: boolean } = {}): Promise<OrderDeletionResult> {
  const order = await loadPaymentOrder(env, orderNoValue);
  if (!order) return { order: null, deleted: false, message: "订单不存在" };

  const deletable = order.status === "closed"
    || order.status === "refunded"
    || (order.status === "paid" && order.amount_cents === 0 && (order.refunded_cents ?? 0) === 0);
  if (!options.force && !deletable) {
    return { order, deleted: false, message: "订单必须已关闭或已全额退款后才能删除" };
  }

  const result = await env.DB.prepare(
    options.force
      ? "DELETE FROM orders WHERE id=?"
      : "DELETE FROM orders WHERE id=? AND (status='closed' OR status='refunded' OR (status='paid' AND amount_cents=0 AND refunded_cents=0))",
  ).bind(order.id).run();
  if (result.meta.changes !== 1) {
    return { order: await loadPaymentOrder(env, orderNoValue), deleted: false, message: "订单状态已变化，请刷新后重试" };
  }
  return { order, deleted: true, message: options.force ? "订单已强制删除" : "订单已删除" };
}

export async function markOrderPaid(env: Env, order: PaymentOrder, tradeNo: string, buyerId: string | null): Promise<boolean> {
  if (order.status === "paid" || order.status === "refunded") return false;
  const provider = orderProvider(order);
  const result = await env.DB.prepare(
    "UPDATE orders SET status='paid',payment_provider=?,transaction_id=?,alipay_trade_no=CASE WHEN ?='alipay' THEN ? ELSE alipay_trade_no END,buyer_id=COALESCE(?,buyer_id),paid_at=COALESCE(paid_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP WHERE id=? AND status IN ('pending','closed')",
  ).bind(provider, tradeNo, provider, tradeNo, buyerId, order.id).run();
  if (result.meta.changes !== 1) return false;
  const metadata = parseOrderMetadata(order.metadata_json);
  await enqueueBusinessEvent(env, "order.paid", {
    order_no: order.order_no,
    product: { id: order.product_id, name: order.product_name },
    plan: { id: order.plan_id, name: order.plan_name },
    amount_cents: order.amount_cents,
    currency: "CNY",
    payment: { provider, trade_no: tradeNo },
    ...webhookContactFields(metadata),
    metadata,
  }, order.id);
  return true;
}

export async function markOrderClosed(env: Env, order: PaymentOrder): Promise<boolean> {
  const result = await env.DB.prepare(
    "UPDATE orders SET status='closed',closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'",
  ).bind(order.id).run();
  if (result.meta.changes !== 1) return false;
  const metadata = parseOrderMetadata(order.metadata_json);
  await enqueueBusinessEvent(env, "order.closed", {
    order_no: order.order_no,
    product: { id: order.product_id, name: order.product_name },
    plan: { id: order.plan_id, name: order.plan_name },
    amount_cents: order.amount_cents,
    currency: "CNY",
    payment: { provider: orderProvider(order), trade_no: order.transaction_id ?? order.alipay_trade_no ?? "" },
    ...webhookContactFields(metadata),
    metadata,
  }, order.id);
  return true;
}

export type OrderSyncResult = {
  order: PaymentOrder | null;
  changed: boolean;
  provider_ok: boolean;
  trade_status?: string;
  message?: string;
};

export async function syncProviderOrder(env: Env, orderNoValue: string, force = false): Promise<OrderSyncResult> {
  let order = await loadPaymentOrder(env, orderNoValue);
  if (!order) return { order: null, changed: false, provider_ok: false, message: "订单不存在" };
  if (order.amount_cents === 0 || order.status === "refunded" || order.status === "paid") {
    return { order, changed: false, provider_ok: true };
  }
  if (!force) {
    const stale = await env.DB.prepare(
      "SELECT id FROM orders WHERE id=? AND status IN ('pending','closed') AND (alipay_last_checked_at IS NULL OR datetime(alipay_last_checked_at) <= datetime('now','-30 seconds'))",
    ).bind(order.id).first<{ id: string }>();
    if (!stale) return { order, changed: false, provider_ok: true };
  }

  const provider = orderProvider(order);
  const outcome = await channelFor(provider).queryTrade(env, order);
  const tradeNo = outcome.tradeNo || order.transaction_id || order.alipay_trade_no || "";
  const buyerId = outcome.buyerId === undefined ? order.buyer_id ?? null : outcome.buyerId;
  await env.DB.prepare(
    "UPDATE orders SET transaction_id=COALESCE(?,transaction_id),alipay_trade_no=COALESCE(CASE WHEN ?='alipay' THEN ? END,alipay_trade_no),buyer_id=COALESCE(?,buyer_id),alipay_last_checked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?",
  ).bind(tradeNo || null, provider, provider === "alipay" ? tradeNo || null : null, buyerId || null, order.id).run();

  if (!outcome.ok) {
    return {
      order: await loadPaymentOrder(env, orderNoValue),
      changed: false,
      provider_ok: false,
      message: outcome.message || "支付渠道暂未返回交易结果",
    };
  }
  if (outcome.state === "paid") {
    const changed = await markOrderPaid(env, order, tradeNo, buyerId);
    return { order: await loadPaymentOrder(env, orderNoValue), changed, provider_ok: true, trade_status: "TRADE_SUCCESS" };
  }
  if (outcome.state === "closed" && order.status === "pending") {
    const changed = await markOrderClosed(env, order);
    return { order: await loadPaymentOrder(env, orderNoValue), changed, provider_ok: true, trade_status: "TRADE_CLOSED" };
  }
  return { order: await loadPaymentOrder(env, orderNoValue), changed: false, provider_ok: true, trade_status: outcome.state, message: outcome.message };
}

export type CloseOrderResult = {
  order: PaymentOrder | null;
  changed: boolean;
  provider_ok: boolean;
  message?: string;
};

export async function closeProviderOrder(env: Env, orderNoValue: string): Promise<CloseOrderResult> {
  let order = await loadPaymentOrder(env, orderNoValue);
  if (!order) return { order: null, changed: false, provider_ok: false, message: "订单不存在" };
  if (order.status !== "pending") return { order, changed: false, provider_ok: true, message: "订单当前状态不可关闭" };

  await syncProviderOrder(env, orderNoValue, true);
  order = await loadPaymentOrder(env, orderNoValue);
  if (!order || order.status !== "pending") return { order, changed: false, provider_ok: true, message: "订单已由支付渠道查询结果更新" };

  const outcome = await channelFor(orderProvider(order)).closeTrade(env, order);
  if (outcome.paidInstead) {
    const synced = await syncProviderOrder(env, orderNoValue, true);
    return { order: synced.order, changed: synced.changed, provider_ok: synced.provider_ok, message: synced.message || outcome.message || "渠道交易已成功，未关闭订单" };
  }
  if (outcome.closed) {
    const changed = await markOrderClosed(env, order);
    return { order: await loadPaymentOrder(env, orderNoValue), changed, provider_ok: true };
  }
  return { order, changed: false, provider_ok: false, message: outcome.message || "支付渠道未关闭订单" };
}

export async function closeExpiredOrder(env: Env, orderNoValue: string): Promise<boolean> {
  const expired = await env.DB.prepare(
    "SELECT id FROM orders WHERE order_no=? AND status='pending' AND datetime(created_at) <= datetime('now','-30 minutes')",
  ).bind(orderNoValue).first<{ id: string }>();
  if (!expired) return false;
  try {
    const result = await closeProviderOrder(env, orderNoValue);
    return result.changed;
  } catch {
    return false;
  }
}

export async function maybeSyncProviderOrder(env: Env, orderNoValue: string): Promise<void> {
  const pending = await env.DB.prepare(
    "SELECT id FROM orders WHERE order_no=? AND status='pending' AND (alipay_last_checked_at IS NULL OR datetime(alipay_last_checked_at) <= datetime('now','-30 seconds'))",
  ).bind(orderNoValue).first<{ id: string }>();
  if (pending) await syncProviderOrder(env, orderNoValue);
}
