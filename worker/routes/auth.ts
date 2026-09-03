import { assertSameOrigin, clearAdminSessionCookie, createAdminSessionCookie, isAdmin, verifyAdminCredentials } from "../auth/session";
import { bad, bodyJson, json } from "../http";

export async function handleAuth(request: Request, env: Env, pathname: string): Promise<Response | null> {
  if (pathname === "/api/admin/login" && request.method === "POST") {
    if (!assertSameOrigin(request)) return bad("请求来源校验失败", 403);
    const input = await bodyJson<{ username?: string; password?: string }>(request);
    if (!input.username || !input.password) return bad("请输入管理员账号和密码");
    if (!(await verifyAdminCredentials(env, input.username, input.password))) return bad("管理员账号或密码错误", 401);
    const response = json({ ok: true, user: { username: env.ADMIN_USERNAME } });
    response.headers.append("Set-Cookie", await createAdminSessionCookie(env));
    return response;
  }
  if (pathname === "/api/admin/logout" && request.method === "POST") {
    const response = json({ ok: true });
    response.headers.append("Set-Cookie", clearAdminSessionCookie());
    return response;
  }
  if (pathname === "/api/admin/me" && request.method === "GET") {
    if (!(await isAdmin(request, env))) return bad("未登录", 401);
    return json({ ok: true, user: { username: env.ADMIN_USERNAME } });
  }
  return null;
}
