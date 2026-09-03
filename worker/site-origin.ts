import { normalizeSiteOrigin } from "../src/shared/site-url";
import { getSettingValue } from "./db/settings";

// Only the saved setting or the actual request origin can determine public URLs.
export async function getSiteOrigin(env: Env, fallbackOrigin = ""): Promise<string> {
  return normalizeSiteOrigin(await getSettingValue(env, "site.primary_domain")) || normalizeSiteOrigin(fallbackOrigin);
}
