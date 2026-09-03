import { useEffect, useState } from "react";
import { Button, Space, Table, Tag, Typography, message } from "antd";
import { api } from "../shared/api";

type Delivery = {
  id: string;
  event_id: string;
  event_type: string;
  request_url: string;
  response_status: number | null;
  response_body?: string;
  status: string;
  attempts: number;
  created_at: string;
};

export function Webhooks() {
  const [rows, setRows] = useState<Delivery[]>([]);
  const [retrying, setRetrying] = useState<string | null>(null);
  const load = () => api<{ deliveries: Delivery[] }>("/api/admin/webhook/deliveries").then((r) => setRows(r.deliveries));
  useEffect(() => { void load(); }, []);

  async function retry(id: string) {
    setRetrying(id);
    try {
      await api(`/api/admin/webhook/deliveries/${id}/retry`, { method: "POST" });
      message.success("事件已重新进入投递队列");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重新投递失败");
    } finally {
      setRetrying(null);
    }
  }

  return <>
    <Space style={{ width: "100%", justifyContent: "space-between" }}>
      <Typography.Title level={3}>Webhook 投递日志</Typography.Title>
      <Button onClick={load}>刷新</Button>
    </Space>
    <Table
      rowKey="id"
      dataSource={rows}
      scroll={{ x: 1100 }}
      expandable={{ expandedRowRender: (row) => <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{row.response_body || "无响应内容"}</pre> }}
      columns={[
        { title: "事件", dataIndex: "event_type" },
        { title: "Event ID", dataIndex: "event_id" },
        { title: "URL", dataIndex: "request_url", ellipsis: true },
        { title: "HTTP", dataIndex: "response_status", width: 80 },
        { title: "状态", dataIndex: "status", width: 90, render: (v: string) => <Tag color={v === "success" ? "green" : "red"}>{v}</Tag> },
        { title: "尝试", dataIndex: "attempts", width: 70 },
        { title: "时间", dataIndex: "created_at", width: 180 },
        { title: "操作", width: 110, render: (_: unknown, row: Delivery) => <Button type="link" loading={retrying === row.id} onClick={() => retry(row.id)}>重新发送</Button> },
      ]}
    />
  </>;
}
