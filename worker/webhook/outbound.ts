import { getSettingValue } from "../db/settings";
import { bytesToBase64, toBytes } from "../crypto/base64";

export type BusinessEventType = "order.created" | "order.paid" | "order.closed" | "order.refunded";

export type BusinessEvent = {
  id: string;
  type: BusinessEventType;
  created_at: string;
  data: Record<string, unknown>;
};

export type WebhookQueueMessage = {
  event: BusinessEvent;
  orderId?: string;
};

export async function enqueueBusinessEvent(env: Env, type: BusinessEventType, data: Record<string, unknown>, orderId?: string): Promise<void> {
  const enabled = (await getSettingValue(env, "webhook.enabled", "false")) === "true";
  if (!enabled) return;
  const eventsRaw = await getSettingValue(env, "webhook.events", "[]");
  let events: string[] = [];
  try { events = JSON.parse(eventsRaw) as string[]; } catch { events = []; }
  if (!events.includes(type)) return;
  const event: BusinessEvent = { id: `evt_${crypto.randomUUID()}`, type, created_at: new Date().toISOString(), data };
  await env.WEBHOOK_QUEUE.send({ event, orderId } satisfies WebhookQueueMessage);
}

async function signWebhook(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", toBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, toBytes(`${timestamp}.${body}`));
  return `sha256=${bytesToBase64(new Uint8Array(signature))}`;
}

export async function deliverBusinessEvent(env: Env, message: WebhookQueueMessage, attempt: number): Promise<{ ok: boolean; status: number; body: string }> {
  const url = await getSettingValue(env, "webhook.url");
  const secret = await getSettingValue(env, "webhook.secret");
  if (!url || !secret) return { ok: true, status: 204, body: "Webhook disabled or incomplete" };

  const body = JSON.stringify(message.event);
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const deliveryId = `whd_${crypto.randomUUID()}`;
  let status = 0;
  let responseBody = "";
  let ok = false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "saas-store-cf-webhook/1.0",
        "x-webhook-id": message.event.id,
        "x-webhook-timestamp": timestamp,
        "x-webhook-signature": await signWebhook(secret, timestamp, body),
      },
      body,
    });
    status = response.status;
    responseBody = (await response.text()).slice(0, 4000);
    ok = response.ok;
  } catch (error) {
    responseBody = error instanceof Error ? error.message : "Webhook network error";
  }

  await env.DB.prepare(
    `INSERT INTO webhook_deliveries(id,event_id,event_type,order_id,request_url,request_body,response_status,response_body,status,attempts,last_attempt_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`,
  ).bind(
    deliveryId,
    message.event.id,
    message.event.type,
    message.orderId ?? null,
    url,
    body,
    status || null,
    responseBody,
    ok ? "success" : "failed",
    attempt,
  ).run();

  return { ok, status, body: responseBody };
}
