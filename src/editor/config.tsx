import { useEffect, useState } from "react";
import type { Config, Data } from "@puckeditor/core";
import { Button, Card, Empty, Tag } from "antd";
import { money } from "../shared/api";

export type StorefrontPlan = {
  id: string;
  product_id: string;
  product_name: string;
  name: string;
  description: string;
  amount_cents: number;
  original_amount_cents?: number | null;
  billing_label: string;
  highlighted: number;
};

export type StorefrontProduct = {
  id: string;
  name: string;
  slug: string;
  summary: string;
  description: string;
  cover_url?: string | null;
};

export type StorefrontAsset = {
  id: string;
  filename: string;
  mime_type?: string;
  public_url: string;
};

export type StorefrontMetadata = {
  plans?: StorefrontPlan[];
  products?: StorefrontProduct[];
  assets?: StorefrontAsset[];
  buyingPlanId?: string | null;
  onBuy?: (planId: string) => void | Promise<void>;
};

type PipeItem = { left: string; middle: string; right: string };

export type PageProps = {
  Hero: { eyebrow: string; title: string; description: string; buttonText: string; buttonHref: string; layout: "center" | "split"; image_url: string; image_alt: string };
  Text: { title: string; content: string; align: "left" | "center"; eyebrow: string };
  Notice: { text: string; tone: "info" | "success" | "warning" };
  Features: { title: string; items: string; columns: "2" | "3" | "4" };
  IconList: { title: string; items: string };
  Steps: { title: string; items: string; columns: "2" | "3" | "4" };
  Timeline: { title: string; items: string };
  Team: { title: string; items: string; columns: "2" | "3" | "4" };
  Gallery: { title: string; items: string; columns: "2" | "3" | "4" };
  Embed: { src: string; height: string; caption: string };
  Countdown: { title: string; description: string; end_time: string; note: string };
  Pricing: { title: string; description: string };
  ProductGrid: { title: string; description: string; product_slug: string };
  FAQ: { title: string; items: string };
  Testimonials: { title: string; items: string };
  Stats: { title: string; items: string };
  LogoCloud: { title: string; items: string };
  Video: { title: string; description: string; video_url: string; poster_url: string };
  Comparison: { title: string; basic_label: string; pro_label: string; items: string };
  Image: { asset_id: string; image_url: string; image_alt: string; caption: string; object_fit: "cover" | "contain" };
  Divider: { label: string };
  Spacer: { height: "small" | "medium" | "large" };
  Contact: { title: string; description: string; buttonText: string; email: string };
  CTA: { title: string; description: string; buttonText: string; buttonHref: string };
};

