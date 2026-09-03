export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function bad(message: string, status = 400): Response {
  return json({ ok: false, error: message }, { status });
}

export async function bodyJson<T>(request: Request): Promise<T> {
  const type = request.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new Error("请求必须为 JSON");
  return (await request.json()) as T;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function parseCnyCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const yuan = Number.parseInt(match[1], 10);
  const fraction = (match[2] ?? "").padEnd(2, "0");
  const cents = yuan * 100 + Number.parseInt(fraction || "0", 10);
  return Number.isSafeInteger(cents) ? cents : null;
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function orderNo(): string {
  // ORD + 28 hex characters stays within WeChat's 32-character limit.
  const random = crypto.getRandomValues(new Uint8Array(14));
  const rand = Array.from(random, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
  return `ORD${rand}`;
}

export function paymentSuccess(): Response {
  return new Response("success", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

export function parseOrderMetadata(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export type ContactType = "phone" | "email";

export function classifyContactInfo(value: string): ContactType | null {
  if (/^1[3-9]\d{9}$/.test(value)) return "phone";
  if (value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return "email";
  return null;
}

export function webhookContactFields(metadata: Record<string, unknown>): Record<string, unknown> {
  const info = typeof metadata.contact_info === "string" ? metadata.contact_info.trim() : "";
  const type = classifyContactInfo(info);
  if (!type) return {};
  const contact = {
    name: typeof metadata.contact_name === "string" ? metadata.contact_name.trim() : "",
    info,
    type,
  };
  return {
    contact,
    contact_name: contact.name,
    contact_info: contact.info,
    contact_type: contact.type,
  };
}
