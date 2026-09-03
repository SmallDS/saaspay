import { useCallback, useEffect, useRef, useState } from "react";
import { Puck, Render, type Data } from "@puckeditor/core";
import { Alert, Button, Card, Drawer, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { api } from "../shared/api";
import { defaultPageData, pageConfig, pageTemplates, type StorefrontAsset } from "../editor/config";

type PageRow = { id: string; title: string; slug: string; status: string; seo_title?: string; seo_description?: string; seo_keywords?: string; og_image?: string; noindex?: number; updated_at: string };
type PageDetail = PageRow & { draft_json: string };
type EditorPage = PageDetail & { assets: StorefrontAsset[] };
type PageMeta = { title: string; slug: string; seo_title?: string; seo_description?: string; seo_keywords?: string; og_image?: string; noindex?: boolean };
type VersionRow = { id: string; version: number; title?: string; slug?: string; seo_title?: string; seo_description?: string; seo_keywords?: string; og_image?: string; noindex?: number | null; created_at: string };
type CheckItem = { level: "error" | "warning" | "success"; text: string };

export function Pages() {
  const [rows, setRows] = useState<PageRow[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editor, setEditor] = useState<EditorPage | null>(null);
  const [form] = Form.useForm();
  const load = () => api<{ pages: PageRow[] }>("/api/admin/pages").then((result) => setRows(result.pages));
  useEffect(() => { void load(); }, []);

  const openEditor = async (id: string) => {
    const [result, assetResult] = await Promise.all([
      api<{ page: PageDetail }>(`/api/admin/pages/${id}`),
      api<{ assets: StorefrontAsset[] }>("/api/admin/assets").catch(() => ({ assets: [] })),
    ]);
    setEditor({ ...result.page, assets: assetResult.assets ?? [] });
  };

  const duplicatePage = async (row: PageRow) => {
    try {
      const detail = await api<{ page: PageDetail }>(`/api/admin/pages/${row.id}`);
      let draft: unknown = { content: [], root: {} };
      try { draft = JSON.parse(detail.page.draft_json); } catch { /* 空草稿兜底 */ }
      await api("/api/admin/pages", {
        method: "POST",
        body: JSON.stringify({
          title: row.title + " 副本",
          slug: row.slug === "home" ? "home-copy" : row.slug + "-copy",
          seo_title: row.seo_title ?? "",
          seo_description: row.seo_description ?? "",
          seo_keywords: row.seo_keywords ?? "",
          og_image: row.og_image ?? "",
          draft,
        }),
      });
      message.success("页面已复制，可在新页面中调整内容");
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "复制页面失败");
    }
  };

  return <>
    <Space style={{ width: "100%", justifyContent: "space-between" }}>
      <Typography.Title level={3}>页面</Typography.Title>
      <Button type="primary" onClick={() => setCreateOpen(true)}>新增页面</Button>
    </Space>
    <Card>
      <Table rowKey="id" dataSource={rows} columns={[
        { title: "标题", dataIndex: "title", render: (value: string, row: PageRow) => <Space>{value}{row.noindex ? <Tag>不收录</Tag> : null}{row.status !== "published" ? null : <Tag color="green">已发布</Tag>}</Space> },
        { title: "Slug", dataIndex: "slug" },
        { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "published" ? "green" : "gold"}>{value === "published" ? "已发布" : "草稿"}</Tag> },
        { title: "更新时间", dataIndex: "updated_at" },
        { title: "操作", render: (_: unknown, row: PageRow) => <Space>
          <Button type="link" onClick={() => void openEditor(row.id)}>编辑</Button>
          <Button type="link" onClick={async () => { await api(`/api/admin/pages/${row.id}/publish`, { method: "POST" }); message.success("已发布"); await load(); }}>发布</Button>
          <Button type="link" onClick={() => void duplicatePage(row)}>复制</Button>
          {row.slug === "home" ? null : <Popconfirm title="删除页面？" onConfirm={async () => { await api(`/api/admin/pages/${row.id}`, { method: "DELETE" }); await load(); }}><Button danger type="link">删除</Button></Popconfirm>}
        </Space> },
      ]} />
    </Card>

    <Modal title="新增页面" open={createOpen} onCancel={() => setCreateOpen(false)} onOk={() => form.submit()}>
      <Form form={form} layout="vertical" initialValues={{ template: "landing" }} onFinish={async (values) => {
        const template = pageTemplates[values.template] ?? pageTemplates.landing;
        await api("/api/admin/pages", { method: "POST", body: JSON.stringify({ ...values, draft_json: cloneData(template.data), seo_title: values.title }) });
        setCreateOpen(false); form.resetFields(); await load();
      }}>
        <Form.Item name="title" label="页面标题" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="slug" label="Slug" rules={[{ required: true, pattern: /^[a-z0-9-/]+$/ }]}><Input placeholder="pricing 或 docs/get-started" /></Form.Item>
        <Form.Item name="template" label="页面模板"><Select options={Object.entries(pageTemplates).map(([value, template]) => ({ value, label: template.label }))} /></Form.Item>
      </Form>
    </Modal>

    <Drawer open={!!editor} onClose={() => setEditor(null)} width="100%" title={editor ? `可视化编辑：${editor.title}` : "页面编辑"} destroyOnClose>
      {editor ? <PageEditor page={editor} onSaved={async () => { message.success("页面已更新"); await openEditor(editor.id); await load(); }} /> : null}
    </Drawer>
  </>;
}

