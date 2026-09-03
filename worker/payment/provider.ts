import type { PaymentOrder } from "../orders/lifecycle";
import type { PaymentRefund } from "../orders/refunds";
import { alipayChannel } from "./alipay";
import { wechatChannel } from "./wechat";

export type PaymentProviderId = "alipay" | "wechat";

export type ChannelQueryResult = {
  ok: boolean;
  state: "paid" | "closed" | "pending" | "unknown";
  tradeNo?: string;
  buyerId?: string | null;
  message?: string;
};

export type ChannelCloseResult = {
  ok: boolean;
  closed: boolean;
  paidInstead?: boolean;
  message?: string;
};

export type ChannelRefundResult = {
  ok: boolean;
  state: "success" | "processing" | "failed" | "unknown";
  refundNo?: string;
  tradeNo?: string;
  code?: string;
  message?: string;
};

export type PaymentChannel = {
  id: PaymentProviderId;
  queryTrade(env: Env, order: PaymentOrder): Promise<ChannelQueryResult>;
  closeTrade(env: Env, order: PaymentOrder): Promise<ChannelCloseResult>;
  refund(env: Env, order: PaymentOrder, refund: PaymentRefund, amountCents: number, reason: string): Promise<ChannelRefundResult>;
  queryRefund(env: Env, order: PaymentOrder, refund: PaymentRefund): Promise<ChannelRefundResult>;
};

export function providerLabel(provider: string): string {
  if (provider === "wechat") return "微信支付";
  if (provider === "alipay") return "支付宝";
  return provider;
}

export function channelFor(provider: string): PaymentChannel {
  if (provider === "wechat") return wechatChannel;
  if (provider === "alipay") return alipayChannel;
  throw new Error(`不支持的支付渠道：${provider}`);
}
