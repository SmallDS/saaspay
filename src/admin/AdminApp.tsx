import { useEffect, useState } from "react";
import { Button, Layout, Menu, Typography } from "antd";
import { api, ApiError, readApi } from "../shared/api";
import { AuthSkeleton } from "../shared/LoadingStates";
import { LoadError } from "../shared/LoadError";
import { Login } from "./Login";
import { Dashboard } from "./Dashboard";
import { Products } from "./Products";
import { Orders } from "./Orders";
import { Pages } from "./Pages";
import { Assets } from "./Assets";
import { Settings } from "./Settings";
import { Webhooks } from "./Webhooks";

const items=[{key:"dashboard",label:"仪表盘"},{key:"pages",label:"页面"},{key:"products",label:"产品与套餐"},{key:"orders",label:"订单"},{key:"assets",label:"素材库"},{key:"settings",label:"系统设置"},{key:"webhooks",label:"Webhook 日志"}];
export function AdminApp() {
  const [auth, setAuth] = useState<boolean | null>(null);
  const [authError, setAuthError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(location.hash.replace("#", "") || "dashboard");
  useEffect(() => {
    const controller = new AbortController();
    setAuthError("");
    void readApi("/api/admin/me", controller.signal).then(() => {
      if (!controller.signal.aborted) setAuth(true);
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) setAuth(false);
      else setAuthError(error instanceof Error ? error.message : "登录状态检查失败");
    });
    return () => controller.abort();
  }, [attempt]);
  if (auth === null) return authError ? <LoadError message={authError} onRetry={() => setAttempt((value) => value + 1)} /> : <AuthSkeleton />;
  if (!auth) return <Login onSuccess={() => setAuth(true)} />;
  const body = page === "pages" ? <Pages /> : page === "products" ? <Products /> : page === "orders" ? <Orders /> : page === "assets" ? <Assets /> : page === "settings" ? <Settings /> : page === "webhooks" ? <Webhooks /> : <Dashboard />;
  return <Layout className="admin-layout"><Layout.Sider width={220} theme="light" breakpoint="lg" collapsedWidth="0"><div className="admin-brand"><Typography.Title level={4} style={{ margin: 0 }}>SaaS Store</Typography.Title></div><Menu mode="inline" selectedKeys={[page]} items={items} onClick={({ key }) => { location.hash = key; setPage(key); }} /><div className="admin-logout"><Button block onClick={async () => { await api("/api/admin/logout", { method: "POST" }); setAuth(false); }}>退出登录</Button></div></Layout.Sider><Layout><Layout.Header className="admin-header">管理后台</Layout.Header><Layout.Content className="admin-content">{body}</Layout.Content></Layout></Layout>;
}
