import { bad } from "./http";
import { handleAdmin } from "./routes/admin";
import { handleAuth } from "./routes/auth";
import { handleHtmlPage, handleSeoFiles } from "./routes/html";
import { handleMedia } from "./routes/media";
import { handlePublic } from "./routes/public";
import { deliverBusinessEvent } from "./webhook/outbound";
import type { WebhookQueueMessage } from "./webhook/outbound";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      const url = new URL(request.url);
      const media = await handleMedia(env, url);
      if (media) return media;
      const seoFile = await handleSeoFiles(env, url);
      if (seoFile) return seoFile;
      const auth = await handleAuth(request, env, url.pathname);
      if (auth) return auth;
      const admin = await handleAdmin(request, env, url);
      if (admin) return admin;
      const publicResponse = await handlePublic(request, env, url);
      if (publicResponse) return publicResponse;

      // 其余请求交给静态资源；HTML 页面注入服务端 SEO meta 后返回。
      if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 404 });
      const assetResponse = await env.ASSETS.fetch(request);
      const contentType = assetResponse.headers.get("content-type") ?? "";
      if (!contentType.includes("text/html")) return assetResponse;
      return await handleHtmlPage(request, env, url, assetResponse);
    } catch (error) {
      console.error(JSON.stringify({ level: "error", event: "request_failed", error: error instanceof Error ? error.message : String(error) }));
      return bad(error instanceof Error ? error.message : "服务器错误", 500);
    }
  },

  async queue(batch, env, ctx): Promise<void> {
    for (const message of batch.messages) {
      try {
        const result = await deliverBusinessEvent(env, message.body, message.attempts);
        if (result.ok) {
          message.ack();
        } else {
          const delay = Math.min(60 * 60, 30 * 2 ** Math.max(0, message.attempts - 1));
          message.retry({ delaySeconds: delay });
        }
      } catch (error) {
        console.error(JSON.stringify({ level: "error", event: "webhook_delivery_failed", message_id: message.id, error: error instanceof Error ? error.message : String(error) }));
        const delay = Math.min(60 * 60, 30 * 2 ** Math.max(0, message.attempts - 1));
        message.retry({ delaySeconds: delay });
      }
    }
  },
} satisfies ExportedHandler<Env, WebhookQueueMessage>;
