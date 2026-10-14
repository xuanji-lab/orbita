/**
 * conv-window：确认卡「当时那段对话」窗口逻辑的纯函数测试——
 * fence 补闭合、窗口外字数、摘句高亮的滚动目标。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeOpenFence, EXCERPT_SKIP, excerptMode, excerptNeedle, markScrollTop, windowCounts } from "./conv-window.ts";
import { locateQuote } from "./quote-select.ts";

const WIN = { start: 0, total: 100, cutBefore: false, cutAfter: false, located: true, fallback: false };

test("excerptMode：fallback 优先于 located——located=false + fallback=true 不说「未定位」", () => {
  assert.equal(excerptMode(WIN, "摘句"), "mark");
  // 服务端的兜底（空 / 整段 / 没找到）发 located=false + fallback=true：从头显示、不说话
  assert.equal(excerptMode({ ...WIN, located: false, fallback: true }, "摘句"), "plain");
  // 有摘句、有窗口、就是对不上：说「未定位」
  assert.equal(excerptMode({ ...WIN, located: false, fallback: false }, "摘句"), "not-located");
  // 摘句为空：不管窗口怎么说都不高亮、不说话
  assert.equal(excerptMode({ ...WIN, located: false, fallback: false }, "  "), "plain");
  // 旧服务端（没有窗口元数据）：全文里找
  assert.equal(excerptMode(undefined, "摘句"), "mark");
});

test("EXCERPT_SKIP：摘句省掉原文的角引号 / 带 markdown 符号也定位得到（与 intent-lab 同口径）", () => {
  // 2026-10-14 真机：原文「政策——「economic…」，摘句「政策——economic…」
  const segments = ["选一个政策", "——「economic growth policy… plans」。"];
  assert.equal(locateQuote(segments, "政策——economic growth policy… plans"), null);
  const at = locateQuote(segments, "政策——economic growth policy… plans", EXCERPT_SKIP);
  assert.deepEqual(at, { start: { node: 0, offset: 3 }, end: { node: 1, offset: 32 } });
  // 摘句里带 **加粗** 符号（渲染文本里没有）
  assert.notEqual(locateQuote(["重点是这句话。"], "**这句话**", EXCERPT_SKIP), null);
  // 反复调用结果稳定（正则不带 g，没有 lastIndex 状态）
  assert.equal(EXCERPT_SKIP.global, false);
});

test("excerptNeedle：去掉行首列表标记（渲染后的 <li> 里没有），句中的不动", () => {
  assert.equal(excerptNeedle("第一项结尾。\n- 第二项\n  2. 第三项\n3) 第四项"), "第一项结尾。\n第二项\n第三项\n第四项");
  assert.equal(excerptNeedle("7,000-9,000 词，第 1. 节"), "7,000-9,000 词，第 1. 节");
  // 跨列表项的摘句能对上渲染文本（两个 <li> 的文本节点）
  const at = locateQuote(["她给的替代方向。", "关于智慧城市。"], excerptNeedle("替代方向。\n- 关于智慧"), EXCERPT_SKIP);
  assert.deepEqual(at, { start: { node: 0, offset: 3 }, end: { node: 1, offset: 4 } });
});

test("closeOpenFence：奇数个 ``` 补闭合，偶数不动；行内的 `` 不算 fence", () => {
  assert.equal(closeOpenFence("前文\n```ts\nconst a = 1;\n"), "前文\n```ts\nconst a = 1;\n\n```");
  assert.equal(closeOpenFence("```ts\ncode\n```\n后文"), "```ts\ncode\n```\n后文");
  assert.equal(closeOpenFence("没有 fence"), "没有 fence");
  // 行内的 ```（句中引用）不是 fence，不数
  assert.equal(closeOpenFence("他说 ``` 这样写"), "他说 ``` 这样写");
  // ~~~ 同理
  assert.equal(closeOpenFence("~~~\ncode"), "~~~\ncode\n~~~");
});

test("windowCounts：窗口外前 / 后的字数；cut 标记 false 时是 0；没有窗口元数据为 null", () => {
  assert.equal(windowCounts(undefined, 100), null);
  const win = { start: 40, total: 1400, cutBefore: true, cutAfter: true, located: true, fallback: false };
  assert.deepEqual(windowCounts(win, 600), { before: 40, after: 760 });
  // 没裁的边不显示
  assert.deepEqual(windowCounts({ ...win, cutBefore: false }, 600), { before: 0, after: 760 });
  // 数不对（服务端窗口账与文本长不符）不显示负数
  assert.deepEqual(windowCounts(win, 2000), { before: 40, after: 0 });
});

test("markScrollTop：摘句放得下就居中，比可视区高就开头顶上", () => {
  // 可视高 160，摘句 40px 落在 800：scrollTop = 800 - (160-40)/2 = 740
  assert.equal(markScrollTop(800, 840, 160), 740);
  // 摘句 300px 比可视区高：开头顶到上沿（留 4px 呼吸）
  assert.equal(markScrollTop(800, 1100, 160), 796);
  // 顶部附近不滚成负数
  assert.equal(markScrollTop(10, 30, 160), 0);
});
