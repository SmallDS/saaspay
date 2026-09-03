import { useEffect, useMemo, useState } from "react";
import { Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography, message } from "antd";
import { api, money } from "../shared/api";

type Product = { id: string; name: string; slug: string; summary: string; description: string; status: string; sort_order: number };
type Plan = { id: string; product_id: string; name: string; description: string; amount_cents: number; original_amount_cents?: number | null; billing_label: string; highlighted: number; status: string; sort_order: number };

type ProductForm = { name: string; slug: string; summary?: string; description?: string; status?: string; sort_order?: number };
type PlanForm = { name: string; description?: string; amount_yuan: number; original_amount_yuan?: number | null; billing_label?: string; highlighted?: boolean; status?: string; sort_order?: number };

export function Products() {
  const [products, setProducts] = useState<Product[]>([]);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [productOpen, setProductOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [editingProduct, setEditingProduct] = useState<Product | null>(null);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [selectedProduct, setSelectedProduct] = useState<string>();
  const [productForm] = Form.useForm<ProductForm>();
  const [planForm] = Form.useForm<PlanForm>();

  const load = () => api<{ products: Product[]; plans: Plan[] }>("/api/admin/products").then((data) => {
    setProducts(data.products);
    setPlans(data.plans);
  });
  useEffect(() => { void load(); }, []);
  const grouped = useMemo(() => Object.fromEntries(products.map((product) => [product.id, plans.filter((plan) => plan.product_id === product.id)])), [products, plans]);

  function addProduct() {
    setEditingProduct(null);
    productForm.resetFields();
    productForm.setFieldsValue({ status: "active", sort_order: 0 });
    setProductOpen(true);
  }

  function editProduct(product: Product) {
    setEditingProduct(product);
    productForm.setFieldsValue(product);
    setProductOpen(true);
  }

  function addPlan(productId: string) {
    setSelectedProduct(productId);
    setEditingPlan(null);
    planForm.resetFields();
    planForm.setFieldsValue({ billing_label: "一次性", highlighted: false, status: "active", sort_order: 0 });
    setPlanOpen(true);
  }

  function editPlan(plan: Plan) {
    setSelectedProduct(plan.product_id);
    setEditingPlan(plan);
    planForm.setFieldsValue({
      name: plan.name,
      description: plan.description,
      amount_yuan: plan.amount_cents / 100,
      original_amount_yuan: plan.original_amount_cents == null ? null : plan.original_amount_cents / 100,
      billing_label: plan.billing_label,
      highlighted: Boolean(plan.highlighted),
      status: plan.status,
      sort_order: plan.sort_order,
    });
    setPlanOpen(true);
  }

  async function saveProduct(values: ProductForm) {
    const path = editingProduct ? `/api/admin/products/${editingProduct.id}` : "/api/admin/products";
    await api(path, { method: editingProduct ? "PUT" : "POST", body: JSON.stringify(values) });
    message.success(editingProduct ? "产品已更新" : "产品已创建");
    setProductOpen(false);
    await load();
  }

  async function savePlan(values: PlanForm) {
    const payload = {
      ...values,
      product_id: selectedProduct,
      amount_cents: Math.round(Number(values.amount_yuan) * 100),
      original_amount_cents: values.original_amount_yuan == null || values.original_amount_yuan === 0 ? null : Math.round(Number(values.original_amount_yuan) * 100),
    };
    const path = editingPlan ? `/api/admin/plans/${editingPlan.id}` : "/api/admin/plans";
    await api(path, { method: editingPlan ? "PUT" : "POST", body: JSON.stringify(payload) });
    message.success(editingPlan ? "套餐已更新" : "套餐已创建");
    setPlanOpen(false);
    await load();
  }

  return <>
    <Space style={{ width: "100%", justifyContent: "space-between" }}>
      <Typography.Title level={3}>产品与套餐</Typography.Title>
      <Button type="primary" onClick={addProduct}>新增产品</Button>
    </Space>
    {products.length === 0 ? <Card><Typography.Text type="secondary">还没有产品，先创建一个产品，再为它添加套餐。</Typography.Text></Card> : null}
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      {products.map((product) => <Card
        key={product.id}
        title={<Space>{product.name}<Tag color={product.status === "active" ? "green" : "default"}>{product.status}</Tag></Space>}
        extra={<Space>
          <Button onClick={() => editProduct(product)}>编辑产品</Button>
          <Button type="primary" ghost onClick={() => addPlan(product.id)}>新增套餐</Button>
          <Popconfirm title="删除产品及其套餐？" onConfirm={async () => { await api(`/api/admin/products/${product.id}`, { method: "DELETE" }); await load(); }}><Button danger>删除</Button></Popconfirm>
        </Space>}
      >
        <Typography.Paragraph type="secondary">/{product.slug} · {product.summary || "暂无简介"}</Typography.Paragraph>
        <Table
          rowKey="id"
          pagination={false}
          dataSource={grouped[product.id] ?? []}
          columns={[
            { title: "套餐", dataIndex: "name" },
            { title: "价格", dataIndex: "amount_cents", render: (value: number, row: Plan) => <>{money(value)}{row.original_amount_cents ? <Typography.Text delete type="secondary" style={{ marginLeft: 8 }}>{money(row.original_amount_cents)}</Typography.Text> : null}</> },
            { title: "计费说明", dataIndex: "billing_label" },
            { title: "推荐", dataIndex: "highlighted", render: (value: number) => value ? <Tag color="blue">推荐</Tag> : "-" },
            { title: "状态", dataIndex: "status", render: (value: string) => <Tag color={value === "active" ? "green" : "default"}>{value}</Tag> },
            { title: "操作", render: (_: unknown, row: Plan) => <Space><Button type="link" onClick={() => editPlan(row)}>编辑</Button><Popconfirm title="删除套餐？" onConfirm={async () => { await api(`/api/admin/plans/${row.id}`, { method: "DELETE" }); await load(); }}><Button danger type="link">删除</Button></Popconfirm></Space> },
          ]}
        />
      </Card>)}
    </Space>

    <Modal title={editingProduct ? "编辑产品" : "新增产品"} open={productOpen} onCancel={() => setProductOpen(false)} onOk={() => productForm.submit()}>
      <Form form={productForm} layout="vertical" onFinish={saveProduct}>
        <Form.Item name="name" label="产品名称" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="slug" label="Slug" rules={[{ required: true, pattern: /^[a-z0-9-]+$/ }]}><Input /></Form.Item>
        <Form.Item name="summary" label="一句话介绍"><Input /></Form.Item>
        <Form.Item name="description" label="详细介绍"><Input.TextArea rows={4} /></Form.Item>
        <Space size={16} align="start">
          <Form.Item name="status" label="状态"><Select style={{ width: 140 }} options={[{ value: "active", label: "上架" }, { value: "inactive", label: "下架" }]} /></Form.Item>
          <Form.Item name="sort_order" label="排序"><InputNumber precision={0} /></Form.Item>
        </Space>
      </Form>
    </Modal>

    <Modal title={editingPlan ? "编辑套餐" : "新增套餐"} open={planOpen} onCancel={() => setPlanOpen(false)} onOk={() => planForm.submit()}>
      <Form form={planForm} layout="vertical" onFinish={savePlan}>
        <Form.Item name="name" label="套餐名称" rules={[{ required: true }]}><Input /></Form.Item>
        <Form.Item name="description" label="说明"><Input.TextArea rows={3} /></Form.Item>
        <Space size={16} style={{ width: "100%" }} align="start">
          <Form.Item name="amount_yuan" label="售价（元）" rules={[{ required: true }]} style={{ flex: 1 }}><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
          <Form.Item name="original_amount_yuan" label="原价（元）" style={{ flex: 1 }}><InputNumber min={0} precision={2} style={{ width: "100%" }} /></Form.Item>
        </Space>
        <Form.Item name="billing_label" label="计费说明"><Input placeholder="例如：一次性 / 1年" /></Form.Item>
        <Space size={20} align="start">
          <Form.Item name="highlighted" label="推荐套餐" valuePropName="checked"><Switch /></Form.Item>
          <Form.Item name="status" label="状态"><Select style={{ width: 130 }} options={[{ value: "active", label: "上架" }, { value: "inactive", label: "下架" }]} /></Form.Item>
          <Form.Item name="sort_order" label="排序"><InputNumber precision={0} /></Form.Item>
        </Space>
      </Form>
    </Modal>
  </>;
}
