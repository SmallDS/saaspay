import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Alert, Button, Card, Checkbox, Col, Form, Input, Row, Select, Space, Switch, Tabs, Typography, message } from "antd";
import type { FormInstance } from "antd";
import { api } from "../shared/api";
import { defaultTheme, type SiteFooterSettings, type SiteHeaderSettings, type SiteThemeSettings } from "../editor/site";

type SettingsData = {
  site: { name: string; tagline: string; primary_domain: string; theme: SiteThemeSettings; header: SiteHeaderSettings; footer: SiteFooterSettings };
  alipay: { enabled: boolean; app_id: string; gateway: string; seller_id: string; private_key_configured: boolean; public_key_configured: boolean };
  wechat: { enabled: boolean; app_id: string; mch_id: string; mch_serial_no: string; api_v3_key_configured: boolean; private_key_configured: boolean; public_key_configured: boolean; public_key_id: string };
  seo: { keywords: string; default_og_image: string; robots_allow: boolean };
  legal: { icp_no: string; copyright: string };
  custom_code: { head_html: string; body_html: string };
  webhook: { enabled: boolean; url: string; events: string[]; secret_configured: boolean };
};

type SeoFormValues = {
  keywords?: string;
  default_og_image?: string;
  robots_allow?: boolean;
  icp_no?: string;
  copyright?: string;
  head_html?: string;
  body_html?: string;
};

type LinkForm = { label?: string; href?: string };
type VisualHeaderForm = SiteHeaderSettings & { links_text?: string };
type VisualFooterForm = SiteFooterSettings & { links_text?: string };
type VisualFormValues = { theme: SiteThemeSettings; header: VisualHeaderForm; footer: VisualFooterForm };

type ThemePreset = {
  key: string;
  label: string;
  description: string;
  theme: SiteThemeSettings;
};

const themePresets: ThemePreset[] = [
  {
    key: "minimal",
    label: "现代极简",
    description: "清晰、克制，适合 SaaS 与工具产品",
    theme: { ...defaultTheme },
  },
  {
    key: "warm",
    label: "柔和暖色",
    description: "更亲和、更有生活感，适合消费类产品",
    theme: {
      primary_color: "#c85a3c",
      accent_color: "#2d2925",
      surface_color: "#fffaf5",
      page_background: "#f7f0e9",
      text_color: "#2d2925",
      muted_color: "#7b7067",
      font_family: "Poppins, ui-sans-serif, system-ui, sans-serif",
      radius: "20px",
      container_width: "1120px",
      section_spacing: "96px",
      header_height: "72px",
    },
  },
  {
    key: "indigo",
    label: "深蓝专业",
    description: "更稳重、更有产品感，适合 B2B 服务",
    theme: {
      primary_color: "#4f46e5",
      accent_color: "#172554",
      surface_color: "#ffffff",
      page_background: "#f4f6ff",
      text_color: "#172033",
      muted_color: "#64748b",
      font_family: "Inter, ui-sans-serif, system-ui, sans-serif",
      radius: "14px",
      container_width: "1200px",
      section_spacing: "88px",
      header_height: "68px",
    },
  },
];

function linksToText(links: LinkForm[] = []) {
  return links.map((link) => (link.label ?? "") + "|" + (link.href ?? "")).join("\n");
}

function textToLinks(value: string): LinkForm[] {
  return value
    .split(/\r?\n/)
    .map((line) => {
      const [label, href] = line.split("|").map((part) => part.trim());
      return { label, href };
    })
    .filter((link) => link.label && link.href);
}

function validColor(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

function previewLinks(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/\r?\n/)
    .map((line) => line.split("|")[0]?.trim() ?? "")
    .filter(Boolean)
    .slice(0, 3);
}

