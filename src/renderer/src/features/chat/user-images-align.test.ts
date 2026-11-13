/**
 * 用户消息里图片附件的左右对齐跟着主题的用户消息版式走。
 *
 * 仓里没有 renderer 组件测试设施（没有 jsdom），按源码文本钉住两处结构：
 * 子午线版式（除 copybook / typescript 外的主题）把用户消息改成左对齐纸签，
 * 图片若把对齐写在 UserImages 的内联 style 里，主题块覆盖不到——2026-11-12 用户报
 * 「图片还在居右，换了新的 chatview 应该居左」就是这么来的。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

const HERE = dirname(fileURLToPath(import.meta.url));
// CRLF 归一：Windows 检出的工作区是 CRLF
const read = (path: string) => readFileSync(join(HERE, path), "utf8").replace(/\r\n/g, "\n");
const chatView = read("ChatView.tsx");
const styles = read("../../styles.css");

function userImagesComponent(): string {
  const start = chatView.indexOf("function UserImages(");
  assert.ok(start >= 0, "找不到 UserImages 组件");
  const end = chatView.indexOf("\nfunction ", start + 1);
  return chatView.slice(start, end < 0 ? undefined : end);
}

test("UserImages 的对齐交给 CSS 类，不写在内联 style 里", () => {
  const component = userImagesComponent();
  assert.match(component, /className="user-images"/);
  assert.doesNotMatch(component, /justifyContent:/);
});

test("基础样式靠右（copybook / typescript 仍是右侧气泡）", () => {
  assert.match(styles, /\n\.user-images \{[^}]*justify-content: flex-end;/);
});

test("子午线版式的用户消息块里，图片与纸签一起靠左、不限气泡宽", () => {
  const start = styles.indexOf("/* 用户消息：左对齐的整块纸签");
  assert.ok(start >= 0, "找不到子午线版式的用户消息块");
  const block = styles.slice(start, styles.indexOf(".user-turn .memrow-list", start));
  assert.match(block, /\.user-images \{\n\s*justify-content: flex-start;\n\s*\}|\.user-images \{[^}]*justify-content: flex-start;/);
  assert.match(block, /\.user-images \{\n\s*max-width: none;/);
});
