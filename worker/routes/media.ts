export async function handleMedia(env: Env, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/media/")) return null;
  const key = decodeURIComponent(url.pathname.slice("/media/".length));
  if (!key || key.includes("..")) return new Response("Not found", { status: 404 });
  const object = await env.MEDIA.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  return new Response(object.body, { headers });
}
