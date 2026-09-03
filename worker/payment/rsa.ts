import { base64ToBytes, toBytes } from "../crypto/base64";

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function pemBody(value: string): string {
  return value.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
}

function derLength(length: number): number[] {
  if (length < 128) return [length];
  const bytes: number[] = [];
  let value = length;
  while (value > 0) {
    bytes.unshift(value & 0xff);
    value >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function wrapPkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const algorithmIdentifier = new Uint8Array([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octet = new Uint8Array([0x04, ...derLength(pkcs1.length), ...pkcs1]);
  const payload = new Uint8Array([...version, ...algorithmIdentifier, ...octet]);
  return new Uint8Array([0x30, ...derLength(payload.length), ...payload]);
}

export async function importRsassaPrivateKey(value: string): Promise<CryptoKey> {
  const raw = base64ToBytes(pemBody(value));
  const der = value.includes("BEGIN RSA PRIVATE KEY") ? wrapPkcs1ToPkcs8(raw) : raw;
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export async function importRsassaPublicKey(value: string): Promise<CryptoKey> {
  const der = base64ToBytes(pemBody(value));
  return crypto.subtle.importKey("spki", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
}
