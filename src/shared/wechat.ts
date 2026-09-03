export type WechatPaymentResponse = { mode: "native"; code_url: string };

export function isWechatBrowser(): boolean {
  return /micromessenger/i.test(navigator.userAgent);
}
