import { useEffect, useState } from "react";
import { Button, Descriptions, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import { api, money } from "../shared/api";

type OrderStatus = "pending" | "paid" | "closed" | "refunded";
type BatchAction = "query" | "close" | "delete" | "force-delete";

const forceDeleteWarning = "将永久删除本系统中的订单和关联退款记录，无法恢复。这不会关闭微信或支付宝交易，也不会退款；删除后本系统无法继续处理该订单的支付或退款通知。";

type Order = {
  id: string;
  order_no: string;
  product_name: string;
  plan_name: string;
  amount_cents: number;
  refunded_cents: number;
  status: OrderStatus;
  payment_provider?: string;
  transaction_id?: string | null;
  alipay_trade_no?: string | null;
  created_at: string;
  paid_at?: string | null;
  closed_at?: string | null;
  metadata_json?: string | null;
};

type Refund = {
  id: string;
  order_no: string;
  amount_cents: number;
  reason: string;
  out_request_no: string;
  status: "processing" | "success" | "failed";
  alipay_refund_no?: string | null;
  response_message?: string | null;
  created_at: string;
  completed_at?: string | null;
};

type BatchResult = {
  order_no: string;
  ok: boolean;
  message: string;
};

const statusLabels: Record<OrderStatus, string> = {
  pending: "待支付",
  paid: "已支付",
  closed: "已关闭",
  refunded: "已退款",
};

function providerLabel(provider?: string): string {
  if (provider === "wechat") return "微信支付";
  if (provider === "alipay") return "支付宝";
  return "免费/其他";
}

function tradeNoOf(order: Order): string {
  return order.transaction_id || order.alipay_trade_no || "";
}

const refundStatusLabels: Record<Refund["status"], string> = {
  processing: "处理中",
  success: "已完成",
  failed: "失败",
};

function remainingCents(order: Order): number {
  return Math.max(order.amount_cents - (order.refunded_cents ?? 0), 0);
}

function canDelete(order: Order): boolean {
  return order.status === "closed"
    || order.status === "refunded"
    || (order.status === "paid" && order.amount_cents === 0 && (order.refunded_cents ?? 0) === 0);
}

type OrderContact = {
  name: string;
  info: string;
  type: string;
};

function readOrderContact(order: Order): OrderContact {
  try {
    const metadata = JSON.parse(order.metadata_json ?? "{}") as Record<string, unknown>;
    return {
      name: typeof metadata.contact_name === "string" ? metadata.contact_name.trim() : "",
      info: typeof metadata.contact_info === "string" ? metadata.contact_info.trim() : "",
      type: typeof metadata.contact_type === "string" ? metadata.contact_type.trim() : "",
    };
  } catch {
    return { name: "", info: "", type: "" };
  }
}

export function Orders() {
  const [orders, setOrders] = useState<Order[]>([]);
  const [status, setStatus] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [selectedOrderNos, setSelectedOrderNos] = useState<string[]>([]);
  const [batchLoading, setBatchLoading] = useState<BatchAction | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [detailOrder, setDetailOrder] = useState<Order | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [refundOrder, setRefundOrder] = useState<Order | null>(null);
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundLoading, setRefundLoading] = useState(false);
  const [refundsOrder, setRefundsOrder] = useState<Order | null>(null);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [refundsOpen, setRefundsOpen] = useState(false);
  const [refundsLoading, setRefundsLoading] = useState(false);
  const [refundForm] = Form.useForm<{ amount_yuan?: number; reason?: string }>();

  async function load() {
    setLoading(true);
    try {
      const query = status ? "?status=" + encodeURIComponent(status) : "";
      const data = await api<{ orders: Order[] }>("/api/admin/orders" + query);
      setOrders(data.orders);
      setSelectedOrderNos((selected) => selected.filter((orderNo) => data.orders.some((order) => order.order_no === orderNo)));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "订单加载失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, [status]);

  async function orderAction(order: Order, action: "query" | "close") {
    const key = action + ":" + order.id;
    setActionLoading(key);
    try {
      const data = await api<{ provider_ok?: boolean; message?: string }>(
        "/api/admin/orders/" + encodeURIComponent(order.order_no) + "/" + action,
        { method: "POST" },
      );
      if (data.provider_ok === false) message.warning(data.message ?? "支付渠道暂未确认交易");
      else message.success(data.message ?? (action === "query" ? "订单已同步" : "订单已关闭"));
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "订单操作失败");
    } finally {
      setActionLoading(null);
    }
  }

  async function runBatchAction(action: BatchAction, orderNos = selectedOrderNos) {
    if (orderNos.length === 0) {
      message.warning("请先选择订单");
      return;
    }
    setBatchLoading(action);
    try {
      const data = await api<{ succeeded: number; failed: number; results: BatchResult[] }>(
        "/api/admin/orders/batch",
        {
          method: "POST",
          body: JSON.stringify({ action, order_nos: orderNos }),
        },
      );
      const actionLabel = action === "query" ? "查询" : action === "close" ? "关闭" : action === "force-delete" ? "强制删除" : "删除";
      if (data.failed > 0) message.warning("批量" + actionLabel + "完成：成功 " + data.succeeded + " 条，失败 " + data.failed + " 条");
      else message.success("批量" + actionLabel + "成功，共 " + data.succeeded + " 条");
      const failedOrderNos = data.results.filter((result) => !result.ok).map((result) => result.order_no);
      await load();
      setSelectedOrderNos(failedOrderNos);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "批量操作失败");
    } finally {
      setBatchLoading(null);
    }
  }

  function confirmBatchDelete(force = false) {
    if (selectedOrderNos.length === 0) {
      message.warning("请先选择订单");
      return;
    }
    const orderNos = [...selectedOrderNos];
    Modal.confirm({
      title: force ? `确认强制删除选中的 ${orderNos.length} 条订单？` : "确认批量删除订单？",
      content: force ? forceDeleteWarning : "仅已关闭或已全额退款的订单可以删除；已支付未全额退款的订单会被逐条保留。",
      okText: force ? "强制删除" : "批量删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => runBatchAction(force ? "force-delete" : "delete", orderNos),
    });
  }

  async function deleteOrder(order: Order, force = false) {
    const key = (force ? "force-delete:" : "delete:") + order.id;
    setActionLoading(key);
    try {
      await api("/api/admin/orders/" + encodeURIComponent(order.order_no) + (force ? "/force-delete" : ""), { method: force ? "POST" : "DELETE" });
      message.success(force ? "订单已强制删除" : "订单已删除");
      setSelectedOrderNos((selected) => selected.filter((orderNo) => orderNo !== order.order_no));
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除订单失败");
    } finally {
      setActionLoading(null);
    }
  }

  function confirmDelete(order: Order, force = false) {
    Modal.confirm({
      title: force ? "确认强制删除订单？" : "确认删除订单？",
      content: force ? <><Typography.Paragraph style={{ overflowWrap: "anywhere" }}>订单号：{order.order_no}</Typography.Paragraph><Typography.Paragraph>{forceDeleteWarning}</Typography.Paragraph></> : "删除后订单和关联退款记录将不再出现在后台，且无法恢复。",
      okText: force ? "强制删除" : "删除",
      cancelText: "取消",
      okButtonProps: { danger: true },
      onOk: () => deleteOrder(order, force),
    });
  }

  function openRefund(order: Order) {
    setRefundOrder(order);
    refundForm.setFieldsValue({ amount_yuan: remainingCents(order) / 100, reason: "" });
    setRefundOpen(true);
  }

  async function submitRefund(values: { amount_yuan?: number; reason?: string }) {
    if (!refundOrder) return;
    const amountCents = Math.round(Number(values.amount_yuan ?? 0) * 100);
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      message.error("请输入有效的退款金额");
      return;
    }
    setRefundLoading(true);
    try {
      const data = await api<{ pending?: boolean; message?: string }>(
        "/api/admin/orders/" + encodeURIComponent(refundOrder.order_no) + "/refunds",
        {
          method: "POST",
          body: JSON.stringify({ amount_cents: amountCents, reason: values.reason?.trim() ?? "" }),
        },
      );
      if (data.pending) message.info(data.message ?? "退款处理中，请稍后查询");
      else message.success(data.message ?? "退款已完成");
      setRefundOpen(false);
      refundForm.resetFields();
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "退款失败");
    } finally {
      setRefundLoading(false);
    }
  }

  async function openRefunds(order: Order) {
    setRefundsOrder(order);
    setRefunds([]);
    setRefundsOpen(true);
    setRefundsLoading(true);
    try {
      const data = await api<{ refunds: Refund[] }>(
        "/api/admin/orders/" + encodeURIComponent(order.order_no) + "/refunds",
      );
      setRefunds(data.refunds);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "退款记录加载失败");
    } finally {
      setRefundsLoading(false);
    }
  }

  async function queryRefund(refund: Refund) {
    setActionLoading("refund:" + refund.id);
    try {
      const data = await api<{ pending: boolean; message?: string }>(
        "/api/admin/refunds/" + encodeURIComponent(refund.id) + "/query",
        { method: "POST" },
      );
      if (data.pending) message.info(data.message ?? "退款仍在处理中");
      else message.success(data.message ?? "退款已确认");
      if (refundsOrder) await openRefunds(refundsOrder);
      await load();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "退款查询失败");
    } finally {
      setActionLoading(null);
    }
  }

  function renderStatus(value: OrderStatus, order: Order) {
    const label = value === "paid" && order.refunded_cents > 0 ? "部分退款" : statusLabels[value] ?? value;
    const color = value === "paid" ? (order.refunded_cents > 0 ? "blue" : "green") : value === "pending" ? "gold" : "default";
    return <Tag color={color}>{label}</Tag>;
  }

  const detailContact = detailOrder ? readOrderContact(detailOrder) : null;

  return <>
    <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 16 }}>
      <Typography.Title level={3} style={{ margin: 0 }}>订单</Typography.Title>
      <Space wrap>
        <Select allowClear placeholder="全部状态" style={{ width: 160 }} onChange={setStatus} options={Object.entries(statusLabels).map(([value, label]) => ({ label, value }))} />
        <Button onClick={() => void load()} loading={loading}>刷新</Button>
      </Space>
    </Space>

    <Space wrap style={{ marginBottom: 16 }}>
      <Typography.Text type="secondary">已选 {selectedOrderNos.length} 条</Typography.Text>
      <Button disabled={selectedOrderNos.length === 0} loading={batchLoading === "query"} onClick={() => void runBatchAction("query")}>批量同步状态</Button>
      <Button disabled={selectedOrderNos.length === 0} loading={batchLoading === "close"} onClick={() => void runBatchAction("close")}>批量关闭</Button>
      <Button danger disabled={selectedOrderNos.length === 0 || batchLoading !== null} loading={batchLoading === "delete"} onClick={() => confirmBatchDelete()}>批量删除</Button>
      <Button danger disabled={selectedOrderNos.length === 0 || batchLoading !== null} loading={batchLoading === "force-delete"} onClick={() => confirmBatchDelete(true)}>批量强制删除</Button>
      {selectedOrderNos.length > 0 && <Button type="link" onClick={() => setSelectedOrderNos([])}>清除选择</Button>}
    </Space>

    <Table
      rowKey="order_no"
      rowSelection={{
        selectedRowKeys: selectedOrderNos,
        onChange: (keys) => setSelectedOrderNos(keys.map(String)),
      }}
      loading={loading}
      dataSource={orders}
      scroll={{ x: 1650 }}
      columns={[
        { title: "订单号", dataIndex: "order_no", width: 250 },
        { title: "产品", dataIndex: "product_name" },
        { title: "套餐", dataIndex: "plan_name" },
        {
          title: "联系人",
          width: 190,
          render: (_value: unknown, order: Order) => {
            const contact = readOrderContact(order);
            return <div>
              <div>{contact.name || "未填写"}</div>
              <Typography.Text type="secondary">{contact.info || "未填写"}</Typography.Text>
            </div>;
          },
        },        { title: "渠道", dataIndex: "payment_provider", width: 100, render: (_value: unknown, order: Order) => <Tag>{providerLabel(order.payment_provider)}</Tag> },
        { title: "订单金额", dataIndex: "amount_cents", render: (value: number) => money(value) },
        { title: "已退款", dataIndex: "refunded_cents", render: (value: number) => money(value ?? 0) },
        { title: "状态", dataIndex: "status", render: (value: OrderStatus, order: Order) => renderStatus(value, order) },
        { title: "渠道交易号", key: "trade_no", ellipsis: true, render: (_value: unknown, order: Order) => tradeNoOf(order) || "—" },
        { title: "创建时间", dataIndex: "created_at" },
        { title: "支付时间", dataIndex: "paid_at" },
        { title: "关闭时间", dataIndex: "closed_at" },
        {
          title: "操作",
          fixed: "right",
          width: 400,
          render: (_value: unknown, order: Order) => {
            const remaining = remainingCents(order);
            const queryKey = "query:" + order.id;
            const closeKey = "close:" + order.id;
            const deleteKey = "delete:" + order.id;
            return <Space size={0} wrap>
              <Button type="link" size="small" onClick={() => { setDetailOrder(order); setDetailOpen(true); }}>详情</Button>
              <Button type="link" size="small" loading={actionLoading === queryKey} onClick={() => void orderAction(order, "query")}>同步状态</Button>
              {order.status === "pending" && <Button type="link" danger size="small" loading={actionLoading === closeKey} onClick={() => {
                Modal.confirm({
                  title: "确认关闭订单？",
                  content: "关闭后该订单不能继续支付。",
                  okText: "关闭订单",
                  cancelText: "取消",
                  onOk: () => orderAction(order, "close"),
                });
              }}>关闭</Button>}
              {order.status === "paid" && remaining > 0 && <Button type="link" size="small" onClick={() => openRefund(order)}>退款</Button>}
              {order.refunded_cents > 0 && <Button type="link" size="small" onClick={() => void openRefunds(order)}>退款记录</Button>}
              {canDelete(order) && <Button type="link" danger size="small" loading={actionLoading === deleteKey} onClick={() => confirmDelete(order)}>删除</Button>}
              <Button type="link" danger size="small" disabled={actionLoading !== null || batchLoading !== null} loading={actionLoading === "force-delete:" + order.id} onClick={() => confirmDelete(order, true)}>强制删除</Button>
            </Space>;
          },
        },
      ]}
    />

    <Modal
      open={detailOpen}
      title={"订单详情：" + (detailOrder?.order_no ?? "")}
      onCancel={() => setDetailOpen(false)}
      footer={<Button onClick={() => setDetailOpen(false)}>关闭</Button>}
      width={720}
    >
      {detailOrder ? <Descriptions bordered size="small" column={1}>
        <Descriptions.Item label="订单号">{detailOrder.order_no}</Descriptions.Item>
        <Descriptions.Item label="产品 / 套餐">{detailOrder.product_name} / {detailOrder.plan_name}</Descriptions.Item>
        <Descriptions.Item label="订单金额">{money(detailOrder.amount_cents)}</Descriptions.Item>
        <Descriptions.Item label="已退款">{money(detailOrder.refunded_cents ?? 0)}</Descriptions.Item>
        <Descriptions.Item label="支付渠道">{providerLabel(detailOrder.payment_provider)}</Descriptions.Item>
        <Descriptions.Item label="订单状态">{renderStatus(detailOrder.status, detailOrder)}</Descriptions.Item>
        <Descriptions.Item label="联系人">{detailContact?.name || "未填写"}</Descriptions.Item>
        <Descriptions.Item label="联系方式">{detailContact?.info || "未填写"}</Descriptions.Item>
        <Descriptions.Item label="联系方式类型">{detailContact?.type === "phone" ? "手机号" : detailContact?.type === "email" ? "邮箱" : (detailContact?.type || "未填写")}</Descriptions.Item>
        <Descriptions.Item label="渠道交易号">{tradeNoOf(detailOrder) || "暂无"}</Descriptions.Item>
        <Descriptions.Item label="创建时间">{detailOrder.created_at}</Descriptions.Item>
        <Descriptions.Item label="支付时间">{detailOrder.paid_at || "暂无"}</Descriptions.Item>
        <Descriptions.Item label="关闭时间">{detailOrder.closed_at || "暂无"}</Descriptions.Item>
      </Descriptions> : null}
    </Modal>

    <Modal
      open={refundOpen}
      title={"退款：" + (refundOrder?.order_no ?? "")}
      onCancel={() => setRefundOpen(false)}
      onOk={() => void refundForm.submit()}
      confirmLoading={refundLoading}
      okText="提交退款"
      cancelText="取消"
      destroyOnHidden
    >
      <Form form={refundForm} layout="vertical" onFinish={(values) => void submitRefund(values)}>
        <Form.Item
          name="amount_yuan"
          label={"退款金额（可退 " + money(refundOrder ? remainingCents(refundOrder) : 0) + "）"}
          rules={[{ required: true, message: "请输入退款金额" }, { type: "number", min: 0.01, message: "退款金额必须大于 0" }]}
        >
          <InputNumber min={0.01} precision={2} style={{ width: "100%" }} addonAfter="元" />
        </Form.Item>
        <Form.Item name="reason" label="退款原因">
          <Input.TextArea maxLength={256} showCount rows={3} placeholder="可选" />
        </Form.Item>
      </Form>
    </Modal>

    <Modal
      open={refundsOpen}
      title={"退款记录：" + (refundsOrder?.order_no ?? "")}
      onCancel={() => setRefundsOpen(false)}
      footer={null}
      width={900}
    >
      <Table
        rowKey="id"
        loading={refundsLoading}
        dataSource={refunds}
        pagination={false}
        scroll={{ x: 800 }}
        columns={[
          { title: "退款金额", dataIndex: "amount_cents", render: (value: number) => money(value) },
          { title: "状态", dataIndex: "status", render: (value: Refund["status"]) => <Tag color={value === "success" ? "green" : value === "processing" ? "gold" : "red"}>{refundStatusLabels[value] ?? value}</Tag> },
          { title: "退款原因", dataIndex: "reason", ellipsis: true },
          { title: "请求号", dataIndex: "out_request_no", ellipsis: true },
          { title: "时间", dataIndex: "created_at" },
          {
            title: "操作",
            render: (_value: unknown, refund: Refund) => refund.status === "processing"
              ? <Button type="link" size="small" loading={actionLoading === "refund:" + refund.id} onClick={() => void queryRefund(refund)}>查询结果</Button>
              : refund.response_message ?? "",
          },
        ]}
      />
    </Modal>
  </>;
}
