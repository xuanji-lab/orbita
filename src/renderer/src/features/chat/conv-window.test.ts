/**
 * conv-window：确认卡「当时那段对话」窗口逻辑的纯函数测试——
 * fence 补闭合、窗口外字数、摘句高亮的滚动目标。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { closeOpenFence, markScrollTop, windowCounts } from "./conv-window.ts";

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