function ColorField({ form, name, label, placeholder }: { form: FormInstance; name: string[]; label: string; placeholder: string }) {
  const value = Form.useWatch(name, form) as string | undefined;
  const color = validColor(value, placeholder);
  return (
    <Form.Item
      name={name}
      label={label}
      rules={[{ pattern: /^#[0-9a-f]{6}$/i, message: "请输入 6 位十六进制颜色，例如 #3159ca" }]}
    >
      <Input
        placeholder={placeholder}
        addonBefore={
          <input
            className="theme-color-input"
            type="color"
            value={color}
            onChange={(event) => form.setFieldValue(name, event.target.value)}
            aria-label={label}
          />
        }
      />
    </Form.Item>
  );
}

function ThemePreview({ form }: { form: FormInstance }) {
  const theme = (Form.useWatch("theme", form) ?? {}) as Partial<SiteThemeSettings>;
  const header = (Form.useWatch("header", form) ?? {}) as Partial<VisualHeaderForm>;
  const primary = validColor(theme.primary_color, defaultTheme.primary_color);
  const accent = validColor(theme.accent_color, defaultTheme.accent_color);
  const surface = validColor(theme.surface_color, defaultTheme.surface_color);
  const pageBackground = validColor(theme.page_background, defaultTheme.page_background);
  const text = validColor(theme.text_color, defaultTheme.text_color);
  const muted = validColor(theme.muted_color, defaultTheme.muted_color);
  const previewStyle = {
    "--preview-primary": primary,
    "--preview-accent": accent,
    "--preview-surface": surface,
    "--preview-page": pageBackground,
    "--preview-text": text,
    "--preview-muted": muted,
    "--preview-font": theme.font_family || defaultTheme.font_family,
    "--preview-radius": theme.radius || defaultTheme.radius,
    "--preview-header-height": theme.header_height || defaultTheme.header_height,
  } as CSSProperties;
  const links = previewLinks(header.links_text);

  return (
    <Card
      className="theme-preview-card"
      title="实时预览"
      extra={<Typography.Text type="secondary">保存后应用到前台</Typography.Text>}
    >
      <div className="theme-preview" style={previewStyle}>
        <div className="theme-preview-header">
          <strong>SaaS Store</strong>
          {header.show_nav !== false ? (
            <div className="theme-preview-nav">
              {links.map((label) => <span key={label}>{label}</span>)}
              {header.cta_text ? <b>{header.cta_text}</b> : null}
            </div>
          ) : null}
        </div>
        <div className="theme-preview-hero">
          <span className="theme-preview-eyebrow">SaaS PRODUCT</span>
          <h3>让你的产品更容易被购买</h3>
          <p>用清晰的内容、套餐和支付流程，帮助访客快速完成决策。</p>
          <button type="button">查看套餐</button>
        </div>
        <div className="theme-preview-content">
          <div className="theme-preview-card-item"><span>产品展示</span><strong>清晰表达价值</strong></div>
          <div className="theme-preview-card-item"><span>套餐管理</span><strong>价格一处配置</strong></div>
        </div>
        <div className="theme-preview-footer">可靠的产品展示与购买体验</div>
      </div>
    </Card>
  );
}

function VisualSettings({ form, onSave }: { form: FormInstance; onSave: (values: VisualFormValues) => void }) {
  const [activePreset, setActivePreset] = useState("minimal");

  function applyPreset(preset: ThemePreset) {
    form.setFieldsValue({ theme: preset.theme });
    setActivePreset(preset.key);
  }

  return (
    <Form
      form={form}
      layout="vertical"
      onFinish={(values) => onSave(values as VisualFormValues)}
      onValuesChange={() => setActivePreset("")}
    >
      <div className="visual-settings-layout">
        <div className="visual-settings-form">
          <Alert
            type="info"
            showIcon
            message="主题设置会自动应用到已发布页面"
            description="先选择一个视觉方向，再微调颜色、字体和布局。导航链接每行一条，格式为：显示文字|链接地址。"
            style={{ marginBottom: 16 }}
          />

          <Card className="settings-section" title="主题预设" extra={<Typography.Text type="secondary">一键建立视觉基线</Typography.Text>}>
            <Space wrap>
              {themePresets.map((preset) => (
                <Button
                  key={preset.key}
                  type={activePreset === preset.key ? "primary" : "default"}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </Button>
              ))}
            </Space>
            <div className="theme-preset-hint">
              {themePresets.find((preset) => preset.key === activePreset)?.description ?? "已进入自定义模式，可继续调整下方设置。"}
            </div>
          </Card>

          <Card className="settings-section" title="颜色与字体">
            <Row gutter={[16, 0]}>
              <Col xs={24} md={12}><ColorField form={form} name={["theme", "primary_color"]} label="主色" placeholder="#3159ca" /></Col>
              <Col xs={24} md={12}><ColorField form={form} name={["theme", "accent_color"]} label="强调色" placeholder="#172033" /></Col>
              <Col xs={24} md={12}><ColorField form={form} name={["theme", "surface_color"]} label="卡片背景色" placeholder="#ffffff" /></Col>
              <Col xs={24} md={12}><ColorField form={form} name={["theme", "page_background"]} label="页面背景色" placeholder="#f6f8fb" /></Col>
              <Col xs={24} md={12}><ColorField form={form} name={["theme", "text_color"]} label="正文颜色" placeholder="#172033" /></Col>
              <Col xs={24} md={12}><ColorField form={form} name={["theme", "muted_color"]} label="辅助文字颜色" placeholder="#667085" /></Col>
              <Col xs={24}><Form.Item name={["theme", "font_family"]} label="字体族" extra="建议使用系统字体或已在页面中加载的字体"><Input placeholder="Inter, ui-sans-serif, system-ui, sans-serif" /></Form.Item></Col>
            </Row>
          </Card>

          <Card className="settings-section" title="布局与节奏">
            <Row gutter={[16, 0]}>
              <Col xs={24} sm={12}><Form.Item name={["theme", "radius"]} label="圆角风格"><Select options={[{ label: "紧凑 · 8px", value: "8px" }, { label: "标准 · 12px", value: "12px" }, { label: "柔和 · 16px", value: "16px" }, { label: "圆润 · 20px", value: "20px" }, { label: "大圆角 · 24px", value: "24px" }]} /></Form.Item></Col>
              <Col xs={24} sm={12}><Form.Item name={["theme", "container_width"]} label="内容宽度"><Select options={[{ label: "窄 · 960px", value: "960px" }, { label: "标准 · 1120px", value: "1120px" }, { label: "宽 · 1200px", value: "1200px" }, { label: "超宽 · 1280px", value: "1280px" }]} /></Form.Item></Col>
              <Col xs={24} sm={12}><Form.Item name={["theme", "section_spacing"]} label="区块间距"><Select options={[{ label: "紧凑 · 64px", value: "64px" }, { label: "标准 · 86px", value: "86px" }, { label: "舒展 · 96px", value: "96px" }, { label: "宽松 · 112px", value: "112px" }]} /></Form.Item></Col>
              <Col xs={24} sm={12}><Form.Item name={["theme", "header_height"]} label="Header 高度"><Select options={[{ label: "紧凑 · 60px", value: "60px" }, { label: "标准 · 68px", value: "68px" }, { label: "舒展 · 72px", value: "72px" }, { label: "宽松 · 76px", value: "76px" }]} /></Form.Item></Col>
            </Row>
          </Card>

          <Card className="settings-section" title="全局 Header">
            <Row gutter={[16, 0]}>
              <Col xs={24} sm={12}><Form.Item name={["header", "enabled"]} label="显示 Header" valuePropName="checked"><Switch /></Form.Item></Col>
              <Col xs={24} sm={12}><Form.Item name={["header", "show_nav"]} label="显示导航" valuePropName="checked"><Switch /></Form.Item></Col>
              <Col xs={24}><Form.Item name={["header", "links_text"]} label="导航链接" extra="支持 #锚点、站内路径、HTTPS 和 mailto: 链接"><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder={"套餐|#pricing\n管理后台|/admin"} /></Form.Item></Col>
              <Col xs={24} sm={12}><Form.Item name={["header", "cta_text"]} label="Header 按钮文字"><Input placeholder="例如：立即开始" /></Form.Item></Col>
              <Col xs={24} sm={12}><Form.Item name={["header", "cta_href"]} label="Header 按钮链接"><Input placeholder="#pricing 或 /checkout" /></Form.Item></Col>
            </Row>
          </Card>

          <Card className="settings-section" title="全局 Footer">
            <Row gutter={[16, 0]}>
              <Col xs={24} sm={12}><Form.Item name={["footer", "enabled"]} label="显示 Footer" valuePropName="checked"><Switch /></Form.Item></Col>
              <Col xs={24}><Form.Item name={["footer", "tagline"]} label="Footer 文案"><Input placeholder="一句话说明你的产品" /></Form.Item></Col>
              <Col xs={24}><Form.Item name={["footer", "links_text"]} label="Footer 链接" extra="例如：隐私政策|/privacy"><Input.TextArea autoSize={{ minRows: 3, maxRows: 8 }} placeholder={"隐私政策|/privacy\n联系我们|mailto:hello@example.com"} /></Form.Item></Col>
            </Row>
          </Card>

          <Button type="primary" htmlType="submit" size="large">保存主题与布局</Button>
        </div>
        <ThemePreview form={form} />
      </div>
    </Form>
  );
}

export function Settings() {
  const [data, setData] = useState<SettingsData | null>(null);
  const [site] = Form.useForm();
  const [visual] = Form.useForm();
  const [alipay] = Form.useForm();
  const [wechat] = Form.useForm();
  const [seoForm] = Form.useForm<SeoFormValues>();
  const [webhook] = Form.useForm();

  const load = async () => {
    const result = await api<{ settings: SettingsData }>("/api/admin/settings");
    setData(result.settings);
    site.setFieldsValue(result.settings.site);
    visual.setFieldsValue({
      theme: result.settings.site.theme,
      header: { ...result.settings.site.header, links_text: linksToText(result.settings.site.header.links) },
      footer: { ...result.settings.site.footer, links_text: linksToText(result.settings.site.footer.links) },
    });
    alipay.setFieldsValue(result.settings.alipay);
    wechat.setFieldsValue(result.settings.wechat);
    seoForm.setFieldsValue({ ...result.settings.seo, ...result.settings.legal, ...result.settings.custom_code });
    webhook.setFieldsValue(result.settings.webhook);
  };

  useEffect(() => { void load(); }, []);

  const save = async (payload: unknown) => {
    await api("/api/admin/settings", { method: "PUT", body: JSON.stringify(payload) });
    message.success("设置已保存");
    await load();
  };

  const saveVisual = async (values: VisualFormValues) => {
    await save({
      site: {
        theme: values.theme,
        header: { ...values.header, links: textToLinks(values.header?.links_text ?? "") },
        footer: { ...values.footer, links: textToLinks(values.footer?.links_text ?? "") },
      },
    });
  };

  const siteTab = (
    <Card title="网站信息" className="settings-card">
      <Form form={site} layout="vertical" onFinish={(values) => void save({ site: values })}>
        <Form.Item name="name" label="网站名称" rules={[{ required: true, message: "请输入网站名称" }]}><Input maxLength={80} /></Form.Item>
        <Form.Item name="tagline" label="网站副标题"><Input maxLength={160} /></Form.Item>
        <Form.Item name="primary_domain" label="主要域名" extra="用于生成支付宝通知和回跳地址；留空则使用当前访问域名"><Input placeholder="https://example.com" /></Form.Item>
        <Button type="primary" htmlType="submit">保存网站设置</Button>
      </Form>
    </Card>
  );

  const alipayTab = (
    <Card title="支付宝支付" className="settings-card">
      <Alert
        type="info"
        showIcon
        message="支持电脑网站支付与手机网站支付（H5）"
        description="系统会根据访客设备自动选择：PC 使用 alipay.trade.page.pay，手机浏览器使用 alipay.trade.wap.pay（支付中途退出会回跳到结果页）。两者共用同一套 AppID 与密钥、同一个异步回调；请确认已在支付宝开放平台同时签约「电脑网站支付」与「手机网站支付」两个产品。"
        style={{ marginBottom: 16 }}
      />
      <Alert type="info" showIcon message="应用私钥必须与当前 AppID 的应用公钥匹配；支付宝公钥请填写平台返回的支付宝公钥。密钥只保存在服务端。" style={{ marginBottom: 16 }} />
      <Form form={alipay} layout="vertical" onFinish={(values) => void save({ alipay: values })}>
        <Form.Item name="enabled" label="启用支付宝" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="app_id" label="AppID"><Input /></Form.Item>
        <Form.Item name="seller_id" label="商户 PID（可选，用于增强回调校验）"><Input /></Form.Item>
        <Form.Item name="gateway" label="支付宝网关"><Input /></Form.Item>
        <Form.Item label={"应用私钥" + (data?.alipay.private_key_configured ? "（已配置，留空不修改）" : "")} name="private_key"><Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} placeholder="粘贴原始 RSA 私钥内容" /></Form.Item>
        <Form.Item label={"支付宝公钥" + (data?.alipay.public_key_configured ? "（已配置，留空不修改）" : "")} name="public_key"><Input.TextArea autoSize={{ minRows: 4, maxRows: 10 }} placeholder="粘贴支付宝 RSA2 公钥" /></Form.Item>
        <Button type="primary" htmlType="submit">保存支付宝设置</Button>
      </Form>
    </Card>
  );

  const wechatTab = (
    <Card title="微信支付" className="settings-card">
      <Alert
        type="info"
        showIcon
        message="需要微信支付商户号（API v3）。PC 浏览器使用 Native 扫码支付，手机浏览器使用 H5 支付；请先在商户平台开通对应产品。"
        description="配置顺序：商户平台 → API 安全 中获取 APIv3 密钥、商户证书序列号和商户私钥（apiclient_key.pem）。使用微信支付公钥模式的商户请同时填写微信支付公钥与公钥 ID。"
        style={{ marginBottom: 16 }}
      />
      <Form form={wechat} layout="vertical" onFinish={(values) => void save({ wechat: values })}>
        <Form.Item name="enabled" label="启用微信支付" valuePropName="checked"><Switch /></Form.Item>
        <Row gutter={[16, 0]}>
          <Col xs={24} md={12}><Form.Item name="app_id" label="AppID" extra="与商户号绑定的公众号 / 小程序 / 开放平台应用 AppID"><Input /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="mch_id" label="商户号"><Input /></Form.Item></Col>
        </Row>
        <Form.Item name="mch_serial_no" label="商户证书序列号" extra="商户平台 → API 安全 → 商户证书序列号"><Input /></Form.Item>
        <Form.Item
          label={"APIv3 密钥" + (data?.wechat.api_v3_key_configured ? "（已配置，留空不修改）" : "")}
          name="api_v3_key"
          extra="32 位字符，用于回调报文解密与平台证书下载"
          rules={[{ validator: (_, value) => !value || value.length === 32 ? Promise.resolve() : Promise.reject(new Error("APIv3 密钥必须为 32 位字符")) }]}
        >
          <Input.Password autoComplete="new-password" />
        </Form.Item>
        <Form.Item
          label={"商户私钥" + (data?.wechat.private_key_configured ? "（已配置，留空不修改）" : "")}
          name="private_key"
          extra="apiclient_key.pem 的完整内容，用于 API 请求签名"
        >
          <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} placeholder="-----BEGIN PRIVATE KEY-----" />
        </Form.Item>
        <Form.Item
          label={"微信支付公钥" + (data?.wechat.public_key_configured ? "（已配置，留空不修改）" : "")}
          name="public_key"
          extra="可选；公钥模式商户填写，使用平台证书的老商户可留空"
        >
          <Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} placeholder="-----BEGIN PUBLIC KEY-----" />
        </Form.Item>
        <Form.Item name="public_key_id" label="微信支付公钥 ID（可选）" extra="与微信支付公钥配套，形如 PUB_KEY_ID_xxx"><Input /></Form.Item>
        <Button type="primary" htmlType="submit">保存微信支付设置</Button>
      </Form>
    </Card>
  );

  const seoTab = (
    <Form<SeoFormValues> form={seoForm} layout="vertical" onFinish={(values) => void save({
      seo: { keywords: values.keywords ?? "", default_og_image: values.default_og_image ?? "", robots_allow: values.robots_allow !== false },
      legal: { icp_no: values.icp_no ?? "", copyright: values.copyright ?? "" },
      custom_code: { head_html: values.head_html ?? "", body_html: values.body_html ?? "" },
    })}>
      <Card title="搜索引擎收录" className="settings-card" style={{ marginBottom: 16 }}>
        <Alert
          type="info"
          showIcon
          message="页面 SEO 由服务端直接输出到 HTML 中"
          description="本站会在返回页面 HTML 时注入标题、描述、关键词、Open Graph、规范链接和结构化数据，百度等不执行网页脚本的搜索引擎也能正确抓取。"
          style={{ marginBottom: 16 }}
        />
        <Form.Item name="robots_allow" label="允许搜索引擎收录" valuePropName="checked" extra="关闭后 robots.txt 将禁止所有搜索引擎抓取，站点地图仍可访问"><Switch /></Form.Item>
        <Form.Item name="keywords" label="全站默认关键词" extra="英文逗号分隔；页面可在编辑器中单独覆盖"><Input placeholder="SaaS, 订阅管理, 在线购买" /></Form.Item>
        <Form.Item name="default_og_image" label="默认分享图 URL" extra="页面未设置 OG 图时使用；支持 https:// 或 /media/ 开头地址"><Input placeholder="https://example.com/share.png" /></Form.Item>
      </Card>
      <Card title="备案与版权" className="settings-card" style={{ marginBottom: 16 }}>
        <Row gutter={[16, 0]}>
          <Col xs={24} md={12}><Form.Item name="icp_no" label="ICP 备案号" extra="填写后显示在页脚并链接至工信部备案网站"><Input placeholder="京ICP备2026000000号-1" /></Form.Item></Col>
          <Col xs={24} md={12}><Form.Item name="copyright" label="版权文案" extra="显示在页脚，例如 © 2026 公司名称"><Input placeholder="© 2026 公司名称" /></Form.Item></Col>
        </Row>
      </Card>
      <Card title="自定义代码" className="settings-card" style={{ marginBottom: 16 }}>
        <Alert
          type="warning"
          showIcon
          message="以下代码将原样注入到每个页面的 head / body 中"
          description="用于接入百度统计、Google Analytics、站点验证 meta 等第三方脚本。仅填写来自可信来源的代码。"
          style={{ marginBottom: 16 }}
        />
        <Form.Item name="head_html" label="Head 代码（统计脚本、验证 meta 等）"><Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} placeholder="<script src='https://hm.baidu.com/hm.js?xxx'></script>" /></Form.Item>
        <Form.Item name="body_html" label="Body 代码（页面底部脚本等）"><Input.TextArea autoSize={{ minRows: 3, maxRows: 10 }} /></Form.Item>
      </Card>
      <Button type="primary" htmlType="submit" size="large">保存全部 SEO 与优化设置</Button>
    </Form>
  );

  const webhookTab = (
    <Card title="业务 Webhook" className="settings-card">
      <Alert type="info" showIcon message="支付成功后系统将事件放入 Cloudflare Queue，再异步 POST 到这里配置的业务系统。" style={{ marginBottom: 16 }} />
      <Form form={webhook} layout="vertical" onFinish={(values) => void save({ webhook: values })}>
        <Form.Item name="enabled" label="启用 Webhook" valuePropName="checked"><Switch /></Form.Item>
        <Form.Item name="url" label="Webhook URL"><Input placeholder="https://api.example.com/webhook" /></Form.Item>
        <Form.Item name="events" label="触发事件"><Checkbox.Group options={[{ label: "order.created", value: "order.created" }, { label: "order.paid", value: "order.paid" }, { label: "order.closed", value: "order.closed" }, { label: "order.refunded", value: "order.refunded" }]} /></Form.Item>
        <Form.Item label={"Webhook Secret" + (data?.webhook.secret_configured ? "（已配置）" : "（未配置）")}>
          <Space wrap>
            <Button onClick={async () => { const result = await api<{ secret: string }>("/api/admin/webhook/secret", { method: "POST" }); await navigator.clipboard?.writeText(result.secret); ModalSecret(result.secret); }}>生成 / 重置 Secret</Button>
            <Button onClick={async () => { await api("/api/admin/webhook/test", { method: "POST" }); message.success("测试事件已进入队列"); }}>发送测试事件</Button>
          </Space>
        </Form.Item>
        <Button type="primary" htmlType="submit">保存 Webhook 设置</Button>
      </Form>
    </Card>
  );

  return (
    <>
      <Typography.Title level={3}>系统设置</Typography.Title>
      <Typography.Paragraph type="secondary">统一管理网站身份、视觉风格、支付和业务通知。</Typography.Paragraph>
      <Tabs items={[
        { key: "site", label: "网站", children: siteTab },
        { key: "visual", label: "主题与布局", children: <VisualSettings form={visual} onSave={saveVisual} /> },
        { key: "alipay", label: "支付宝支付", children: alipayTab },
        { key: "wechat", label: "微信支付", children: wechatTab },
        { key: "seo", label: "SEO 与优化", children: seoTab },
        { key: "webhook", label: "Webhook", children: webhookTab },
      ]} />
    </>
  );
}

function ModalSecret(secret: string) {
  window.prompt("请立即复制 Webhook Secret；后续后台只显示是否已配置：", secret);
}
