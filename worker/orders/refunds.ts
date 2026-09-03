import { id, parseOrderMetadata, webhookContactFields } from "../http";
import { channelFor } from "../payment/provider";
import { loadPaymentOrder, orderProvider, syncProviderOrder, type PaymentOrder } from "./lifecycle";
import { enqueueBusinessEvent } from "../webhook/outbound";

export type PaymentRefund = {
  id: string;
  order_id: string;
  order_no: string;
  amount_cents: number;
  reason: string;
  out_request_no: string;
  status: "processing" | "success" | "failed";
  provider?: string;
  alipay_refund_no: string | null;
  alipay_trade_no: string | null;
  response_code: string | null;
  response_message: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

function refundProvider(refund: PaymentRefund): string {
  return refund.provider ?? "alipay";
}

async function loadPaymentRefund(env: Env, refundId: string): Promise<PaymentRefund | null> {
  return env.DB.prepare("SELECT * FROM payment_refunds WHERE id=?").bind(refundId).first<PaymentRefund>();
}

async function reserveRefund(
  env: Env,
  order: PaymentOrder,
  amountCents: number,
  reason: string,
  requestedOutRequestNo?: string,
): Promise<PaymentRefund> {
  const outRequestNo = requestedOutRequestNo?.trim() || `RF${crypto.randomUUID().replace(/-/g, "")}`;
  if (outRequestNo.length > 64 || /[\r\n]/.test(outRequestNo)) throw new Error("退款请求号无效");
  const existing = await env.DB.prepare("SELECT * FROM payment_refunds WHERE out_request_no=?").bind(outRequestNo).first<PaymentRefund>();
  if (existing) {
    if (existing.order_id !== order.id || existing.amount_cents !== amountCents) throw new Error("退款请求号已用于其他退款");
    if (existing.status === "success" || existing.status === "processing") return existing;
    const results = await env.DB.batch([
      env.DB.prepare("UPDATE orders SET refunded_cents=refunded_cents+?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid' AND refunded_cents+? <= amount_cents").bind(amountCents, order.id, amountCents),
      env.DB.prepare("UPDATE payment_refunds SET status='processing',reason=?,response_code=NULL,response_message=NULL,updated_at=CURRENT_TIMESTAMP,completed_at=NULL WHERE id=? AND status='failed'").bind(reason, existing.id),
    ]);
    const reserved = results[0]?.meta.changes === 1;
    const reset = results[1]?.meta.changes === 1;
    if (!reserved || !reset) {
      if (reserved) await env.DB.prepare("UPDATE orders SET refunded_cents=MAX(refunded_cents-?,0),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(amountCents, order.id).run();
      throw new Error("退款金额超过可退金额或订单状态已变化");
    }
    return (await loadPaymentRefund(env, existing.id)) as PaymentRefund;
  }

  const refundId = id("refund");
  const results = await env.DB.batch([
    env.DB.prepare("INSERT INTO payment_refunds(id,order_id,order_no,provider,amount_cents,reason,out_request_no) VALUES(?,?,?,?,?,?,?)")
      .bind(refundId, order.id, order.order_no, orderProvider(order), amountCents, reason, outRequestNo),
    env.DB.prepare("UPDATE orders SET refunded_cents=refunded_cents+?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='paid' AND refunded_cents+? <= amount_cents").bind(amountCents, order.id, amountCents),
  ]);
  if (results[1]?.meta.changes !== 1) {
    await env.DB.prepare("DELETE FROM payment_refunds WHERE id=? AND status='processing'").bind(refundId).run();
    throw new Error("退款金额超过可退金额或订单状态已变化");
  }
  return (await loadPaymentRefund(env, refundId)) as PaymentRefund;
}

type RefundOutcome = {
  refundNo?: string;
  tradeNo?: string;
  code?: string;
  message?: string;
};

async function completeRefund(env: Env, refund: PaymentRefund, outcome: RefundOutcome): Promise<PaymentRefund> {
  const updated = await env.DB.prepare(
    "UPDATE payment_refunds SET status='success',alipay_refund_no=?,alipay_trade_no=?,response_code=?,response_message=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing'",
  ).bind(outcome.refundNo ?? null, outcome.tradeNo ?? null, outcome.code ?? null, outcome.message ?? null, refund.id).run();
  if (updated.meta.changes === 1) {
    await env.DB.prepare("UPDATE orders SET status=CASE WHEN refunded_cents>=amount_cents THEN 'refunded' ELSE 'paid' END,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(refund.order_id).run();
    const order = await loadPaymentOrder(env, refund.order_no);
    if (order) {
      const metadata = parseOrderMetadata(order.metadata_json);
      await enqueueBusinessEvent(env, "order.refunded", {
        order_no: order.order_no,
        product: { id: order.product_id, name: order.product_name },
        plan: { id: order.plan_id, name: order.plan_name },
        amount_cents: order.amount_cents,
        refunded_amount_cents: refund.amount_cents,
        refunded_total_cents: order.refunded_cents ?? refund.amount_cents,
        currency: "CNY",
        payment: {
          provider: orderProvider(order),
          trade_no: order.transaction_id ?? order.alipay_trade_no ?? "",
          refund_no: outcome.refundNo ?? "",
        },
        ...webhookContactFields(metadata),
        metadata,
      }, order.id);
    }
  }
  return (await loadPaymentRefund(env, refund.id)) as PaymentRefund;
}

async function failRefund(env: Env, refund: PaymentRefund, code: string, message: string): Promise<PaymentRefund> {
  const updated = await env.DB.prepare(
    "UPDATE payment_refunds SET status='failed',response_code=?,response_message=?,updated_at=CURRENT_TIMESTAMP,completed_at=CURRENT_TIMESTAMP WHERE id=? AND status='processing'",
  ).bind(code, message, refund.id).run();
  if (updated.meta.changes === 1) {
    await env.DB.prepare("UPDATE orders SET refunded_cents=MAX(refunded_cents-?,0),updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(refund.amount_cents, refund.order_id).run();
  }
  return (await loadPaymentRefund(env, refund.id)) as PaymentRefund;
}

export type RefundActionResult = {
  refund: PaymentRefund;
  pending: boolean;
  message?: string;
};

export async function issueRefund(
  env: Env,
  orderNoValue: string,
  amountCents: number,
  reason: string,
  requestedOutRequestNo?: string,
): Promise<RefundActionResult> {
  let order = await loadPaymentOrder(env, orderNoValue);
  if (!order) throw new Error("订单不存在");
  if (order.status !== "paid") {
    try { await syncProviderOrder(env, orderNoValue, true); } catch { throw new Error("无法确认支付状态，请先查询订单"); }
    order = await loadPaymentOrder(env, orderNoValue);
  }
  if (!order || order.status !== "paid") throw new Error("只有已支付订单可以退款");
  const refund = await reserveRefund(env, order, amountCents, reason, requestedOutRequestNo);
  if (refund.status === "success") return { refund, pending: false, message: "该退款请求已完成" };
  if (refund.status === "processing" && refund.response_code) return { refund, pending: true, message: "退款正在处理中，请稍后查询" };

  try {
    const outcome = await channelFor(refundProvider(refund)).refund(env, order, refund, amountCents, reason);
    if (outcome.state === "success") {
      return { refund: await completeRefund(env, refund, outcome), pending: false, message: "退款已完成" };
    }
    if (outcome.state === "failed") {
      const failed = await failRefund(env, refund, outcome.code ?? "", outcome.message ?? "支付渠道拒绝退款");
      return { refund: failed, pending: false, message: failed.response_message ?? "支付渠道拒绝退款" };
    }
    return { refund, pending: true, message: outcome.message ?? "退款请求结果未知，请稍后查询退款状态" };
  } catch {
    return { refund: (await loadPaymentRefund(env, refund.id)) as PaymentRefund, pending: true, message: "退款请求结果未知，请稍后查询退款状态" };
  }
}

export async function syncRefund(env: Env, refundId: string): Promise<RefundActionResult> {
  const refund = await loadPaymentRefund(env, refundId);
  if (!refund) throw new Error("退款记录不存在");
  if (refund.status === "success") return { refund, pending: false, message: "退款已完成" };
  const order = await loadPaymentOrder(env, refund.order_no);
  if (!order) throw new Error("退款关联订单不存在");
  try {
    const outcome = await channelFor(refundProvider(refund)).queryRefund(env, order, refund);
    if (outcome.state === "success") {
      return { refund: await completeRefund(env, refund, outcome), pending: false, message: "退款已确认" };
    }
    return { refund, pending: true, message: outcome.message ?? "支付渠道暂未确认退款结果" };
  } catch {
    return { refund, pending: true, message: "暂时无法查询退款结果，请稍后重试" };
  }
}

export async function applyWechatRefundNotification(env: Env, outRefundNo: string, refundStatus: string): Promise<void> {
  const refund = await env.DB.prepare(
    "SELECT * FROM payment_refunds WHERE out_request_no=? AND provider='wechat'",
  ).bind(outRefundNo).first<PaymentRefund>();
  if (!refund || refund.status !== "processing") return;
  if (refundStatus === "SUCCESS") {
    await completeRefund(env, refund, { code: "SUCCESS", message: "退款成功" });
  } else if (refundStatus === "CLOSED" || refundStatus === "ABNORMAL") {
    await failRefund(env, refund, refundStatus, refundStatus === "CLOSED" ? "退款已关闭" : "退款异常，请联系微信支付客服处理");
  }
}
