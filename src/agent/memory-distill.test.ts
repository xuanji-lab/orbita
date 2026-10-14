import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDistillPrompt,
  completedTurnAssistantText,
  DISTILL_SYSTEM_PROMPT,
  formatDate,
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

test("completedTurnAssistantText：正常轮——取本轮新增的最后一条 assistant，拼接文本块并跳过非文本块", () => {
  const messages = [
    { role: "assistant", content: [{ type: "text", text: "上一轮的回答" }], stopReason: "stop" },
    { role: "user", content: [{ type: "text", text: "本轮提问" }] },
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "t1" },
      ],
      stopReason: "toolUse",
    },
    { role: "toolResult", toolCallId: "t1", content: [] },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "思考不算回答" },
        { type: "text", text: "前半。" },
        { type: "text", text: "后半。" },
      ],
      stopReason: "stop",
    },
  ];
  // baseline = 1：prompt 前只有上一轮的回答，本轮从 user 那条开始
  assert.equal(completedTurnAssistantText(messages, 1), "前半。\n后半。");
});

test("completedTurnAssistantText：打断且还没开始回答——本轮无新增 assistant，不回落到上一轮的回答", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "上一轮提问" }] },
    { role: "assistant", content: [{ type: "text", text: "上一轮的回答" }], stopReason: "stop" },
    { role: "user", content: [{ type: "text", text: "本轮提问，还没回答就被打断" }] },
  ];
  // 张冠李戴的根源：不看基线的话「最后一条 assistant」是上一轮的回答，
  // 会和本轮提问拼在一起蒸出错误条目
  assert.equal(completedTurnAssistantText(messages, 2), null);
});

test("completedTurnAssistantText：打断但有半截回答——stopReason aborted 不蒸", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "本轮提问" }] },
    {
      role: "assistant",
      content: [{ type: "text", text: "刚说了半句就被打断了" }],
      stopReason: "aborted",
    },
  ];
  assert.equal(completedTurnAssistantText(messages, 0), null);
});

test("completedTurnAssistantText：报错轮——stopReason error 不蒸（pi 停止后补的那条 error 同样拦下）", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "本轮提问" }] },
    { role: "toolResult", toolCallId: "t1", content: [] },
    {
      role: "assistant",
      // 被我们停下时 pi 拿着已 abort 的信号再调一次模型，得到的就是这条 error
      content: [{ type: "text", text: "" }],
      stopReason: "error",
      errorMessage: "This operation was aborted",
    },
  ];
  assert.equal(completedTurnAssistantText(messages, 0), null);
});

test("completedTurnAssistantText：正常但纯工具轮（最后一条 assistant 没有文本）返回空串，由调用方跳过", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "问" }] },
    { role: "assistant", content: [{ type: "toolCall", id: "x" }], stopReason: "stop" },
  ];
  assert.equal(completedTurnAssistantText(messages, 0), "");
});

test("completedTurnAssistantText：长度截断（length）与延迟（deferred）算正常结束", () => {
  const lengthCut = [
    { role: "user", content: [{ type: "text", text: "问" }] },
    { role: "assistant", content: [{ type: "text", text: "被 maxTokens 截断的回答" }], stopReason: "length" },
  ];
  assert.equal(completedTurnAssistantText(lengthCut, 0), "被 maxTokens 截断的回答");
  const deferred = [
    { role: "user", content: [{ type: "text", text: "问" }] },
    { role: "assistant", content: [{ type: "text", text: "延迟完成的回答" }], stopReason: "deferred" },
  ];
  assert.equal(completedTurnAssistantText(deferred, 0), "延迟完成的回答");
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
