import { decryptSecret, encryptSecret } from "../crypto/secrets";

export async function getSetting(env: Env, key: string): Promise<{ value: string; encrypted: boolean } | null> {
  const row = await env.DB.prepare("SELECT value, encrypted FROM settings WHERE key = ?").bind(key).first<{ value: string; encrypted: number }>();
  if (!row) return null;
  return { value: row.value, encrypted: row.encrypted === 1 };
}

export async function getSettingValue(env: Env, key: string, fallback = ""): Promise<string> {
  const item = await getSetting(env, key);
  if (!item) return fallback;
  if (!item.encrypted) return item.value;
  return decryptSecret(env, item.value);
}

export async function setSetting(env: Env, key: string, value: string, encrypted = false): Promise<void> {
  const stored = encrypted ? await encryptSecret(env, value) : value;
  await env.DB.prepare(
    `INSERT INTO settings(key, value, encrypted, updated_at)
     VALUES(?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=excluded.encrypted, updated_at=CURRENT_TIMESTAMP`,
  ).bind(key, stored, encrypted ? 1 : 0).run();
}

export async function listSettings(env: Env, prefix?: string): Promise<Record<string, { value: string; encrypted: boolean }>> {
  const query = prefix
    ? env.DB.prepare("SELECT key, value, encrypted FROM settings WHERE key LIKE ? ORDER BY key").bind(`${prefix}%`)
    : env.DB.prepare("SELECT key, value, encrypted FROM settings ORDER BY key");
  const { results } = await query.all<{ key: string; value: string; encrypted: number }>();
  return Object.fromEntries(results.map((row) => [row.key, { value: row.value, encrypted: row.encrypted === 1 }]));
}
