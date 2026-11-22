/**
 * 用户消息里图片附件的左右对齐跟着主题的用户消息版式走。
 *
 * 仓里没有 renderer 组件测试设施（没有 jsdom），按源码文本钉住两处结构：
 * 对齐写在 CSS 类里（不写内联 style）才能随主题块改。2026-11-22 撤掉子午线版式后用户消息回到右侧，
 * 这里钉住：没有左对齐的主题块、没有对话列竖线与 gutter、时间不在 agent 一侧。
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

test("所有主题的用户消息（含图片附件）都在右侧：不再有把它改成左对齐纸签的主题块（2026-11-22 撤掉子午线）", () => {
  assert.doesNotMatch(styles, /用户消息：左对齐的整块纸签/);
  assert.doesNotMatch(styles, /\.user-images \{[^}]*justify-content: flex-start;/);
  assert.match(styles, /\n\.user-turn \{[^}]*align-items: flex-end;/);
});

test("对话列没有子午线竖线与线上的圆点 / 刻度，也没有 gutter 缩进", () => {
  assert.doesNotMatch(styles, /\.chat-col::before/);
  assert.doesNotMatch(styles, /\.chat-col > \[data-kind="user"\]::before/);
  assert.doesNotMatch(styles, /\.chat-col,\s*\.chat-foot-col,\s*\.chat-float-col \{[^}]*padding-left: var\(--gutter\)/);
});

test("用户气泡最宽 80%，时间在气泡下一行右下角（.user-msg-time 在动作行里，没有被绝对定位进边栏）", () => {
  assert.match(styles, /\n\.user-bubble \{[^}]*max-width: min\(var\(--bubble-max-width\), 80%\)/);
  assert.doesNotMatch(styles, /\.user-turn \.user-msg-time,\s*\.chat-col \.turn-start-time/);
});

test("agent 这边不再显示时间：对话流里没有 turn-start-time", () => {
  assert.doesNotMatch(chatView, /className="turn-start-time"/);
});
