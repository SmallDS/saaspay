import { getSettingValue } from "./db/settings";

// 免费额度 10,000 Neurons/天（UTC 0 点重置）。此处写死 9900 硬上限并预留 1% 余量，
// 任何调用都通过"原子预留上界 → 按实际用量结算"保证累计消耗不可能超过该值：
// Workers Free 计划永不触顶报错，Paid 计划永不产生账单。
export const AI_DAILY_NEURON_LIMIT = 9900;

export const DEFAULT_AI_MODEL: AiModelId = "@cf/meta/llama-3.1-8b-instruct-fp8-fast";

export type AiModelId =
  | "@cf/meta/llama-3.1-8b-instruct-fp8-fast"
  | "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

export const AI_MODEL_OPTIONS: Array<{ value: AiModelId; label: string }> = [
  { value: "@cf/meta/llama-3.1-8b-instruct-fp8-fast", label: "快速 · Llama 3.1 8B（推荐，约 21 Neurons/次）" },
  { value: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", label: "强力 · Llama 3.3 70B（约 123 Neurons/次）" },
];

// 各模型 Neurons / 百万 token（按官方价 $/M ÷ $0.011 × 1000 折算，数值取上界）
const MODEL_NEURONS_PER_MILLION: Record<AiModelId, { input: number; output: number }> = {
  "@cf/meta/llama-3.1-8b-instruct-fp8-fast": { input: 4600, output: 38000 },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { input: 30000, output: 225000 },
};

const VISION_MODEL = "@cf/meta/llama-3.2-11b-vision";
const VISION_NEURONS_PER_IMAGE = 150;
const VISION_MAX_OUTPUT_TOKENS = 100;

export class AiBudgetExceededError extends Error {}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureDayRow(env: Env, day: string): Promise<void> {
  await env.DB.prepare("INSERT INTO ai_usage(day,neurons_used,calls) VALUES(?,0,0) ON CONFLICT(day) DO NOTHING").bind(day).run();
}

async function reserveNeurons(env: Env, estimate: number): Promise<number> {
  const day = todayUtc();
  await ensureDayRow(env, day);
  const result = await env.DB.prepare(
    "UPDATE ai_usage SET neurons_used=neurons_used+?,updated_at=CURRENT_TIMESTAMP WHERE day=? AND neurons_used+?<=?",
  ).bind(estimate, day, estimate, AI_DAILY_NEURON_LIMIT).run();
  if (result.meta.changes !== 1) {
    throw new AiBudgetExceededError(`今日 AI 免费额度已用尽（每日 ${AI_DAILY_NEURON_LIMIT} Neurons 硬上限），将于 UTC 0 点重置`);
  }
  return estimate;
}

async function settleNeurons(env: Env, reserved: number, actual: number): Promise<void> {
  const refund = Math.max(0, reserved - Math.min(actual, reserved));
  await env.DB.prepare(
    "UPDATE ai_usage SET neurons_used=MAX(neurons_used-?,0),calls=calls+1,updated_at=CURRENT_TIMESTAMP WHERE day=?",
  ).bind(refund, todayUtc()).run();
}

function estimateNeurons(model: AiModelId, inputChars: number, maxOutputTokens: number): number {
  const rate = MODEL_NEURONS_PER_MILLION[model];
  // 中文 1 字 ≈ 1~2 token，按 2 放大；整体再乘 1.5 安全系数，保证预估恒为实际上界。
  const inputTokens = Math.ceil(inputChars * 2);
  const estimate = (inputTokens * rate.input + maxOutputTokens * rate.output) / 1_000_000;
  return Math.ceil(estimate * 1.5);
}

async function requireAiEnabled(env: Env): Promise<AiModelId> {
  const enabled = (await getSettingValue(env, "ai.enabled", "false")) === "true";
  if (!enabled) throw new Error("AI 助手未启用，请在 系统设置 → AI 助手 中开启");
  const model = (await getSettingValue(env, "ai.model", DEFAULT_AI_MODEL)) as AiModelId;
  return MODEL_NEURONS_PER_MILLION[model] ? model : DEFAULT_AI_MODEL;
}

type ChatResponse = {
  response?: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

// 生成的 worker-configuration.d.ts 对 AI.run 做了按模型的强类型重载，
// 运行时按模型名动态调用，这里用宽松签名绕开联合类型的重载解析。
type LooseAi = { run(model: string, input: Record<string, unknown>): Promise<unknown> };

function aiBinding(env: Env): LooseAi {
  return env.AI as unknown as LooseAi;
}

async function runChat(env: Env, opts: { system: string; prompt: string; maxTokens: number; temperature?: number }): Promise<string> {
  const model = await requireAiEnabled(env);
  const estimate = estimateNeurons(model, opts.system.length + opts.prompt.length, opts.maxTokens);
  const reserved = await reserveNeurons(env, estimate);
  try {
    const response = await aiBinding(env).run(model, {
      messages: [
        { role: "system", content: opts.system },
        { role: "user", content: opts.prompt },
      ],
      max_tokens: opts.maxTokens,
      temperature: opts.temperature ?? 0.7,
    }) as ChatResponse;
    const rate = MODEL_NEURONS_PER_MILLION[model];
    const actual = response.usage
      ? Math.ceil(((response.usage.prompt_tokens ?? 0) * rate.input + (response.usage.completion_tokens ?? 0) * rate.output) / 1_000_000)
      : estimate;
    await settleNeurons(env, reserved, actual);
    const text = (response.response ?? "").trim();
    if (!text) throw new Error("AI 未返回内容，请重试或更换模型");
    return text;
  } catch (error) {
    // 调用失败（含未返回内容）时全额回扣预留（宁少勿超），仅累计调用次数
    await settleNeurons(env, reserved, 0);
    throw error instanceof Error ? error : new Error("AI 调用失败");
  }
}

function extractJson(text: string): Record<string, unknown> {
  const stripped = text.replace(/```(?:json)?/gi, "").replace(/```/g, "").trim();
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  const candidate = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  try {
    const parsed: unknown = JSON.parse(candidate);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error("not object");
  } catch {
    throw new Error("AI 返回的内容无法解析为 JSON，请重试");
  }
}

const COPYWRITING_SYSTEM = "你是资深中文 SaaS 营销文案专家，文风简洁、具体、有说服力，不使用夸大或空话。只输出 JSON，不要输出任何其他文字或 Markdown 代码块。";

export async function generateProductCopy(env: Env, input: { name: string; points: string }): Promise<{ summary: string; description: string }> {
  const text = await runChat(env, {
    system: COPYWRITING_SYSTEM,
    prompt: [
      `为名为「${input.name}」的软件产品撰写中文销售文案。`,
      "产品卖点（每行一条）：",
      input.points.trim() || "（未提供，请基于产品名合理推断通用卖点）",
      '输出 JSON：{"summary":"一句话介绍，不超过 30 字","description":"详细介绍，120-220 字，2-3 个自然段"}',
    ].join("\n"),
    maxTokens: 600,
  });
  const parsed = extractJson(text);
  const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!summary || !description) throw new Error("AI 返回的文案缺少字段，请重试");
  return { summary, description };
}

export async function generateSeoMeta(env: Env, input: { pageTitle: string; pageText: string; keywords?: string }): Promise<{ seo_title: string; seo_description: string; seo_keywords: string }> {
  const text = await runChat(env, {
    system: "你是中文 SEO 专家，为网页生成搜索友好的元信息。只输出 JSON，不要输出任何其他文字或 Markdown 代码块。",
    prompt: [
      `页面标题：${input.pageTitle}`,
      "页面正文摘录：",
      input.pageText.slice(0, 4000),
      input.keywords?.trim() ? `参考关键词：${input.keywords.trim()}` : "",
      '输出 JSON：{"seo_title":"不超过 30 字的搜索标题","seo_description":"80-160 字的结果摘要","seo_keywords":"3-6 个关键词，英文逗号分隔"}',
    ].filter(Boolean).join("\n"),
    maxTokens: 250,
    temperature: 0.5,
  });
  const parsed = extractJson(text);
  const seo_title = typeof parsed.seo_title === "string" ? parsed.seo_title.trim().slice(0, 60) : "";
  const seo_description = typeof parsed.seo_description === "string" ? parsed.seo_description.trim().slice(0, 200) : "";
  const seo_keywords = typeof parsed.seo_keywords === "string" ? parsed.seo_keywords.trim().slice(0, 200) : "";
  if (!seo_title || !seo_description) throw new Error("AI 返回的 SEO 信息缺少字段，请重试");
  return { seo_title, seo_description, seo_keywords };
}

export const AI_SECTION_PROMPTS: Record<string, string> = {
  Hero: '{"eyebrow":"眉标题,4-10字","title":"主标题,10-20字","description":"副标题描述,40-70字","buttonText":"按钮文字,2-6字"}',
  Features: '{"title":"板块标题,4-12字","items":"4-6 条卖点,每行一条,每条 6-16 字,用 \\n 分隔","columns":"4"}',
  FAQ: '{"title":"板块标题,4-12字","items":"4-6 条问答,每行一条,格式为 问题|答案,答案 20-60 字,用 \\n 分隔"}',
  Text: '{"title":"标题,4-16字","content":"正文,100-200 字","align":"left"}',
  CTA: '{"title":"行动号召标题,6-16字","description":"说明,30-60字","buttonText":"按钮文字,2-6字"}',
};

export async function generateSectionProps(env: Env, input: { component: string; brief: string }): Promise<Record<string, unknown>> {
  const schema = AI_SECTION_PROMPTS[input.component];
  if (!schema) throw new Error("不支持的组件类型");
  const text = await runChat(env, {
    system: "你是资深中文落地页文案专家，为落地页组件生成字段内容。只输出 JSON，不要输出任何其他文字或 Markdown 代码块。",
    prompt: [
      `组件类型：${input.component}`,
      `创作要点：${input.brief.trim() || "围绕软件产品的核心价值创作"}`,
      `输出 JSON，字段结构必须严格如下（\\n 表示换行符）：${schema}`,
    ].join("\n"),
    maxTokens: 600,
  });
  const parsed = extractJson(text);
  if (Object.keys(parsed).length === 0) throw new Error("AI 返回的字段为空，请重试");
  return parsed;
}

export async function describeAssetImage(env: Env, imageBytes: Uint8Array): Promise<string> {
  await requireAiEnabled(env);
  const reserved = await reserveNeurons(env, VISION_NEURONS_PER_IMAGE);
  try {
    const response = await aiBinding(env).run(VISION_MODEL, {
      image: Array.from(imageBytes),
      prompt: "用一句中文描述这张图片的核心内容，不超过 60 字，直接给出描述本身，不要任何前缀。",
      max_tokens: VISION_MAX_OUTPUT_TOKENS,
      temperature: 0.3,
    }) as { description?: string; response?: string };
    await settleNeurons(env, reserved, reserved);
    const text = (response.description ?? response.response ?? "").trim();
    if (!text) throw new Error("AI 未返回图片描述，请重试");
    return text.slice(0, 120);
  } catch (error) {
    if (error instanceof AiBudgetExceededError) throw error;
    await settleNeurons(env, reserved, 0);
    throw error instanceof Error ? error : new Error("图片描述生成失败");
  }
}

export async function getAiUsage(env: Env): Promise<{ day: string; neurons_used: number; calls: number; limit: number }> {
  const day = todayUtc();
  await ensureDayRow(env, day);
  const row = await env.DB.prepare("SELECT neurons_used,calls FROM ai_usage WHERE day=?").bind(day).first<{ neurons_used: number; calls: number }>();
  return { day, neurons_used: row?.neurons_used ?? 0, calls: row?.calls ?? 0, limit: AI_DAILY_NEURON_LIMIT };
}
