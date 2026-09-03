// CI 部署辅助：确保 Worker 的管理员凭据与配置加密密钥已写入 Cloudflare Secrets。
//
// - ADMIN_USERNAME / ADMIN_PASSWORD 来自 GitHub Secrets，每次运行都重新上传，修改后即时生效。
// - SETTINGS_ENCRYPTION_KEY 仅在远端不存在时生成一次并上传；已存在则沿用，
//   因为该密钥用于 AES-GCM 解密后台已保存的支付宝/微信/Webhook 敏感配置，轮换会导致无法解密。
//
// 需要的环境变量：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、ADMIN_USERNAME、ADMIN_PASSWORD
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const wranglerCommand = process.platform === "win32" ? "npx.cmd" : "npx";

function capture(args) {
  return spawnSync(wranglerCommand, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
}

function remoteSecretNames() {
  const result = capture(["wrangler", "secret", "list", "--format", "json"]);
  if (result.status !== 0) {
    console.error("无法查询 Worker Secret 列表：" + (result.stderr || result.stdout || ""));
    process.exit(result.status ?? 1);
  }
  try {
    const secrets = JSON.parse(result.stdout || "[]");
    return new Set(secrets.map((item) => item?.name).filter(Boolean));
  } catch {
    console.error("无法解析 Worker Secret 列表。");
    process.exit(1);
  }
}

function putSecret(name, value) {
  const result = spawnSync(wranglerCommand, ["wrangler", "secret", "put", name], {
    input: value + "\n",
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.status !== 0) {
    console.error(`写入 Secret ${name} 失败：` + (result.stderr || result.stdout || ""));
    process.exit(result.status ?? 1);
  }
  console.log(`Secret ${name} 已上传。`);
}

const username = process.env.ADMIN_USERNAME?.trim();
const password = process.env.ADMIN_PASSWORD;
if (!username || !password) {
  console.error("缺少 ADMIN_USERNAME / ADMIN_PASSWORD，请先在 GitHub 仓库的 Settings → Secrets and variables → Actions 中配置。");
  process.exit(1);
}

const existing = remoteSecretNames();
putSecret("ADMIN_USERNAME", username);
putSecret("ADMIN_PASSWORD", password);
if (!existing.has("SETTINGS_ENCRYPTION_KEY")) {
  const generated = process.env.SETTINGS_ENCRYPTION_KEY?.trim() || randomBytes(32).toString("base64");
  putSecret("SETTINGS_ENCRYPTION_KEY", generated);
  console.log("SETTINGS_ENCRYPTION_KEY 已首次生成并上传；后续部署会自动沿用，请勿手动轮换。");
} else {
  console.log("SETTINGS_ENCRYPTION_KEY 已存在，沿用现有密钥。");
}
