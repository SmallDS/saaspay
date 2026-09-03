import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Form, Input, Modal, Radio, Result, Space, Tag, message } from "antd";
import { Render, type Data } from "@puckeditor/core";
import QRCode from "qrcode";
import { api, ApiError, readApi, money } from "../shared/api";
import { useResource } from "../shared/useResource";
import { CheckoutSkeleton, FooterSkeleton, HeaderSkeleton, ResultSkeleton, SkeletonBar, StorefrontSkeleton } from "../shared/LoadingStates";
import { LoadError } from "../shared/LoadError";
import { getPageHeading } from "../shared/page-heading";
import { canonicalPageUrl, siteImageUrl } from "../shared/site-url";
import { isWechatBrowser, type WechatPaymentResponse } from "../shared/wechat";
import { defaultPageData, pageConfig, type StorefrontAsset, type StorefrontPlan, type StorefrontProduct } from "../editor/config";
import { defaultFooter, defaultHeader, defaultLegal, defaultSeo, defaultTheme, safeSiteHref, type SiteFooterSettings, type SiteHeaderSettings, type SiteLegalSettings, type SiteSeoSettings, type SiteThemeSettings } from "../editor/site";

type Site = { name: string; tagline: string; public_origin: string; theme: SiteThemeSettings; header: SiteHeaderSettings; footer: SiteFooterSettings; seo: SiteSeoSettings; legal: SiteLegalSettings };
type PagePayload = { id: string; title: string; slug: string; seo_title?: string; seo_description?: string; og_image?: string | null; published_json: string };
type Order = { order_no: string; product_name: string; plan_name: string; amount_cents: number; refunded_cents?: number; currency: string; status: "pending" | "paid" | "closed" | "refunded"; payment_provider?: string; paid_at?: string | null };
type CheckoutFormValues = { contact_name?: string; contact_info?: string };
type AlipayPaymentForm = { action: string; fields: Record<string, string> };
type PaymentMethods = { alipay: boolean; wechat: boolean };

const PENDING_WECHAT_ORDER_KEY = "saas_pending_wechat_order";

