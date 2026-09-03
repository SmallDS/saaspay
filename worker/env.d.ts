// 部署时由 `wrangler secret put` / CI 的 scripts/ci/ensure-secrets.mjs 写入的 Secrets。
// 不放在 wrangler.jsonc 的 secrets.required 中，以便 CI 首次部署（创建 Worker）先于 Secret 写入完成。
interface Env {
  ADMIN_USERNAME: string;
  ADMIN_PASSWORD: string;
  SETTINGS_ENCRYPTION_KEY: string;
}
