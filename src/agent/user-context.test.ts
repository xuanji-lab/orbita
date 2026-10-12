/**
 * 用户情境（user-context）的测试：格式化确定性（前缀缓存的硬要求）、
 * 注入的角色边界、历史重放的逐字节稳定。
 */
import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, test } from "node:test";
import { formatUserContext, injectUserContext, type UserContext } from "./user-context.ts";
import type { ContextMessage } from "./image-byte-budget.ts";

/** 固定时刻：2026-10-12 是周一、2026-10-11 是周日（这里都是上海本地凌晨 02:31） */
const SH_MONDAY = Date.UTC(2026, 9, 11, 18, 31, 0); // UTC 10-11 18:31 = 上海 10-12（周一）02:31
const SH_SUNDAY = Date.UTC(2026, 9, 10, 18, 31, 0); // UTC 10-10 18:31 = 上海 10-11（周日）02:31

describe("formatUserContext", () => {
  test("上海时区：日期、时间、星期、时区名齐全", () => {
    strictEqual(
      formatUserContext({ sentAt: SH_MONDAY, timeZone: "Asia/Shanghai" }),
      "<user_context>\nsent_at: 2026-10-12 02:31 Mon (Asia/Shanghai)\n</user_context>",
    );
  });

  test("星期随本地呈现走：同一时刻换个时区，日期与星期一起变", () => {
    // 上海 10-12 02:31 = 纽约 10-11 14:31（周日，夏令时 UTC-4）
    strictEqual(
      formatUserContext({ sentAt: SH_MONDAY, timeZone: "America/New_York" }),
      "<user_context>\nsent_at: 2026-10-11 14:31 Sun (America/New_York)\n</user_context>",
    );
  });

  test("跨日：本地时区的午夜前后分属两天（UTC 16:00 = 上海次日 00:00）", () => {
    const before = Date.UTC(2026, 9, 11, 15, 59, 0); // 上海 10-11 23:59
    const after = Date.UTC(2026, 9, 11, 16, 0, 0); // 上海 10-12 00:00
    strictEqual(
      formatUserContext({ sentAt: before, timeZone: "Asia/Shanghai" }),
      "<user_context>\nsent_at: 2026-10-11 23:59 Sun (Asia/Shanghai)\n</user_context>",
    );
    strictEqual(
      formatUserContext({ sentAt: after, timeZone: "Asia/Shanghai" }),
      "<user_context>\nsent_at: 2026-10-12 00:00 Mon (Asia/Shanghai)\n</user_context>",
    );
  });

  test("周日样例：星期缩写随日期走", () => {
    strictEqual(
      formatUserContext({ sentAt: SH_SUNDAY, timeZone: "Asia/Shanghai" }),
      "<user_context>\nsent_at: 2026-10-11 02:31 Sun (Asia/Shanghai)\n</user_context>",
    );
  });

  test("确定性：同一输入反复格式化字节相同（前缀缓存）", () => {
    const ctx: UserContext = { sentAt: SH_MONDAY, timeZone: "Asia/Shanghai" };
    strictEqual(formatUserContext(ctx), formatUserContext(ctx));
    strictEqual(formatUserContext(ctx), formatUserContext({ ...ctx }));
  });

  test("与运行环境 locale 无关：显式 en-US 部件拼装", () => {
    // 原样再跑一遍只是防回归的占位：locale 相关性没法在单测里穷举，
    // 靠的是实现里 locale 固定为 en-US、逐部件 pad 拼装
    strictEqual(
      formatUserContext({ sentAt: Date.UTC(2026, 0, 5, 3, 5, 0), timeZone: "UTC" }),
      "<user_context>\nsent_at: 2026-01-05 03:05 Mon (UTC)\n</user_context>",
    );
  });
});

function userMessage(timestamp: number, text: string): ContextMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as unknown as ContextMessage;
}

const ASSISTANT = { role: "assistant", content: [], timestamp: SH_MONDAY } as unknown as ContextMessage;
const TOOL_RESULT = {
  role: "toolResult",
  toolCallId: "t1",
  content: [{ type: "text", text: "ok" }],
  isError: false,
  timestamp: SH_MONDAY + 1,
} as unknown as ContextMessage;

describe("injectUserContext", () => {
  test("用户消息块数组前插一个 text 块；其余角色原样放行", () => {
    const input = [userMessage(SH_MONDAY, "你好"), ASSISTANT, TOOL_RESULT];
    const result = injectUserContext(input, "Asia/Shanghai");
    if (result === undefined) throw new Error("应当发生替换");
    strictEqual(result.messages.length, 3);
    const first = result.messages[0] as { content: { type: string; text: string }[] };
    strictEqual(first.content[0]?.type, "text");
    strictEqual(
      first.content[0]?.text,
      "<user_context>\nsent_at: 2026-10-12 02:31 Mon (Asia/Shanghai)\n</user_context>",
    );
    // 用户正文原块跟在情境块后面，一个字没动
    strictEqual(first.content[1]?.text, "你好");
    strictEqual(result.messages[1], ASSISTANT);
    strictEqual(result.messages[2], TOOL_RESULT);
  });

  test("字符串正文的用户消息：情境直接拼在前面", () => {
    const input = [{ role: "user", content: "hi", timestamp: SH_MONDAY }] as unknown as ContextMessage[];
    const result = injectUserContext(input, "UTC");
    if (result === undefined) throw new Error("应当发生替换");
    strictEqual(
      (result.messages[0] as { content: unknown }).content,
      "<user_context>\nsent_at: 2026-10-11 18:31 Sun (UTC)\n</user_context>\nhi",
    );
  });

  test("没有用户消息时不替换（undefined）", () => {
    strictEqual(injectUserContext([ASSISTANT, TOOL_RESULT], "UTC"), undefined);
  });

  test("timestamp 缺失 / 非数的用户消息原样放行——不编时间", () => {
    const noTime = { role: "user", content: [{ type: "text", text: "?" }] } as unknown as ContextMessage;
    const badTime = { role: "user", content: [], timestamp: Number.NaN } as unknown as ContextMessage;
    const result = injectUserContext([noTime, badTime], "UTC");
    strictEqual(result, undefined);
  });

  test("历史重放逐字节稳定：同一份历史两轮注入结果完全相同", () => {
    const history = [
      userMessage(SH_MONDAY, "第一句"),
      ASSISTANT,
      TOOL_RESULT,
      userMessage(SH_MONDAY + 60_000, "第二句"),
    ];
    const round1 = injectUserContext(history, "Asia/Shanghai");
    const round2 = injectUserContext(history, "Asia/Shanghai");
    deepStrictEqual(round1, round2);
  });

  test("时间取自每条消息自己的 timestamp：两条消息拿到各自的时刻", () => {
    const input = [userMessage(SH_MONDAY, "早的"), userMessage(SH_SUNDAY, "晚的")];
    const result = injectUserContext(input, "Asia/Shanghai");
    if (result === undefined) throw new Error("应当发生替换");
    const texts = result.messages.map(
      (m) => (m as { content: { text?: string }[] }).content[0]?.text ?? "",
    );
    strictEqual(texts[0]?.includes("2026-10-12"), true);
    strictEqual(texts[1]?.includes("2026-10-11"), true);
  });

  test("不改入参：注入是纯变换", () => {
    const input = [userMessage(SH_MONDAY, "你好")];
    const snapshot = JSON.stringify(input);
    injectUserContext(input, "Asia/Shanghai");
    strictEqual(JSON.stringify(input), snapshot);
  });
});
