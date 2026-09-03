import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Render } from "@puckeditor/core";
import "./register-typescript.mjs";

const { createAiPageBlock, pageConfig } = await import("../../src/editor/config.tsx");

function renderBlock(type, props) {
  return renderToStaticMarkup(createElement(Render, {
    config: pageConfig,
    data: { root: { props: {} }, content: [{ type, props: { id: "regression-block", ...props } }] },
  }));
}

test("published AI Hero without buttonHref renders with a usable default link", () => {
  const html = renderBlock("Hero", { title: "测试标题", description: "测试介绍", eyebrow: "产品", buttonText: "开始使用" });
  assert.match(html, /测试标题/);
  assert.match(html, /开始使用/);
  assert.match(html, /href="#pricing"/);
});

test("published AI CTA without buttonHref renders with a usable default link", () => {
  const html = renderBlock("CTA", { title: "开始使用", description: "测试介绍", buttonText: "立即购买" });
  assert.match(html, /href="#pricing"/);
});

test("invalid button link values do not crash or become executable links", () => {
  for (const buttonHref of [null, 42, {}, ["#pricing"], "javascript:alert(1)", "//attacker.example"]) {
    const html = renderBlock("Hero", { title: "页面仍可用", buttonText: "查看", buttonHref });
    assert.match(html, /页面仍可用/);
    assert.match(html, /href="#"/);
  }
});

test("explicit links on existing pages are preserved", () => {
  const html = renderBlock("Hero", { title: "登录", buttonText: "立即登录", buttonHref: " https://example.com/login " });
  assert.match(html, /href="https:\/\/example.com\/login"/);
});

test("AI-created blocks supply defaults and render after saving and reloading", () => {
  for (const type of ["Hero", "Features", "FAQ", "Text", "CTA"]) {
    const block = createAiPageBlock(type, { title: "AI 生成标题", buttonText: "开始使用", description: null, items: ["错误类型"], id: "untrusted-id", unknownField: "extra" });
    assert.notEqual(block.props.id, "untrusted-id");
    assert.equal(block.props.unknownField, undefined);
    const saved = JSON.parse(JSON.stringify(block));
    const html = renderBlock(saved.type, saved.props);
    assert.match(html, /AI 生成标题/);
    if (type === "Hero" || type === "CTA") assert.match(html, /href="#pricing"/);
  }
});
