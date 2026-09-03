export type WechatJsapiParams = {
  appId: string;
  timeStamp: string;
  nonceStr: string;
  package: string;
  signType: "RSA";
  paySign: string;
};

export type WechatPaymentResponse =
  | { mode: "native"; code_url: string }
  | { mode: "redirect"; redirect_url: string }
  | { mode: "jsapi"; pay_params: WechatJsapiParams };

type WeixinBridge = {
  invoke(method: "getBrandWCPayRequest", params: WechatJsapiParams, callback: (result: { err_msg?: string }) => void): void;
};

declare global {
  interface Window { WeixinJSBridge?: WeixinBridge }
}

export function isWechatBrowser(): boolean {
  return /micromessenger/i.test(navigator.userAgent);
}

export async function invokeWechatJsapi(params: WechatJsapiParams): Promise<"submitted" | "cancelled"> {
  if (!isWechatBrowser()) throw new Error("请在微信内打开此页面完成支付");
  const bridge = await new Promise<WeixinBridge>((resolve, reject) => {
    if (window.WeixinJSBridge) { resolve(window.WeixinJSBridge); return; }
    const ready = () => {
      if (!window.WeixinJSBridge) return;
      window.clearTimeout(timer);
      document.removeEventListener("WeixinJSBridgeReady", ready);
      resolve(window.WeixinJSBridge);
    };
    const timer = window.setTimeout(() => {
      document.removeEventListener("WeixinJSBridgeReady", ready);
      reject(new Error("微信支付未准备好，请刷新页面后重试"));
    }, 10000);
    document.addEventListener("WeixinJSBridgeReady", ready);
    ready();
  });
  return new Promise((resolve, reject) => {
    bridge.invoke("getBrandWCPayRequest", params, (result) => {
      if (result.err_msg === "get_brand_wcpay_request:ok") resolve("submitted");
      else if (result.err_msg === "get_brand_wcpay_request:cancel") resolve("cancelled");
      else reject(new Error("微信支付未完成，请点击继续支付重试"));
    });
  });
}