function submitAlipayPayment(payment: AlipayPaymentForm): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = payment.action;
  form.style.display = "none";
  for (const [name, value] of Object.entries(payment.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = name;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

async function renderWechatQr(codeUrl: string): Promise<string> {
  try {
    return await QRCode.toDataURL(codeUrl, { width: 260, margin: 1 });
  } catch {
    throw new Error("支付二维码生成失败，请点击继续支付重试");
  }
}

const initialSite: Site = { name: "SaaS Store", tagline: "", public_origin: "", theme: defaultTheme, header: defaultHeader, footer: defaultFooter, seo: defaultSeo, legal: defaultLegal };

function mergeSite(incoming: Partial<Site>): Site {
  return {
    name: incoming.name || initialSite.name,
    tagline: incoming.tagline || "",
    public_origin: incoming.public_origin || "",
    theme: { ...defaultTheme, ...(incoming.theme ?? {}) },
    header: { ...defaultHeader, ...(incoming.header ?? {}), links: incoming.header?.links ?? defaultHeader.links },
    footer: { ...defaultFooter, ...(incoming.footer ?? {}), links: incoming.footer?.links ?? defaultFooter.links },
    seo: { ...defaultSeo, ...(incoming.seo ?? {}) },
    legal: { ...defaultLegal, ...(incoming.legal ?? {}) },
  };
}

export function PublicApp({ initialPageHeading = "" }: { initialPageHeading?: string }) {
  if (location.pathname === "/checkout") return <CheckoutPage />;
  if (location.pathname === "/payment/result") return <PaymentResult />;
  return <Storefront initialPageHeading={initialPageHeading} />;
}

function Storefront({ initialPageHeading }: { initialPageHeading: string }) {
  const [assets, setAssets] = useState<StorefrontAsset[]>([]);

  const slug = useMemo(() => {
    const value = location.pathname.replace(/^\/+|\/+$/g, "");
    return value || "home";
  }, []);

  const loader = useCallback(async (signal: AbortSignal) => {
    const [siteData, catalog, pageData] = await Promise.all([
      readApi<{ site: Partial<Site> }>("/api/public/site", signal),
      readApi<{ products: StorefrontProduct[]; plans: StorefrontPlan[] }>("/api/public/products", signal),
      readApi<{ page: PagePayload | null }>(`/api/public/pages/${encodeURIComponent(slug)}`, signal).catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 404) return { page: null };
        throw error;
      }),
    ]);
    return { site: mergeSite(siteData.site), products: catalog.products ?? [], plans: catalog.plans ?? [], page: pageData.page };
  }, [slug]);
  const resource = useResource(loader);
  const { loading } = resource;
  const site = resource.data?.site ?? initialSite;
  const products = resource.data?.products ?? [];
  const plans = resource.data?.plans ?? [];
  const page = resource.data?.page ?? null;

  // Asset metadata enhances image blocks but must not hold up the entire page.
  useEffect(() => {
    const controller = new AbortController();
    void readApi<{ assets: StorefrontAsset[] }>("/api/public/assets", controller.signal)
      .then((result) => { if (!controller.signal.aborted) setAssets(result.assets ?? []); }).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const entries: Record<string, string> = {
      "--brand-primary": site.theme.primary_color,
      "--brand-accent": site.theme.accent_color,
      "--surface": site.theme.surface_color,
      "--page-background": site.theme.page_background,
      "--text-color": site.theme.text_color,
      "--muted-color": site.theme.muted_color,
      "--font-family": site.theme.font_family,
      "--radius": site.theme.radius,
      "--container-width": site.theme.container_width,
      "--section-spacing": site.theme.section_spacing,
      "--header-height": site.theme.header_height,
    };
    Object.entries(entries).forEach(([key, value]) => root.style.setProperty(key, value));
  }, [site.theme]);

  useEffect(() => {
    if (loading || resource.error) return;
    const origin = site.public_origin || location.origin;
    const title = page?.seo_title || page?.title || site.name;
    const description = page?.seo_description || site.tagline;
    document.title = title;
    setMeta("description", description);
    setMeta("og:title", title, "property");
    setMeta("og:description", description, "property");
    const ogImage = siteImageUrl(page?.og_image || site.seo.default_og_image, origin);
    if (ogImage) setMeta("og:image", ogImage, "property");
    const canonical = canonicalPageUrl(origin, location.pathname);
    setMeta("og:url", canonical, "property");
    let link = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "canonical";
      document.head.appendChild(link);
    }
    link.href = canonical;
  }, [page, site, slug, loading, resource.error]);

  function buy(planId: string) {
    location.href = "/checkout?plan_id=" + encodeURIComponent(planId);
  }

  if (loading && !resource.data) return <StorefrontSkeleton title={initialPageHeading} />;
  if (resource.error && !resource.data) return <div className="public-site">{initialPageHeading ? <section className="block hero-block"><div className="container"><h1>{initialPageHeading}</h1></div></section> : null}<LoadError message={resource.error} onRetry={resource.retry} /></div>;

  let data: Data = defaultPageData;
  if (page) {
    data = { root: { props: {} }, content: [] };
    try {
      const published = JSON.parse(page.published_json) as Data | null;
      if (published && Array.isArray(published.content)) data = published;
    } catch { /* 已发布内容损坏时仍展示该页面标题。 */ }
  }

  return (
    <div className="public-site">
      <GlobalHeader site={site} />
      {slug !== "home" && !page ? <Result status="404" title="页面不存在" subTitle="这个页面尚未发布。" extra={<Button type="primary" href="/">返回首页</Button>} /> : <Render config={pageConfig} data={data} metadata={{ products, plans, assets, onBuy: buy, pageHeading: getPageHeading(data, page?.title || site.name) }} />}
      <GlobalFooter site={site} />
    </div>
  );
}

function contactType(value: string): "phone" | "email" | null {
  if (/^1[3-9]\d{9}$/.test(value)) return "phone";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
  return null;
}

