import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDistillPrompt,
  DISTILL_SYSTEM_PROMPT,
  formatDate,
  lastAssistantText,
  parseDistillReply,
} from "./memory-distill.ts";

test("parseDistillReply：标准 JSON 数组", () => {
  const drafts = parseDistillReply(
    '[{"text":"用户偏好 bun 作为包管理器","keywords":["bun","包管理器"]}]',
    1000,
  );
  assert.equal(drafts.length, 1);
  assert.deepEqual(drafts[0], { text: "用户偏好 bun 作为包管理器", keywords: ["bun", "包管理器"], timestamp: 1000 });
});

test("parseDistillReply：markdown 围栏与前后废话都能剥", () => {
  const raw = "好的，以下是结果：\n```json\n[{\"text\":\"项目 dev 端口固定 5273\",\"keywords\":[\"端口\"]}]\n```\n完毕。";
  const drafts = parseDistillReply(raw, 0);
  assert.equal(drafts.length, 1);
  assert.equal(drafts[0]?.text, "项目 dev 端口固定 5273");
});

test("parseDistillReply：闲聊的空数组", () => {
  assert.deepEqual(parseDistillReply("[]", 0), []);
});

test("parseDistillReply：坏 JSON / 非数组 / 没有数组都返回空，不抛", () => {
  assert.deepEqual(parseDistillReply("[{\"text\":\"半截", 0), []);
  assert.deepEqual(parseDistillReply('{"text":"不是数组"}', 0), []);
  assert.deepEqual(parseDistillReply("模型说了句人话，没有任何 JSON", 0), []);
  assert.deepEqual(parseDistillReply("", 0), []);
});

test("parseDistillReply：条目 cap 5、关键词 cap 8、空文本丢弃、非字符串关键词滤掉", () => {
  const items = Array.from({ length: 7 }, (_, i) => ({
    text: `条目 ${i}`,
    keywords: ["a", "b", "c", "d", "e", "f", "g", "h", "i", 42, " "],
  }));
  items[2] = { text: "   ", keywords: [] };
  const drafts = parseDistillReply(JSON.stringify(items), 5);
  // 7 条里第 3 条空文本丢弃，余 6 条再 cap 到 5
  assert.equal(drafts.length, 5);
  assert.deepEqual(drafts.map((d) => d.text), ["条目 0", "条目 1", "条目 3", "条目 4", "条目 5"]);
  assert.equal(drafts[0]?.keywords.length, 8);
  assert.ok(drafts[0]?.keywords.every((k) => typeof k === "string" && k.trim() !== ""));
  assert.equal(drafts[0]?.timestamp, 5);
});

test("buildDistillPrompt：带绝对日期锚点，超长输入截断", () => {
  const prompt = buildDistillPrompt({
    userText: "u".repeat(5000),
    assistantText: "a".repeat(9000),
    now: new Date(2026, 9, 10).getTime(),
  });
  assert.ok(prompt.includes("<date>2026-10-10</date>"));
  assert.ok(prompt.length < 5000 + 9000);
  assert.ok(prompt.includes("（中段略）"));
});

test("lastAssistantText：取最后一条 assistant 的文本块，拼接并跳过非文本块", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "问" }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "前半。" },
        { type: "toolCall", id: "t1" },
        { type: "text", text: "后半。" },
      ],
    },
  ];
  assert.equal(lastAssistantText(messages), "前半。\n后半。");
});

test("lastAssistantText：没有 assistant 或没有文本返回空串", () => {
  assert.equal(lastAssistantText([]), "");
  assert.equal(lastAssistantText([{ role: "user", content: [] }]), "");
  assert.equal(lastAssistantText([{ role: "assistant", content: [{ type: "toolCall", id: "x" }] }]), "");
});

test("formatDate：YYYY-MM-DD 且补零", () => {
  assert.equal(formatDate(new Date(2026, 0, 5).getTime()), "2026-01-05");
});

test("DISTILL_SYSTEM_PROMPT 声明了原子条目三要素与空数组出口", () => {
  assert.ok(DISTILL_SYSTEM_PROMPT.includes("自包含"));
  assert.ok(DISTILL_SYSTEM_PROMPT.includes("第三人称"));
  assert.ok(DISTILL_SYSTEM_PROMPT.includes("YYYY-MM-DD"));
  assert.ok(DISTILL_SYSTEM_PROMPT.includes("[]"));
});

test("DISTILL_SYSTEM_PROMPT 排除元讨论（验收观察：关于记忆机制本身的议论不该入库）", () => {
  assert.ok(DISTILL_SYSTEM_PROMPT.includes("元讨论"));
});