function nonEmptyLines(value: string): string[] {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}
function pipeItems(value: string, count: 2 | 3): PipeItem[] {
  return nonEmptyLines(value).map((line) => {
    const parts = line.split("|").map((part) => part.trim());
    return { left: parts[0] ?? "", middle: parts[1] ?? "", right: count === 3 ? parts[2] ?? "" : "" };
  }).filter((item) => item.left && item.middle);
}
function safeHref(value: unknown): string {
  const href = typeof value === "string" ? value.trim() : "";
  return /^(?:#|\/(?!\/)|https:\/\/|mailto:)/i.test(href) ? href : "#";
}
function getAssets(metadata: unknown): StorefrontAsset[] {
  const value = metadata as { assets?: StorefrontAsset[] } | undefined;
  return Array.isArray(value?.assets) ? value.assets : [];
}
function assetOptions(metadata: unknown) {
  return [
    { label: "不绑定素材库（使用 URL）", value: "" },
    ...getAssets(metadata).filter((asset) => asset.mime_type?.startsWith("image/") !== false).map((asset) => ({ label: asset.filename, value: asset.id })),
  ];
}
function parseBeijingTime(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) return Number.NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}[ T]/.test(trimmed) && !/[+zZ]|T\d{2}:\d{2}:\d{2}\./.test(trimmed.slice(10))
    ? trimmed.replace(" ", "T") + "+08:00"
    : trimmed);
}
function CountdownTimer({ end_time }: { end_time: string }) {
  const [remaining, setRemaining] = useState<number | null>(() => {
    const target = parseBeijingTime(end_time);
    return Number.isFinite(target) ? Math.max(0, target - Date.now()) : null;
  });
  useEffect(() => {
    const target = parseBeijingTime(end_time);
    if (!Number.isFinite(target)) { setRemaining(null); return; }
    const tick = () => setRemaining(Math.max(0, target - Date.now()));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [end_time]);
  if (remaining === null) return <div className="countdown-timer muted">请填写有效的结束时间（例如 2026-12-31 23:59:59）</div>;
  if (remaining === 0) return <div className="countdown-timer muted">活动已结束</div>;
  const days = Math.floor(remaining / 86400000);
  const hours = Math.floor((remaining % 86400000) / 3600000);
  const minutes = Math.floor((remaining % 3600000) / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);
  const cell = (value: number, label: string) => (
    <div className="countdown-cell"><strong>{String(value).padStart(2, "0")}</strong><span>{label}</span></div>
  );
  return <div className="countdown-timer">
    {days > 0 ? cell(days, "天") : null}
    {cell(hours, "时")}{cell(minutes, "分")}{cell(seconds, "秒")}
  </div>;
}

function BuyButton({ plan, metadata }: { plan: StorefrontPlan; metadata: StorefrontMetadata }) {
  return metadata.onBuy ? (
    <Button type={plan.highlighted ? "primary" : "default"} size="large" block loading={metadata.buyingPlanId === plan.id} disabled={Boolean(metadata.buyingPlanId)} onClick={() => void metadata.onBuy?.(plan.id)}>
      立即购买
    </Button>
  ) : <Button block disabled>预览模式</Button>;
}

export const pageConfig: Config<PageProps> = {
  categories: {
    基础: { title: "基础", components: ["Hero", "Text", "Notice", "Image", "Gallery", "Divider", "Spacer"] },
    营销: { title: "营销", components: ["Features", "IconList", "Steps", "Timeline", "Team", "Stats", "LogoCloud", "Testimonials", "FAQ", "Video", "Embed", "CTA", "Contact"] },
    商业: { title: "商业", components: ["Pricing", "ProductGrid", "Comparison", "Countdown"] },
  },
  components: {
    Hero: {
      fields: {
        eyebrow: { type: "text", label: "眉标题" },
        title: { type: "text", label: "标题" },
        description: { type: "textarea", label: "描述" },
        buttonText: { type: "text", label: "按钮文字" },
        buttonHref: { type: "text", label: "按钮链接" },
        layout: { type: "select", label: "布局", options: [{ label: "居中", value: "center" }, { label: "左右分栏", value: "split" }] },
        image_url: { type: "text", label: "右侧图片 URL" },
        image_alt: { type: "text", label: "图片替代文字" },
      },
      defaultProps: { eyebrow: "SAAS 产品", title: "让你的产品更容易被购买", description: "展示产品、配置套餐并通过支付宝、微信支付完成收款。", buttonText: "查看套餐", buttonHref: "#pricing", layout: "center", image_url: "", image_alt: "" },
      render: ({ eyebrow, title, description, buttonText, buttonHref = "#pricing", layout, image_url, image_alt }) => (
        <section className={`block hero-block ${layout === "split" ? "hero-split" : ""}`}>
          <div className="container hero-inner">
            <div className="hero-copy">
              {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
              <h1>{title}</h1>
              <p>{description}</p>
              {buttonText ? <Button type="primary" size="large" href={safeHref(buttonHref)}>{buttonText}</Button> : null}
            </div>
            {layout === "split" && image_url ? <div className="hero-media"><img src={image_url} alt={image_alt || ""} /></div> : null}
          </div>
        </section>
      ),
    },
    Text: {
      fields: {
        eyebrow: { type: "text", label: "眉标题" },
        title: { type: "text", label: "标题" },
        content: { type: "textarea", label: "正文" },
        align: { type: "select", label: "对齐", options: [{ label: "左对齐", value: "left" }, { label: "居中", value: "center" }] },
      },
      defaultProps: { eyebrow: "", title: "产品介绍", content: "在这里填写你的产品介绍，说清楚能为客户解决什么问题。", align: "left" },
      render: ({ title, content, align, eyebrow }) => <section className="block"><div className="container" style={{ textAlign: align }}>{eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}<h2>{title}</h2><p className="prose">{content}</p></div></section>,
    },
    Notice: {
      fields: {
        text: { type: "textarea", label: "公告内容" },
        tone: { type: "select", label: "样式", options: [{ label: "信息", value: "info" }, { label: "成功", value: "success" }, { label: "警示", value: "warning" }] },
      },
      defaultProps: { text: "公告：新用户注册即享 7 天免费试用，活动截止本月底。", tone: "info" },
      render: ({ text, tone }) => <div className="container"><div className={`notice-block notice-${tone}`}>{text}</div></div>,
    },
    Features: {
      fields: {
        title: { type: "text", label: "标题" },
        items: { type: "textarea", label: "功能（每行一个）" },
        columns: { type: "select", label: "列数", options: [{ label: "两列", value: "2" }, { label: "三列", value: "3" }, { label: "四列", value: "4" }] },
      },
      defaultProps: { title: "产品能力", items: "快速部署\n可视化页面编辑\n支付宝、微信支付\n支付成功自动通知业务系统", columns: "4" },
      render: ({ title, items, columns }) => <section className="block alt"><div className="container"><h2>{title}</h2><div className={`feature-grid columns-${columns || "4"}`}>{nonEmptyLines(items).map((item) => <div className="feature-card" key={item}>{item}</div>)}</div></div></section>,
    },
    IconList: {
      fields: {
        title: { type: "text", label: "标题" },
        items: { type: "textarea", label: "要点（图标|标题|描述，每行一个）" },
      },
      defaultProps: {
        title: "为什么选择我们",
        items: "🚀|开箱即用|无需服务器和运维，部署完成即可对外销售。\n🔒|安全可靠|支付回调严格验签，敏感配置加密存储。\n📈|数据联动|订单实时推送到你的业务系统。\n🧩|灵活扩展|可视化页面编辑，随时调整营销内容。",
      },
      render: ({ title, items }) => <section className="block"><div className="container"><h2>{title}</h2><div className="icon-list">{pipeItems(items, 3).map((item) => <div className="icon-list-item" key={item.left}><span className="icon-list-icon">{item.left}</span><div><strong>{item.middle}</strong><p className="muted">{item.right}</p></div></div>)}</div></div></section>,
    },
    Steps: {
      fields: {
        title: { type: "text", label: "标题" },
        items: { type: "textarea", label: "步骤（标题|描述，每行一个）" },
        columns: { type: "select", label: "列数", options: [{ label: "两列", value: "2" }, { label: "三列", value: "3" }, { label: "四列", value: "4" }] },
      },
      defaultProps: {
        title: "三步开始使用",
        items: "选择套餐|根据团队规模选择合适的套餐。\n在线支付|支持支付宝与微信支付，支付后立即生效。\n开始使用|我们会通过你留下的联系方式完成交付。",
        columns: "3",
      },
      render: ({ title, items, columns }) => <section className="block alt"><div className="container"><h2>{title}</h2><div className={`steps-grid columns-${columns || "3"}`}>{pipeItems(items, 2).map((item, index) => <div className="step-card" key={item.left}><span className="step-number">{index + 1}</span><strong>{item.left}</strong><p className="muted">{item.middle}</p></div>)}</div></div></section>,
    },
    Timeline: {
      fields: {
        title: { type: "text", label: "标题" },
        items: { type: "textarea", label: "节点（时间|标题|描述，每行一个）" },
      },
      defaultProps: {
        title: "发展历程",
        items: "2024|产品立项|确定以 Cloudflare 为基础的轻量交付方案。\n2025|正式上线|首批客户完成接入并稳定运行。\n2026|持续迭代|新增微信支付与可视化页面编辑能力。",
      },
      render: ({ title, items }) => <section className="block"><div className="container narrow"><h2>{title}</h2><div className="timeline-list">{pipeItems(items, 3).map((item) => <div className="timeline-item" key={item.left + item.middle}><span className="timeline-date">{item.left}</span><div className="timeline-body"><strong>{item.middle}</strong><p className="muted">{item.right}</p></div></div>)}</div></div></section>,
    },
    Team: {
      fields: {
        title: { type: "text", label: "标题" },
        items: { type: "textarea", label: "成员（姓名|职位|头像 URL，每行一个）" },
        columns: { type: "select", label: "列数", options: [{ label: "两列", value: "2" }, { label: "三列", value: "3" }, { label: "四列", value: "4" }] },
      },
      defaultProps: {
        title: "核心团队",
        items: "林晓|产品负责人\n周然|技术负责人\n陈默|客户成功",
        columns: "3",
      },
      render: ({ title, items, columns }) => <section className="block alt"><div className="container"><h2>{title}</h2><div className={`team-grid columns-${columns || "3"}`}>{pipeItems(items, 3).map((item) => <Card className="team-card" key={item.left}>{item.right ? <img className="team-avatar" src={item.right} alt={item.left} /> : <span className="team-avatar team-avatar-text">{item.left.slice(0, 1)}</span>}<strong>{item.left}</strong><span className="muted">{item.middle}</span></Card>)}</div></div></section>,
    },
    Gallery: {
      fields: {
        title: { type: "text", label: "标题" },
        items: { type: "textarea", label: "图片（URL|说明，每行一个）" },
        columns: { type: "select", label: "列数", options: [{ label: "两列", value: "2" }, { label: "三列", value: "3" }, { label: "四列", value: "4" }] },
      },
      defaultProps: { title: "产品图集", items: "", columns: "3" },
      render: ({ title, items, columns }) => <section className="block"><div className="container"><h2>{title}</h2>{nonEmptyLines(items).length === 0 ? <div className="image-placeholder">请在右侧填写图片 URL 和说明</div> : <div className={`gallery-grid columns-${columns || "3"}`}>{nonEmptyLines(items).map((line) => { const [url, caption] = line.split("|").map((part) => part.trim()); return url ? <figure className="gallery-item" key={line}><img src={url} alt={caption || "产品图片"} />{caption ? <figcaption>{caption}</figcaption> : null}</figure> : null; })}</div>}</div></section>,
    },
    Embed: {
      fields: {
        src: { type: "text", label: "嵌入地址（HTTPS）" },
        height: { type: "select", label: "高度", options: [{ label: "小 · 320px", value: "320" }, { label: "中 · 480px", value: "480" }, { label: "大 · 640px", value: "640" }] },
        caption: { type: "text", label: "说明文字" },
      },
      defaultProps: { src: "", height: "480", caption: "" },
      render: ({ src, height, caption }) => <section className="block alt"><div className="container narrow"><div className="embed-block">{/^https:\/\//i.test(src.trim()) ? <iframe src={src.trim()} title={caption || "嵌入内容"} style={{ height: `${Number(height) || 480}px` }} loading="lazy" allowFullScreen /> : <div className="video-placeholder">在右侧填写 HTTPS 嵌入地址（支持哔哩哔哩、视频号等通用 iframe 地址）</div>}</div>{caption ? <p className="muted" style={{ textAlign: "center", marginTop: 12 }}>{caption}</p> : null}</div></section>,
    },
    Countdown: {
      fields: {
        title: { type: "text", label: "标题" },
        description: { type: "textarea", label: "活动说明" },
        end_time: { type: "text", label: "结束时间", placeholder: "2026-12-31 23:59:59（北京时间）" },
        note: { type: "text", label: "底部提示" },
      },
      defaultProps: { title: "限时优惠进行中", description: "活动期间购买任意套餐享受专属折扣，倒计时结束后恢复原价。", end_time: "", note: "优惠名额有限，先到先得。" },
      render: ({ title, description, end_time, note }) => <section className="block countdown-block"><div className="container"><h2>{title}</h2><p>{description}</p><CountdownTimer end_time={end_time} />{note ? <div className="muted">{note}</div> : null}</div></section>,
    },
    Pricing: {
      fields: { title: { type: "text", label: "标题" }, description: { type: "text", label: "说明" } },
      defaultProps: { title: "选择套餐", description: "价格直接来自后台产品与套餐配置。" },
      render: ({ title, description, puck }) => {
        const metadata = (puck.metadata ?? {}) as StorefrontMetadata;
        const plans = metadata.plans ?? [];
        return <section id="pricing" className="block"><div className="container"><h2>{title}</h2><p className="muted" style={{ marginBottom: 28 }}>{description}</p>{plans.length === 0 ? <Empty description="暂无可购买套餐；可在后台产品管理中添加" /> : <div className="pricing-grid">{plans.map((plan) => <Card className={`pricing-card ${plan.highlighted ? "highlighted" : ""}`} key={plan.id}>{plan.highlighted ? <Tag color="blue">推荐</Tag> : null}<div className="muted">{plan.product_name}</div><h3>{plan.name}</h3><div className="price">{money(plan.amount_cents)}{plan.original_amount_cents && plan.original_amount_cents > plan.amount_cents ? <span className="price-original">{money(plan.original_amount_cents)}</span> : null}</div><div className="billing-label">{plan.billing_label}</div><p className="plan-description">{plan.description || "立即购买并开始使用。"}</p><BuyButton plan={plan} metadata={metadata} /></Card>)}</div>}</div></section>;
      },
    },
    ProductGrid: {
      fields: { title: { type: "text", label: "标题" }, description: { type: "textarea", label: "说明" }, product_slug: { type: "text", label: "产品 slug（留空展示全部）" } },
      defaultProps: { title: "产品与套餐", description: "按产品展示可购买套餐。", product_slug: "" },
      render: ({ title, description, product_slug, puck }) => {
        const metadata = (puck.metadata ?? {}) as StorefrontMetadata;
        const products = (metadata.products ?? []).filter((product) => !product_slug || product.slug === product_slug);
        const plans = metadata.plans ?? [];
        return <section className="block alt"><div className="container"><h2>{title}</h2><p className="muted section-intro">{description}</p>{products.length === 0 ? <Empty description="暂无产品；可在后台产品管理中添加" /> : <div className="product-grid">{products.map((product) => <Card className="product-card" key={product.id}>{product.cover_url ? <img src={product.cover_url} alt={product.name} className="product-cover" /> : null}<h3>{product.name}</h3><p className="muted">{product.summary || product.description}</p><div className="product-plan-list">{plans.filter((plan) => plan.product_id === product.id).map((plan) => <div className="product-plan" key={plan.id}><div><strong>{plan.name}</strong><span className="muted">{money(plan.amount_cents)} · {plan.billing_label}</span></div><BuyButton plan={plan} metadata={metadata} /></div>)}</div></Card>)}</div>}</div></section>;
      },
    },
    FAQ: {
      fields: { title: { type: "text", label: "标题" }, items: { type: "textarea", label: "问答（问题|答案，每行一个）" } },
      defaultProps: { title: "常见问题", items: "如何开始？|选择套餐后即可在线购买。\n支持什么支付方式？|支持支付宝和微信支付。" },
      render: ({ title, items }) => <section className="block"><div className="container narrow"><h2>{title}</h2><div className="faq-list">{pipeItems(items, 2).map((item) => <details className="faq-item" key={item.left}><summary>{item.left}</summary><p>{item.middle}</p></details>)}</div></div></section>,
    },
    Testimonials: {
      fields: { title: { type: "text", label: "标题" }, items: { type: "textarea", label: "评价（姓名|身份|内容，每行一个）" } },
      defaultProps: { title: "客户怎么说", items: "林晓|产品负责人|上线速度比预期快很多。\n周然|独立开发者|套餐和支付流程都很清晰。" },
      render: ({ title, items }) => <section className="block alt"><div className="container"><h2>{title}</h2><div className="testimonial-grid">{nonEmptyLines(items).map((line) => { const [name, role, quote] = line.split("|").map((part) => part.trim()); return <Card className="testimonial-card" key={line}><p>“{quote || role || name}”</p><strong>{name}</strong><span className="muted">{role}</span></Card>; })}</div></div></section>,
    },
    Stats: {
      fields: { title: { type: "text", label: "标题" }, items: { type: "textarea", label: "数据（数值|标签，每行一个）" } },
      defaultProps: { title: "值得信赖的结果", items: "99.9%|服务可用性\n10 分钟|完成配置\n24/7|全天候自动处理订单" },
      render: ({ title, items }) => <section className="block"><div className="container"><h2>{title}</h2><div className="stats-grid">{pipeItems(items, 2).map((item) => <div className="stat-card" key={item.left}><strong>{item.left}</strong><span>{item.middle}</span></div>)}</div></div></section>,
    },
    LogoCloud: {
      fields: { title: { type: "text", label: "标题" }, items: { type: "textarea", label: "品牌名称（每行一个）" } },
      defaultProps: { title: "他们正在使用", items: "青云科技\n星河数据\n极光智能\n天工软件" },
      render: ({ title, items }) => <section className="block alt"><div className="container"><h2>{title}</h2><div className="logo-cloud">{nonEmptyLines(items).map((item) => <span key={item}>{item}</span>)}</div></div></section>,
    },
    Video: {
      fields: { title: { type: "text", label: "标题" }, description: { type: "textarea", label: "说明" }, video_url: { type: "text", label: "视频 URL" }, poster_url: { type: "text", label: "封面 URL" } },
      defaultProps: { title: "产品演示", description: "用一段视频快速说明产品价值。", video_url: "", poster_url: "" },
      render: ({ title, description, video_url, poster_url }) => <section className="block"><div className="container narrow"><h2>{title}</h2><p className="muted section-intro">{description}</p>{video_url ? <video className="video-block" controls preload="metadata" poster={poster_url || undefined} src={video_url} /> : <div className="video-placeholder">在右侧填写视频 URL</div>}</div></section>,
    },
    Comparison: {
      fields: { title: { type: "text", label: "标题" }, basic_label: { type: "text", label: "基础方案名" }, pro_label: { type: "text", label: "高级方案名" }, items: { type: "textarea", label: "对比项（功能|基础说明|高级说明，每行一个）" } },
      defaultProps: { title: "方案对比", basic_label: "基础版", pro_label: "专业版", items: "团队协作|基础|完整\n自动化|—|支持\n优先支持|—|支持" },
      render: ({ title, basic_label, pro_label, items }) => <section className="block alt"><div className="container"><h2>{title}</h2><div className="comparison-table"><div className="comparison-row comparison-head"><strong>功能</strong><strong>{basic_label}</strong><strong>{pro_label}</strong></div>{pipeItems(items, 3).map((item) => <div className="comparison-row" key={item.left}><span>{item.left}</span><span>{item.middle}</span><span>{item.right}</span></div>)}</div></div></section>,
    },
    Image: {
      fields: {
        asset_id: { type: "select", label: "素材库图片", options: [{ label: "不绑定素材库（使用 URL）", value: "" }] },
        image_url: { type: "text", label: "图片 URL" },
        image_alt: { type: "text", label: "替代文字（必填）" },
        caption: { type: "text", label: "图片说明" },
        object_fit: { type: "select", label: "裁切方式", options: [{ label: "覆盖", value: "cover" }, { label: "完整显示", value: "contain" }] },
      },
      resolveFields: (_data, { metadata }) => ({
        asset_id: { type: "select", label: "素材库图片", options: assetOptions(metadata) },
        image_url: { type: "text", label: "图片 URL" },
        image_alt: { type: "text", label: "替代文字（必填）" },
        caption: { type: "text", label: "图片说明" },
        object_fit: { type: "select", label: "裁切方式", options: [{ label: "覆盖", value: "cover" }, { label: "完整显示", value: "contain" }] },
      }),
      resolveData: (data, { metadata }) => {
        const asset = getAssets(metadata).find((item) => item.id === data.props.asset_id);
        return asset ? { ...data, props: { ...data.props, image_url: asset.public_url, image_alt: data.props.image_alt || asset.filename } } : data;
      },
      defaultProps: { asset_id: "", image_url: "", image_alt: "", caption: "", object_fit: "cover" },
      render: ({ asset_id, image_url, image_alt, caption, object_fit, puck }) => {
        const asset = getAssets(puck.metadata).find((item) => item.id === asset_id);
        const source = image_url || asset?.public_url;
        return <section className="block"><div className="container narrow">{source ? <figure className="image-block"><img src={source} alt={image_alt || ""} style={{ objectFit: object_fit }} />{caption ? <figcaption>{caption}</figcaption> : null}</figure> : <div className="image-placeholder">请从素材库选择图片或填写 URL</div>}</div></section>;
      },
    },
    Divider: {
      fields: { label: { type: "text", label: "文字（可选）" } },
      defaultProps: { label: "" },
      render: ({ label }) => <div className="container"><div className="divider-block">{label ? <span>{label}</span> : null}</div></div>,
    },
    Spacer: {
      fields: { height: { type: "select", label: "高度", options: [{ label: "小", value: "small" }, { label: "中", value: "medium" }, { label: "大", value: "large" }] } },
      defaultProps: { height: "medium" },
      render: ({ height }) => <div className={`spacer-block spacer-${height || "medium"}`} aria-hidden="true" />,
    },
    Contact: {
      fields: { title: { type: "text", label: "标题" }, description: { type: "textarea", label: "描述" }, buttonText: { type: "text", label: "按钮文字" }, email: { type: "text", label: "联系邮箱" } },
      defaultProps: { title: "需要帮助？", description: "欢迎联系我们，我们会尽快回复。", buttonText: "发送邮件", email: "" },
      render: ({ title, description, buttonText, email }) => <section className="block cta-block"><div className="container"><h2>{title}</h2><p>{description}</p>{email ? <Button type="primary" size="large" href={`mailto:${email}`}>{buttonText}</Button> : <Button type="primary" size="large" disabled>{buttonText}</Button>}</div></section>,
    },
    CTA: {
      fields: { title: { type: "text", label: "标题" }, description: { type: "textarea", label: "描述" }, buttonText: { type: "text", label: "按钮文字" }, buttonHref: { type: "text", label: "按钮链接" } },
      defaultProps: { title: "准备开始了吗？", description: "选择适合你的套餐并完成购买。", buttonText: "立即购买", buttonHref: "#pricing" },
      render: ({ title, description, buttonText, buttonHref = "#pricing" }) => <section className="block cta-block"><div className="container"><h2>{title}</h2><p>{description}</p><Button type="primary" size="large" href={safeHref(buttonHref)}>{buttonText}</Button></div></section>,
    },
  },
};

export function createAiPageBlock(type: string, generated: Record<string, unknown>): Data["content"][number] {
  if (!Object.hasOwn(pageConfig.components, type)) throw new Error("不支持的组件类型");
  const component = pageConfig.components[type as keyof PageProps];
  const props: Record<string, unknown> = { ...component.defaultProps };
  // AI 只生成部分文案字段；其余配置沿用组件默认值，且不接受错误类型或额外字段。
  for (const [key, value] of Object.entries(generated)) {
    if (Object.hasOwn(props, key) && typeof value === typeof props[key]) props[key] = value;
  }
  return { type, props: { ...props, id: crypto.randomUUID() } };
}

export const defaultPageData: Data = {
  content: [
    { type: "Hero", props: { id: "hero", eyebrow: "SAAS 产品", title: "你的 SaaS，应该更容易被购买", description: "展示功能、管理套餐、支持支付宝与微信支付，并在支付成功后通过 Webhook 联动业务系统。", buttonText: "查看套餐", buttonHref: "#pricing", layout: "center", image_url: "", image_alt: "" } },
    { type: "Features", props: { id: "features", title: "核心能力", items: "可视化编辑展示页面\n产品与套餐统一管理\n支付宝、微信支付\n支付完成自动通知业务系统", columns: "4" } },
    { type: "Pricing", props: { id: "pricing", title: "选择适合你的套餐", description: "价格来自后台统一配置，页面不重复保存金额。" } },
  ],
  root: {},
};

export const pageTemplates: Record<string, { label: string; data: Data }> = {
  landing: { label: "营销落地页", data: defaultPageData },
  product: {
    label: "产品介绍页",
    data: { content: [
      { type: "Hero", props: { id: "hero", eyebrow: "产品介绍", title: "把产品价值讲清楚", description: "用清晰的内容、功能和套餐帮助访客完成决策。", buttonText: "查看套餐", buttonHref: "#pricing", layout: "split", image_url: "", image_alt: "" } },
      { type: "ProductGrid", props: { id: "products", title: "产品与套餐", description: "选择适合你的产品方案。", product_slug: "" } },
      { type: "Steps", props: { id: "steps", title: "开始只需三步", items: "选择套餐|根据团队规模选择合适的套餐。\n在线支付|支持支付宝与微信支付。\n开始使用|支付成功后立即交付。", columns: "3" } },
      { type: "Features", props: { id: "features", title: "为什么选择我们", items: "快速上线\n透明定价\n稳定支付\n自动化交付", columns: "4" } },
      { type: "CTA", props: { id: "cta", title: "准备开始了吗？", description: "现在就选择你的套餐。", buttonText: "立即购买", buttonHref: "#pricing" } },
    ], root: {} },
  },
  pricing: {
    label: "价格方案页",
    data: { content: [
      { type: "Hero", props: { id: "hero", eyebrow: "价格方案", title: "选择适合你的方案", description: "所有价格都来自后台套餐配置，修改一次即可同步页面。", buttonText: "查看方案", buttonHref: "#pricing", layout: "center", image_url: "", image_alt: "" } },
      { type: "Pricing", props: { id: "pricing", title: "套餐方案", description: "按需选择，随时开始。" } },
      { type: "Comparison", props: { id: "comparison", title: "方案对比", basic_label: "基础版", pro_label: "专业版", items: "团队协作|基础|完整\n自动化|—|支持\n优先支持|—|支持" } },
      { type: "FAQ", props: { id: "faq", title: "常见问题", items: "可以更换套餐吗？|可以，请联系管理员处理。\n付款后多久生效？|支付成功后会立即更新订单状态。" } },
    ], root: {} },
  },
  faq: {
    label: "帮助中心页",
    data: { content: [
      { type: "Hero", props: { id: "hero", eyebrow: "帮助中心", title: "常见问题与帮助", description: "在这里找到关于产品、套餐和支付的答案。", buttonText: "查看套餐", buttonHref: "#pricing", layout: "center", image_url: "", image_alt: "" } },
      { type: "FAQ", props: { id: "faq", title: "常见问题", items: "如何购买？|选择套餐并点击立即购买。\n如何联系支持？|使用页面底部联系方式。" } },
      { type: "Contact", props: { id: "contact", title: "还有其他问题？", description: "欢迎联系我们。", buttonText: "联系我们", email: "" } },
    ], root: {} },
  },
  blank: { label: "空白页面", data: { content: [], root: {} } },
};