function CheckoutPage() {
  const planId = useMemo(() => new URLSearchParams(location.search).get("plan_id") ?? "", []);
  const [submitting, setSubmitting] = useState(false);
  const [payMethod, setPayMethod] = useState<"alipay" | "wechat">("alipay");
  const [wechatPay, setWechatPay] = useState<{ orderNo: string; qrImage: string } | null>(null);
  const [pendingWechatOrder, setPendingWechatOrder] = useState(() => sessionStorage.getItem(PENDING_WECHAT_ORDER_KEY) ?? "");
  const [form] = Form.useForm<CheckoutFormValues>();

  const loader = useCallback(async (signal: AbortSignal) => {
    const [siteData, catalog, methodData] = await Promise.all([
      readApi<{ site: Partial<Site> }>("/api/public/site", signal),
      readApi<{ plans: StorefrontPlan[] }>("/api/public/products", signal),
      readApi<{ methods: PaymentMethods }>("/api/public/payment-methods", signal),
    ]);
    return { site: mergeSite(siteData.site), plan: (catalog.plans ?? []).find((item) => item.id === planId) ?? null, methods: methodData.methods };
  }, [planId]);
  const resource = useResource(loader);
  const { loading } = resource;
  const site = resource.data?.site ?? initialSite;
  const plan = resource.data?.plan ?? null;
  const methods = resource.data?.methods ?? { alipay: false, wechat: false };
  useEffect(() => {
    const available = resource.data?.methods;
    if (available?.wechat && (!available.alipay || isWechatBrowser())) setPayMethod("wechat");
  }, [resource.data]);

  useEffect(() => {
    const root = document.documentElement;
    const entries: Record<string, string> = {
      "--brand-primary": site.theme.primary_color,
      "--brand-accent": site.theme.accent_color,
      "--surface": site.theme.surface_color,
      "--page-background": site.theme.page_background,
      "--text-color": site.theme.text_color,
      "--muted-color": site.theme.muted_color,
      "--font-family": site.theme.font_family,
      "--radius": site.theme.radius,
      "--container-width": site.theme.container_width,
      "--section-spacing": site.theme.section_spacing,
      "--header-height": site.theme.header_height,
    };
    Object.entries(entries).forEach(([key, value]) => root.style.setProperty(key, value));
  }, [site.theme]);

  useEffect(() => {
    const orderNoValue = wechatPay?.orderNo;
    if (!orderNoValue) return;
    const controller = new AbortController();
    let cancelled = false;
    let timer: number | undefined;
    const poll = async (): Promise<void> => {
      try {
        const result = await readApi<{ order: { status: string } }>("/api/orders/" + encodeURIComponent(orderNoValue), controller.signal);
        if (cancelled) return;
        if (result.order.status === "paid" || result.order.status === "refunded") {
          location.href = "/payment/result?order_no=" + encodeURIComponent(orderNoValue);
          return;
        }
        if (result.order.status === "closed") {
          message.warning("订单已关闭，请重新下单");
          setWechatPay(null);
          return;
        }
      } catch { /* 轮询失败时继续重试 */ }
      if (!cancelled) timer = window.setTimeout(poll, 3000);
    };
    void poll();
    return () => { cancelled = true; controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [wechatPay]);

  async function submitCheckout(values: CheckoutFormValues) {
    if (!plan) return;
    const contactInfo = values.contact_info?.trim() ?? "";
    const type = contactType(contactInfo);
    if (!type) {
      message.error("联系方式必须是手机号或邮箱");
      return;
    }
    setSubmitting(true);
    const requestId = crypto.randomUUID();
    try {
      const created = await api<{ order: { order_no: string; status: string } }>("/api/orders", {
        method: "POST",
        headers: { "Idempotency-Key": requestId },
        body: JSON.stringify({
          plan_id: plan.id,
          request_id: requestId,
          contact_name: values.contact_name?.trim() ?? "",
          contact_info: contactInfo,
          metadata: { source: "checkout", contact_type: type },
        }),
      });
      sessionStorage.removeItem(PENDING_WECHAT_ORDER_KEY);
      if (created.order.status === "paid") {
        location.href = "/payment/result?order_no=" + encodeURIComponent(created.order.order_no);
        return;
      }
      if (payMethod === "wechat") {
        sessionStorage.setItem(PENDING_WECHAT_ORDER_KEY, created.order.order_no);
        setPendingWechatOrder(created.order.order_no);
        const payment = await api<WechatPaymentResponse>("/api/payment/wechat/create", {
          method: "POST",
          body: JSON.stringify({ order_no: created.order.order_no }),
        });
        if (payment.mode === "native" && payment.code_url) {
          setWechatPay({ orderNo: created.order.order_no, qrImage: await renderWechatQr(payment.code_url) });
          return;
        }
        message.error("微信支付下单失败");
        return;
      }
      const payment = await api<{ payment_form: AlipayPaymentForm }>("/api/payment/alipay/create", {
        method: "POST",
        body: JSON.stringify({ order_no: created.order.order_no }),
      });
      submitAlipayPayment(payment.payment_form);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建支付失败");
    } finally {
      setSubmitting(false);
    }
  }

  const content = loading && !resource.data ? <CheckoutSkeleton /> : resource.error && !resource.data ? <LoadError message={resource.error} onRetry={resource.retry} /> : !plan ? (
    <Result status="404" title="套餐不存在或已下架" subTitle="请返回商品页重新选择套餐。" extra={<Button type="primary" href="/">返回首页</Button>} />
  ) : wechatPay ? (
    <div className="wechat-pay-panel">
      <h2>微信扫码支付</h2>
      <p>{plan.product_name} · {plan.name} · {money(plan.amount_cents)}</p>
      <p className="muted">订单号：{wechatPay.orderNo}</p>
      <img src={wechatPay.qrImage} alt="微信支付二维码" />
      <p>请使用微信扫一扫完成支付，支付成功后页面会自动跳转。</p>
      <Button onClick={() => setWechatPay(null)}>返回重新选择支付方式</Button>
    </div>
  ) : (
    <main className="checkout-shell">
      <div className="container checkout-layout">
        <Card className="checkout-card">
          <div className="checkout-heading">
            <div className="eyebrow">Checkout</div>
            <h1>填写购买信息</h1>
            <p>请留下联系方式，支付完成后我们会据此联系你。</p>
          </div>
          {pendingWechatOrder ? (
            <Alert
              type="info"
              showIcon
              closable
              style={{ marginBottom: 16 }}
              message="你有进行中的微信支付订单"
              action={<Button size="small" type="primary" href={"/payment/result?order_no=" + encodeURIComponent(pendingWechatOrder) + "&pay=wechat"}>继续支付 / 查看结果</Button>}
              onClose={() => { sessionStorage.removeItem(PENDING_WECHAT_ORDER_KEY); setPendingWechatOrder(""); }}
            />
          ) : null}
          <div className="checkout-summary">
            <div>
              <div className="muted">{plan.product_name}</div>
              <h2>{plan.name}</h2>
              <p className="muted">{plan.description || "购买后即可开始使用。"}</p>
            </div>
            <div className="checkout-price">
              <strong>{money(plan.amount_cents)}</strong>
              <span>{plan.billing_label}</span>
            </div>
          </div>
          <Form form={form} layout="vertical" onFinish={(values) => void submitCheckout(values)} requiredMark="optional">
            <Form.Item name="contact_name" label="联系人">
              <Input maxLength={100} placeholder="可选" />
            </Form.Item>
            <Form.Item
              name="contact_info"
              label="联系方式"
              extra="支持中国大陆手机号或邮箱地址"
              rules={[
                { required: true, message: "请输入手机号或邮箱" },
                {
                  validator: (_, value) => contactType(typeof value === "string" ? value.trim() : "") ? Promise.resolve() : Promise.reject(new Error("联系方式必须是手机号或邮箱")),
                },
              ]}
            >
              <Input maxLength={254} placeholder="请输入手机号或邮箱" />
            </Form.Item>
            <Form.Item label="支付方式" extra={!methods.alipay && !methods.wechat ? "商家暂未开通在线支付" : payMethod === "wechat" ? "将显示支付二维码，请使用微信扫一扫完成支付" : undefined}>
              {methods.alipay || methods.wechat ? (
                <Radio.Group value={payMethod} onChange={(event) => setPayMethod(event.target.value)}>
                  {methods.alipay ? <Radio value="alipay">支付宝</Radio> : null}
                  {methods.wechat ? <Radio value="wechat">微信扫码支付</Radio> : null}
                </Radio.Group>
              ) : <span className="muted">商家暂未开通在线支付</span>}
            </Form.Item>
            <div className="checkout-actions">
              <Button type="primary" htmlType="submit" size="large" loading={submitting} block>确认并前往支付</Button>
              <Button href="/" size="large" block>返回商品页</Button>
            </div>
          </Form>
        </Card>
      </div>
    </main>
  );

  return <div className="public-site">{resource.data ? <GlobalHeader site={site} /> : <HeaderSkeleton />}{content}{resource.data ? <GlobalFooter site={site} /> : <FooterSkeleton />}</div>;
}

function GlobalHeader({ site }: { site: Site }) {
  if (!site.header.enabled) return null;
  return <header className="site-header"><a className="site-logo" href="/">{site.name}</a>{site.header.show_nav ? <nav>{site.header.links.map((link) => <a key={`${link.label}-${link.href}`} href={safeSiteHref(link.href)}>{link.label}</a>)}{site.header.cta_text && site.header.cta_href ? <Button type="primary" size="small" href={safeSiteHref(site.header.cta_href)}>{site.header.cta_text}</Button> : null}</nav> : null}</header>;
}

function GlobalFooter({ site }: { site: Site }) {
  if (!site.footer.enabled) return null;
  return <footer className="site-footer">
    <div>
      <strong>{site.name}</strong>
      {site.footer.tagline || site.tagline ? <span>{site.footer.tagline || site.tagline}</span> : null}
      {site.legal.copyright ? <span>{site.legal.copyright}</span> : null}
      {site.legal.icp_no ? <span><a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer nofollow">{site.legal.icp_no}</a></span> : null}
    </div>
    {site.footer.links.length ? <nav>{site.footer.links.map((link) => <a key={`${link.label}-${link.href}`} href={safeSiteHref(link.href)}>{link.label}</a>)}</nav> : null}
  </footer>;
}

function PaymentResult() {
  const orderNo = new URLSearchParams(location.search).get("order_no") ?? "";
  const payParam = useMemo(() => new URLSearchParams(location.search).get("pay") ?? "", []);
  const [wechatNotice, setWechatNotice] = useState("");
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [refreshToken, setRefreshToken] = useState(0);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  // 旧版支付结果链接仍可继续同一订单，但统一显示 Native 二维码。
  const provider = ["wechat", "wxjsapi"].includes(payParam) ? "wechat" : order?.payment_provider ?? "alipay";

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let timer: number | undefined;
    async function poll() {
      if (!orderNo) { if (!cancelled) setLoading(false); return; }
      try {
        const result = await readApi<{ order: Order }>("/api/orders/" + encodeURIComponent(orderNo), controller.signal);
        if (cancelled) return;
        setOrder(result.order);
        setLoadError("");
        setLoading(false);
        setRefreshing(false);
        if (result.order.status === "pending") timer = window.setTimeout(poll, 3000);
      } catch (error) {
        if (cancelled) return;
        setLoading(false);
        setRefreshing(false);
        if (error instanceof ApiError && error.status === 404) {
          setOrder(null);
          setLoadError("");
        } else {
          setLoadError(error instanceof Error ? error.message : "订单状态暂时无法同步");
          timer = window.setTimeout(poll, 5000);
        }
      }
    }
    void poll();
    return () => { cancelled = true; controller.abort(); if (timer !== undefined) window.clearTimeout(timer); };
  }, [orderNo, refreshToken]);

  useEffect(() => {
    if (!order) return;
    if (["paid", "closed", "refunded"].includes(order.status)) sessionStorage.removeItem(PENDING_WECHAT_ORDER_KEY);
    if (order.status !== "pending") setQrOpen(false);
  }, [order]);

  async function openWechatPayment() {
    if (!orderNo) return;
    setRetrying(true);
    setWechatNotice("");
    sessionStorage.setItem(PENDING_WECHAT_ORDER_KEY, orderNo);
    try {
      const payment = await api<WechatPaymentResponse>("/api/payment/wechat/create", { method: "POST", body: JSON.stringify({ order_no: orderNo }) });
      if (payment.mode === "native" && payment.code_url) {
        setQrImage(await renderWechatQr(payment.code_url));
        setQrOpen(true);
        return;
      }
      throw new Error("微信支付下单失败，请重试");
    } catch (error) {
      setWechatNotice(error instanceof Error ? error.message : "创建支付失败");
    } finally {
      setRetrying(false);
    }
  }

  async function continuePayment() {
    if (!orderNo) return;
    if (provider === "wechat") {
      await openWechatPayment();
      return;
    }
    setRetrying(true);
    try {
      const payment = await api<{ payment_form: AlipayPaymentForm }>("/api/payment/alipay/create", { method: "POST", body: JSON.stringify({ order_no: orderNo }) });
      submitAlipayPayment(payment.payment_form);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建支付失败");
    } finally { setRetrying(false); }
  }
  function refresh() { setRefreshing(true); setRefreshToken((value) => value + 1); }

  if (loading || (refreshing && !order)) return <ResultSkeleton />;
  if (!order && loadError) return <LoadError message={loadError} onRetry={refresh} />;
  if (!orderNo || !order) return <Result status="404" title="未找到订单" extra={<Button href="/">返回首页</Button>} />;
  if (order.status === "paid" && (order.refunded_cents ?? 0) > 0) return <Result status="info" title="订单已部分退款" subTitle={order.product_name + " · 已退款 " + money(order.refunded_cents ?? 0)} extra={<Button type="primary" href="/">返回首页</Button>} />;
  if (order.status === "paid") return <Result status="success" title="支付成功" subTitle={order.product_name + " · " + order.plan_name + " · " + money(order.amount_cents)} extra={<Button type="primary" href="/">返回首页</Button>} />;
  if (order.status === "refunded") return <Result status="info" title="订单已退款" subTitle={order.order_no} extra={<Button href="/">返回首页</Button>} />;
  if (order.status === "closed") return <Result status="warning" title="订单已关闭" subTitle="支付超时或订单已取消，请重新下单。" extra={<Button type="primary" href="/">返回首页</Button>} />;
  return <>
    {loadError ? <Alert type="warning" showIcon message="订单状态暂时无法同步，正在重试" description={loadError} style={{ maxWidth: 640, margin: "24px auto 0" }} /> : null}
    {wechatNotice ? <Alert type="warning" showIcon message={wechatNotice} style={{ maxWidth: 640, margin: "24px auto 0" }} /> : null}
    <Result
      status="info"
      title="等待支付结果"
      subTitle={provider === "wechat" ? "完成支付后页面会自动更新；点击继续支付可显示微信支付二维码。" : "完成支付后页面会自动更新；如果尚未支付，可以继续打开支付宝收银台。"}
      extra={<Space wrap><Tag>{order.order_no}</Tag><Button type="primary" loading={retrying} onClick={() => void continuePayment()}>继续支付</Button><Button loading={refreshing} onClick={refresh}>刷新</Button><Button href="/">返回首页</Button></Space>}
    />
    <WechatQrModal open={qrOpen} qrImage={qrImage} onClose={() => setQrOpen(false)} />
  </>;
}

function WechatQrModal({ open, qrImage, onClose }: { open: boolean; qrImage: string | null; onClose: () => void }) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} title="微信扫码支付" width={360}>
      <div className="wechat-pay-panel">
        {qrImage ? <img src={qrImage} alt="微信支付二维码" /> : <SkeletonBar width={248} height={248} />}
        <p>请使用微信扫一扫完成支付，支付成功后页面会自动更新。</p>
      </div>
    </Modal>
  );
}

function setMeta(name: string, content: string, attribute: "name" | "property" = "name") {
  if (!content) return;
  let element = document.querySelector(`meta[${attribute}="${name}"]`) as HTMLMetaElement | null;
  if (!element) {
    element = document.createElement("meta");
    element.setAttribute(attribute, name);
    document.head.appendChild(element);
  }
  element.content = content;
}
