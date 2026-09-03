import { useEffect, useState } from "react";
import { Card, Col, Row, Statistic, Table, Typography } from "antd";
import { api, money } from "../shared/api";

type Data = { stats: { orders: number; revenue_cents: number; products: number; pages: number }; recent_orders: Array<Record<string, unknown>> };
export function Dashboard() {
  const [data, setData] = useState<Data | null>(null);
  useEffect(() => { api<{ ok: true } & Data>("/api/admin/dashboard").then(setData); }, []);
  return <><Typography.Title level={3}>仪表盘</Typography.Title><Row gutter={[16,16]}><Col xs={24} md={6}><Card><Statistic title="订单数" value={data?.stats.orders ?? 0} /></Card></Col><Col xs={24} md={6}><Card><Statistic title="累计收入" value={money(data?.stats.revenue_cents ?? 0)} /></Card></Col><Col xs={24} md={6}><Card><Statistic title="在售产品" value={data?.stats.products ?? 0} /></Card></Col><Col xs={24} md={6}><Card><Statistic title="已发布页面" value={data?.stats.pages ?? 0} /></Card></Col></Row><Card title="最近订单" style={{ marginTop: 16 }}><Table rowKey="order_no" pagination={false} dataSource={data?.recent_orders ?? []} columns={[{ title: "订单号", dataIndex: "order_no" },{ title: "产品", dataIndex: "product_name" },{ title: "套餐", dataIndex: "plan_name" },{ title: "金额", dataIndex: "amount_cents", render: (v:number) => money(v) },{ title: "状态", dataIndex: "status" },{ title: "时间", dataIndex: "created_at" }]} /></Card></>;
}
