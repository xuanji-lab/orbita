import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BODY_HEAD_CHARS,
  BODY_HEAD_LINES,
  BODY_TAIL_CHARS,
  BODY_TAIL_LINES,
  clampToolBody,
} from "./tool-body-clamp.ts";

/**
 * 工具展开体读时投影的口径。锚定的不变量：
 *
 * 1. **不截等于没截**：两条阈值内（含恰好等于）原文逐行原样返回，`omitted` 为 null——
 *    99% 的工具结果走这条路，渲染结果与从前一字不差；
 * 2. **双阈值各自都管用**：8 千行空行（行超、字符不超）与一行 5 万字（字符超、行不超）
 *    都要被截——只按一条阈值实现会漏掉其中一边；
 * 3. **首尾都在、切口在行边界**：最后的行原样保留（bash 的结果在尾巴），且不劈开行
 *    （``` fence 行要么整行在、要么整行不在——工具展开体是纯文本不走 markdown，
 *    所以不需要 conv-window.ts 的补闭合，只需要不在行中间下刀）；
 * 4. **提示行的数字是原文总量**（不是保留量），行数按 `split("\n").length` 口径。
 */

/** 造 n 行文本，每行 `L<i>`（长度可控） */
function block(n: number, pad = 0): string {
  return Array.from({ length: n }, (_, i) => `L${i}${"x".repeat(pad)}`).join("\n");
}

test("短内容：原行原样、omitted=null（渲染路径不分叉）", () => {
  const short = "a\nb\nc";
  const clamped = clampToolBody(short);
  assert.deepEqual(clamped.head, ["a", "b", "c"]);
  assert.deepEqual(clamped.tail, []);
  assert.equal(clamped.omitted, null);
  assert.equal(clamped.head.join("\n"), short, "逐字等于原文");
});

test("边界：恰好到行预算 / 字符预算 → 不截；超一行 / 超一字 → 截", () => {
  const lines = BODY_HEAD_LINES + BODY_TAIL_LINES;
  // 行数恰好 = 预算，且字符远低于预算 → 原样
  const atLines = block(lines);
  assert.equal(clampToolBody(atLines).omitted, null);
  assert.equal(clampToolBody(block(lines + 1)).omitted?.lines, lines + 1);

  // 字符恰好 = 预算（单行够长也在一行内；行数远低于预算）→ 原样
  const chars = BODY_HEAD_CHARS + BODY_TAIL_CHARS;
  const atChars = `${"y".repeat(chars - 2)}\nz`;
  assert.equal(atChars.length, chars);
  assert.equal(clampToolBody(atChars).omitted, null);
  const overChars = `${"y".repeat(chars - 1)}\nz`;
  assert.equal(overChars.length, chars + 1);
  assert.equal(clampToolBody(overChars).omitted?.chars, chars + 1);
});

test("行超、字符不超（900 行短行）：照样截——行阈值不是摆设", () => {
  const text = block(BODY_HEAD_LINES + BODY_TAIL_LINES + 500);
  assert.equal(text.length < BODY_HEAD_CHARS + BODY_TAIL_CHARS, true, "这个用例必须是字符不超");
  const clamped = clampToolBody(text);
  assert.notEqual(clamped.omitted, null);
  assert.deepEqual(clamped.head, Array.from({ length: BODY_HEAD_LINES }, (_, i) => `L${i}`));
  assert.deepEqual(clamped.tail, Array.from({ length: BODY_TAIL_LINES }, (_, i) => `L${BODY_HEAD_LINES + 500 + i}`));
});

test("字符超、行不超（一行 5 万字的 minified 输出）：照样截——字符阈值不是摆设", () => {
  const text = "z".repeat(50000);
  const clamped = clampToolBody(text);
  assert.notEqual(clamped.omitted, null);
  assert.equal(clamped.omitted?.lines, 1, "一行也算 1 行");
  assert.equal(clamped.omitted?.chars, 50000);
  const head = clamped.head[0] ?? "";
  const tail = clamped.tail[0] ?? "";
  assert.equal(clamped.head.length, 1, "没有换行可对齐，硬切成半行——总比丢掉整段强");
  assert.equal(head.length, BODY_HEAD_CHARS);
  assert.equal(clamped.tail.length, 1);
  assert.equal(tail.length, BODY_TAIL_CHARS);
  assert.equal(head + tail, text.slice(0, BODY_HEAD_CHARS) + text.slice(-BODY_TAIL_CHARS));
});

test("首尾都留：最后一行原样在（bash 的结果与报错在尾巴）", () => {
  const lines = Array.from({ length: 3000 }, (_, i) => `line-${i}`);
  lines[2999] = "error: something failed";
  lines[0] = "the first line";
  const clamped = clampToolBody(lines.join("\n"));
  assert.equal(clamped.head[0], "the first line");
  assert.equal(clamped.tail.at(-1), "error: something failed");
});

test("切口落回整行边界：每一条保留行都是原文的整行，不出现半截行", () => {
  // 每行 100 字：行预算（240/160 行）与字符预算（12000/8000）都超，且字符先到——
  // 切口必须在行边界上收紧（否则头部会多出半条 100 字的行）
  const lines = Array.from({ length: 2000 }, (_, i) => `${String(i).padStart(4, "0")}${"p".repeat(96)}`);
  const clamped = clampToolBody(lines.join("\n"));
  const kept = [...clamped.head, ...clamped.tail];
  for (const line of kept) assert.equal(lines.includes(line), true, `半截行：${line}`);
  assert.equal(clamped.head.length < BODY_HEAD_LINES, true, "头部是字符预算收紧的，不是行预算");
  assert.equal(clamped.tail.length < BODY_TAIL_LINES, true, "尾部同理");
  assert.equal(clamped.head.at(-1)?.length, 100, "头部最后一行是完整的行");
  assert.equal(clamped.tail[0]?.length, 100, "尾部第一行是完整的行");
});

test("fence 安全：``` 行要么整行保留、要么整行不在（不做补闭合——纯文本展开体不需要）", () => {
  const lines: string[] = ["```bash"];
  for (let i = 0; i < 3000; i++) lines.push(`echo ${i}`);
  lines.push("```");
  const clamped = clampToolBody(lines.join("\n"));
  // 头部第一行是开 fence 的整行；尾部最后一行是闭合 fence 的整行——两截各自完整
  assert.equal(clamped.head[0], "```bash");
  assert.equal(clamped.tail.at(-1), "```");
  const kept = [...clamped.head, ...clamped.tail];
  // 保留区里的 fence 行**只有原文那两条**：没有哪一行是半截 backtick
  assert.deepEqual(kept.filter((line) => line.startsWith("`")), ["```bash", "```"]);
});

test("提示行的数字是原文总量：行数按 split 口径、字符数按 UTF-16 长度", () => {
  const lines = Array.from({ length: 1200 }, (_, i) => `第 ${i} 行`);
  const text = lines.join("\n");
  const clamped = clampToolBody(text);
  assert.deepEqual(clamped.omitted, { lines: 1200, chars: text.length });
  assert.equal(clamped.omitted?.lines, text.split("\n").length);
});

test("截断时保留量确实降到预算内（双端各自不超）", () => {
  const text = block(5000, 200);
  const clamped = clampToolBody(text);
  assert.equal(clamped.head.length <= BODY_HEAD_LINES, true);
  assert.equal(clamped.tail.length <= BODY_TAIL_LINES, true);
  const keptChars = clamped.head.join("\n").length + clamped.tail.join("\n").length;
  assert.equal(keptChars <= BODY_HEAD_CHARS + BODY_TAIL_CHARS, true);
});
