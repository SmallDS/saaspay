import { useState } from "react";
import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { api } from "../shared/api";

export function Login({ onSuccess }: { onSuccess: () => void }) {
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  return <div className="login-shell"><Card className="login-card"><Typography.Title level={2}>SaaS Store 后台</Typography.Title><Typography.Paragraph type="secondary">使用部署时设置的管理员账号和密码登录。</Typography.Paragraph>{error && <Alert type="error" message={error} showIcon style={{ marginBottom: 16 }} />}<Form layout="vertical" onFinish={async (values) => { setLoading(true); setError(""); try { await api("/api/admin/login", { method: "POST", body: JSON.stringify(values) }); onSuccess(); } catch (e) { setError(e instanceof Error ? e.message : "登录失败"); } finally { setLoading(false); } }}><Form.Item name="username" label="管理员账号" rules={[{ required: true }]}><Input autoComplete="username" /></Form.Item><Form.Item name="password" label="管理员密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Button type="primary" htmlType="submit" block size="large" loading={loading}>登录</Button></Form></Card></div>;
}
