import { base64ToBytes, bytesToBase64, toBytes } from "./base64";

async function deriveMaterial(env: Env, purpose: string): Promise<CryptoKey> {
  if (!env.SETTINGS_ENCRYPTION_KEY) throw new Error("SETTINGS_ENCRYPTION_KEY is not configured");
  const base = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(env.SETTINGS_ENCRYPTION_KEY),
    "HKDF",
    false,
    ["deriveKey"],
  );
  const salt = await crypto.subtle.digest("SHA-256", toBytes("saas-store-cf:settings-key:v2"));
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: toBytes(purpose) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await deriveMaterial(env, "settings-encryption-v2");
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toBytes(plaintext));
  return `v2.${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(ciphertext))}`;
}

export async function decryptSecret(env: Env, stored: string): Promise<string> {
  const [version, ivB64, dataB64] = stored.split(".");
  if (version !== "v2" || !ivB64 || !dataB64) throw new Error("Unsupported encrypted setting format");
  const key = await deriveMaterial(env, "settings-encryption-v2");
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(dataB64),
  );
  return new TextDecoder().decode(plain);
}