function PageEditor({ page, onSaved }: { page: EditorPage; onSaved: () => Promise<void> | void }) {
  let initial: Data = defaultPageData;
  try { initial = JSON.parse(page.draft_json) as Data; } catch { initial = defaultPageData; }
  const [metaForm] = Form.useForm<PageMeta>();
  const latestData = useRef<Data>(initial);
  const saveTimer = useRef<number | undefined>(undefined);
  const revision = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewData, setPreviewData] = useState<Data>(initial);
  const [previewMode, setPreviewMode] = useState<"desktop" | "tablet" | "mobile">("desktop");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [checksOpen, setChecksOpen] = useState(false);
  const [checks, setChecks] = useState<CheckItem[]>([]);

  const persist = useCallback(async (data: Data, meta?: PageMeta, createVersion = false) => {
    const values = meta ?? metaForm.getFieldsValue();
    const savingRevision = revision.current;
    setSaving(true);
    try {
      const result = await api<{ version?: number }>(`/api/admin/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify({
          title: values.title || page.title,
          slug: values.slug || page.slug,
          seo_title: values.seo_title ?? "",
          seo_description: values.seo_description ?? "",
          seo_keywords: values.seo_keywords ?? "",
          og_image: values.og_image ?? "",
          noindex: values.noindex ?? false,
          draft_json: data,
          create_version: createVersion,
        }),
      });
      if (savingRevision === revision.current) {
        setDirty(false);
        setLastSavedAt(new Date());
      }
      if (createVersion) message.success(`版本已保存${result.version ? `（v${result.version}）` : ""}`);
      return result;
    } finally {
      setSaving(false);
    }
  }, [metaForm, page.id, page.slug, page.title]);

  const scheduleAutosave = useCallback((data: Data) => {
    if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void persist(data).catch((error) => message.error(error instanceof Error ? error.message : "自动保存失败"));
    }, 1200);
  }, [persist]);

  useEffect(() => () => { if (saveTimer.current !== undefined) window.clearTimeout(saveTimer.current); }, []);

  async function loadVersions() {
    const result = await api<{ versions: VersionRow[] }>(`/api/admin/pages/${page.id}/versions`);
    setVersions(result.versions);
    setVersionsOpen(true);
  }
  async function restoreVersion(version: number) {
    await api(`/api/admin/pages/${page.id}/versions/${version}`, { method: "POST" });
    setVersionsOpen(false);
    await onSaved();
  }
  function showPreview() {
    setPreviewData(latestData.current);
    setPreviewOpen(true);
  }
  function showChecks() {
    setChecks(runPageChecks(latestData.current, metaForm.getFieldsValue()));
    setChecksOpen(true);
  }

  return <div className="editor-shell">
    <Card size="small" title="页面设置" style={{ marginBottom: 12 }}>
      <Form<PageMeta> form={metaForm} layout="vertical" initialValues={{ title: page.title, slug: page.slug, seo_title: page.seo_title, seo_description: page.seo_description, seo_keywords: page.seo_keywords, og_image: page.og_image, noindex: page.noindex === 1 }} onValuesChange={() => { revision.current += 1; setDirty(true); scheduleAutosave(latestData.current); }} onFinish={async (values) => { await persist(latestData.current, values); message.success("页面设置已保存"); }}>
        <div className="page-meta-grid">
          <Form.Item name="title" label="标题" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="slug" label="Slug" rules={[{ required: true, pattern: /^[a-z0-9-/]+$/ }]}><Input /></Form.Item>
          <Form.Item name="seo_title" label="SEO 标题" extra="留空时使用页面标题"><Input /></Form.Item>
          <Form.Item name="seo_description" label="SEO 描述" extra="建议 80-160 个字符，会展示在搜索结果摘要中"><Input /></Form.Item>
          <Form.Item name="seo_keywords" label="SEO 关键词" extra="英文逗号分隔，留空使用全站默认关键词"><Input placeholder="SaaS, 在线购买" /></Form.Item>
          <Form.Item name="og_image" label="OG 分享图 URL"><Input placeholder="可从素材库复制图片地址" /></Form.Item>
          <Form.Item name="noindex" label="禁止搜索引擎收录" valuePropName="checked" extra="勾选后该页面输出 noindex，且不进入站点地图"><Switch /></Form.Item>
        </div>
        <Space><Button htmlType="submit" loading={saving}>保存页面设置</Button><Button onClick={() => void persist(latestData.current, undefined, true)} loading={saving}>保存版本</Button></Space>
      </Form>
    </Card>
    <div className="editor-hint">编辑内容会在停止操作约 1.2 秒后自动保存。顶部工具栏可以预览草稿、查看版本和进行发布前检查；真正上线请回到页面列表点击“发布”。</div>
    <Puck
      config={pageConfig}
      data={initial}
      metadata={{ assets: page.assets }}
      viewports={[{ width: "100%", height: "auto", label: "桌面" }, { width: 768, height: "auto", label: "平板" }, { width: 375, height: "auto", label: "手机" }]}
      iframe={{ enabled: true, syncHostStyles: true }}
      headerTitle={page.title}
      renderHeaderActions={() => <Space>
        <span className="editor-save-state">{saving ? "保存中…" : dirty ? "有未保存更改" : lastSavedAt ? `已保存 ${lastSavedAt.toLocaleTimeString()}` : "已加载"}</span>
        <Button size="small" onClick={() => void persist(latestData.current)} loading={saving}>保存草稿</Button>
        <Button size="small" onClick={() => void persist(latestData.current, undefined, true)} loading={saving}>保存版本</Button>
        <Button size="small" onClick={showPreview}>预览草稿</Button>
        <Button size="small" onClick={() => void loadVersions()}>版本历史</Button>
        <Button size="small" onClick={showChecks}>发布前检查</Button>
      </Space>}
      onChange={(data) => { latestData.current = data; revision.current += 1; setDirty(true); scheduleAutosave(data); }}
      onPublish={async (data) => { latestData.current = data; revision.current += 1; await persist(data); }}
    />

    <Modal title="草稿预览" open={previewOpen} width="92vw" footer={null} onCancel={() => setPreviewOpen(false)}>
      <Space style={{ marginBottom: 12 }}><span>预览尺寸</span><Select value={previewMode} onChange={setPreviewMode} options={[{ value: "desktop", label: "桌面" }, { value: "tablet", label: "平板" }, { value: "mobile", label: "手机" }]} /></Space>
      <div className={`draft-preview draft-preview-${previewMode}`}><Render config={pageConfig} data={previewData} metadata={{ assets: page.assets }} /></div>
    </Modal>
    <Modal title="版本历史" open={versionsOpen} width={760} footer={null} onCancel={() => setVersionsOpen(false)}>
      <Table rowKey="id" size="small" dataSource={versions} pagination={{ pageSize: 8 }} columns={[{ title: "版本", dataIndex: "version", render: (value: number) => `v${value}` }, { title: "页面标题", dataIndex: "title" }, { title: "保存时间", dataIndex: "created_at" }, { title: "操作", render: (_: unknown, row: VersionRow) => <Popconfirm title={`恢复 v${row.version}？`} description="当前草稿会被替换，但不会直接上线。" onConfirm={() => void restoreVersion(row.version)}><Button type="link">恢复到此版本</Button></Popconfirm> }]} />
    </Modal>
    <Modal title="发布前检查" open={checksOpen} footer={<Button onClick={() => setChecksOpen(false)}>关闭</Button>} onCancel={() => setChecksOpen(false)}>
      <Space direction="vertical" style={{ width: "100%" }}>{checks.map((item, index) => <Alert key={`${item.text}-${index}`} type={item.level === "success" ? "success" : item.level === "warning" ? "warning" : "error"} message={item.text} showIcon />)}</Space>
    </Modal>
  </div>;
}

function cloneData(data: Data): Data {
  return JSON.parse(JSON.stringify(data)) as Data;
}

function runPageChecks(data: Data, meta: Partial<PageMeta>): CheckItem[] {
  const results: CheckItem[] = [];
  const content = Array.isArray(data.content) ? data.content : [];
  if (!meta.title?.trim()) results.push({ level: "error", text: "页面标题为空。" });
  if (!meta.seo_title?.trim()) results.push({ level: "warning", text: "建议填写 SEO 标题。" });
  if (!meta.seo_description?.trim()) results.push({ level: "warning", text: "建议填写 SEO 描述。" });
  else if ((meta.seo_description?.trim().length ?? 0) > 160) results.push({ level: "warning", text: "SEO 描述超过 160 个字符，搜索结果中可能被截断。" });
  if (meta.noindex) results.push({ level: "warning", text: "该页面已开启“禁止收录”，发布后不会出现在站点地图和搜索结果中。" });
  if (content.length === 0) results.push({ level: "error", text: "页面没有内容区块。" });
  let imageCount = 0;
  let textLength = 0;
  content.forEach((block) => {
    const value = block as { type?: string; props?: Record<string, unknown> };
    const props = value.props ?? {};
    textLength += Object.values(props).filter((item) => typeof item === "string").reduce((total, item) => total + String(item).length, 0);
    if (value.type === "Hero" && !String(props.title ?? "").trim()) results.push({ level: "error", text: "Hero 区块缺少主标题。" });
    if (value.type === "Image") {
      imageCount += 1;
      if ((props.image_url || props.asset_id) && !String(props.image_alt ?? "").trim()) results.push({ level: "error", text: "图片区块缺少替代文字。" });
    }
    ["buttonHref", "video_url", "image_url", "src"].forEach((key) => { if (/^javascript:/i.test(String(props[key] ?? ""))) results.push({ level: "error", text: `${value.type ?? "区块"} 包含不安全链接。` }); });
  });
  if (content.length > 0 && textLength < 200) results.push({ level: "warning", text: "页面文字内容较少（不足 200 字），建议补充介绍以提升收录效果。" });
  if (imageCount === 0) results.push({ level: "warning", text: "页面没有图片区块；如有品牌或产品视觉素材，可从素材库绑定。" });
  if (!results.some((item) => item.level === "error")) results.push({ level: "success", text: "未发现阻止发布的基础问题。" });
  return results;
}