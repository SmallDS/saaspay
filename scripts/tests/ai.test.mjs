import assert from "node:assert/strict";
import test from "node:test";
import "./register-typescript.mjs";
const ai = await import("../../worker/ai.ts");

function mockEnv(result, model = ai.DEFAULT_AI_MODEL) {
  const usage = { neurons_used: 100, calls: 0 };
  const env = {
    AI: { async run() { if (result instanceof Error) throw result; return result; } },
    DB: {
      prepare(sql) {
        let values;
        return {
          bind(...args) { values = args; return this; },
          async first() {
            if (sql.startsWith("SELECT value, encrypted")) {
              return { value: values[0] === "ai.enabled" ? "true" : model, encrypted: 0 };
            }
            throw new Error(`Unexpected query: ${sql}`);
          },
          async run() {
            if (sql.includes("neurons_used=neurons_used+?")) usage.neurons_used += values[0];
            else if (sql.includes("neurons_used=MAX")) {
              usage.neurons_used = Math.max(0, usage.neurons_used - values[0]);
              usage.calls++;
            } else if (!sql.startsWith("INSERT INTO ai_usage")) throw new Error(`Unexpected query: ${sql}`);
            return { meta: { changes: 1 } };
          },
        };
      },
    },
  };
  return { env, usage };
}

const generators = [
  {
    name: "product copy",
    invoke: (env) => ai.generateProductCopy(env, { name: "测试产品", points: "节省时间" }),
    output: { summary: "简洁介绍", description: "详细介绍" },
  },
  {
    name: "SEO metadata",
    invoke: (env) => ai.generateSeoMeta(env, { pageTitle: "测试页面", pageText: "页面内容" }),
    output: { seo_title: "页面标题", seo_description: "搜索摘要", seo_keywords: "产品,软件" },
  },
  {
    name: "section props",
    invoke: (env) => ai.generateSectionProps(env, { component: "Hero", brief: "产品介绍" }),
    output: { eyebrow: "软件", title: "欢迎使用", description: "产品介绍", buttonText: "立即体验" },
  },
];

for (const generator of generators) {
  for (const { value: model } of ai.AI_MODEL_OPTIONS) {
    for (const format of ["object", "string", "markdown", "raw string"]) {
      test(`${generator.name}: ${model}, ${format}`, async () => {
        const json = JSON.stringify(generator.output);
        const response = format === "object" ? generator.output : format === "markdown" ? `\n\`\`\`json\n${json}\n\`\`\`\n` : ` ${json} `;
        const { env, usage } = mockEnv(format === "raw string" ? response : { response }, model);
        assert.deepEqual(await generator.invoke(env), generator.output);
        assert.equal(usage.calls, 1);
        assert.ok(usage.neurons_used > 100);
      });
    }
  }
}

test("invalid chat outputs produce readable errors and settle usage only once", async () => {
  for (const response of [null, undefined, "", "  ", 42, false, [], "not JSON", "{broken}", {}]) {
    const { env, usage } = mockEnv({ response, usage: { prompt_tokens: 100, completion_tokens: 50 } });
    await assert.rejects(generators[0].invoke(env), /AI (未返回内容|返回的内容无法解析为 JSON|返回的文案缺少字段)/);
    assert.deepEqual(usage, { neurons_used: 103, calls: 1 });
  }
  for (const result of [null, undefined]) {
    const { env, usage } = mockEnv(result);
    await assert.rejects(generators[0].invoke(env), /AI 未返回内容/);
    assert.equal(usage.calls, 1);
  }
});

test("structured outputs still validate required fields", async () => {
  for (const generator of generators) {
    const { env } = mockEnv({ response: {} });
    await assert.rejects(generator.invoke(env), /AI 返回的.*(缺少字段|字段为空)/);
  }
});

test("image descriptions accept text and fall back past invalid description values", async () => {
  for (const result of [
    { description: " 图片内容 " }, { response: " 图片内容 " }, " 图片内容 ",
    { description: {}, response: " 图片内容 " }, { description: "  ", response: " 图片内容 " },
  ]) {
    const { env, usage } = mockEnv(result);
    assert.equal(await ai.describeAssetImage(env, new Uint8Array([1, 2])), "图片内容");
    assert.deepEqual(usage, { neurons_used: 250, calls: 1 });
  }
});

test("invalid image descriptions do not throw trim errors or refund completed inference", async () => {
  for (const result of [null, undefined, { response: {} }, { description: 42 }, { response: [] }, { response: " " }]) {
    const { env, usage } = mockEnv(result);
    await assert.rejects(ai.describeAssetImage(env, new Uint8Array([1, 2])), /AI 未返回图片描述/);
    assert.deepEqual(usage, { neurons_used: 250, calls: 1 });
  }
});

test("failed AI calls refund reservations once and preserve the error", async () => {
  const failure = new Error("AI service unavailable");
  for (const invoke of [generators[0].invoke, (env) => ai.describeAssetImage(env, new Uint8Array([1, 2]))]) {
    const { env, usage } = mockEnv(failure);
    await assert.rejects(invoke(env), (error) => error === failure);
    assert.deepEqual(usage, { neurons_used: 100, calls: 1 });
  }
});
