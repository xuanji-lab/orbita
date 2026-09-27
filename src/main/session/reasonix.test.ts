/**
 * reasonix.ts 的测试。样例是**合成的**（2026-09-27）：真实数据在用户的论文项目里，脱敏
 * 不是换个标题就完事，索性按调研到的行形状手造一份覆盖全部分支的小会话——形状真实
 * （字段名、嵌套、缺席方式都对齐 2026-09-27 的本机抽样），内容无关。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  isReasonixConversationFile,
  listReasonixSessions,
  parseReasonixRows,
  readReasonixMeta,
  reasonixToMessages,
} from "./reasonix.ts";

const USER_AT = 1757134310000;

function rowsOf(...rows: Record<string, unknown>[]): string {
  return rows.map((row) => JSON.stringify(row)).join("\n");
}

describe("isReasonixConversationFile", () => {
  test("主 JSONL 收，派生物与冲突副本弃", () => {
    assert.equal(isReasonixConversationFile("20260906-021150-deepseek-v4.jsonl"), true);
    assert.equal(isReasonixConversationFile("desktop-202605171616-2.jsonl"), true);
    assert.equal(isReasonixConversationFile("20260906-021150-deepseek-v4.jsonl.events.jsonl"), false);
    assert.equal(isReasonixConversationFile("20260906-021150-deepseek-v4.jsonl.turns.jsonl"), false);
    assert.equal(isReasonixConversationFile("20260906-recovery-ab12.conflicts.jsonl"), false);
    assert.equal(isReasonixConversationFile("20260906-021150-deepseek-v4.jsonl.meta"), false);
  });
});

describe("parseReasonixRows", () => {
  test("空行跳过、坏行计数不拦整批", () => {
    const raw = '{"role":"user","content":"hi"}\n\n不是json\n  \n{"role":"tool"}\n';
    const parsed = parseReasonixRows(raw);
    assert.equal(parsed.rows.length, 2);
    assert.equal(parsed.badLines, 1);
  });
});

describe("reasonixToMessages（合成样例，覆盖全部分支）", () => {
  const rows = parseReasonixRows(
    rowsOf(
      // 分支记账行（无 role）与 system 行：都跳
      { kind: "revision", branch_id: "b1", base_revision: 7, at: "2026-09-06T02:11:50Z" },
      { role: "system", content: "You are Reasonix, a coding agent." },
      // 用户原文 vs 模型所见：content 带 host 包装，raw_content 是原文
      {
        role: "user",
        content: "<reasoning-language>用中文思考</reasoning-language>\n帮我看看 tmp.py",
        raw_content: "帮我看看 tmp.py",
        origin: "user",
        createdAt: USER_AT,
      },
      // assistant：旧形 thinking（reasoning_content + reasoning_signature）+ 文字 + 工具调用
      {
        role: "assistant",
        content: "先读一下文件。",
        reasoning_content: "用户要看 tmp.py，先读。",
        reasoning_signature: "sig-uuid-1",
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"tmp.py"}' } },
        ],
        workDurationMs: 1234,
      },
      // 工具结果：正常
      { role: "tool", tool_call_id: "call_1", name: "read_file", content: "def main(): ...", tool_execution: { state: "completed" } },
      // assistant：新形 thinking_blocks（带签名）+ 空文字 + 工具调用（arguments 坏 JSON）
      {
        role: "assistant",
        content: "",
        thinking_blocks: [{ type: "thinking", thinking: "改第 3 行", signature: "sig-uuid-2" }],
        tool_calls: [{ id: "call_2", type: "function", function: { name: "edit_file", arguments: "{path: tmp.py" } }],
        decision_receipts: [{ id: "1", kind: "ask", subject: "q", outcome: "answered" }],
      },
      // 工具结果：出错（tool_execution.state === "error"）
      { role: "tool", tool_call_id: "call_2", name: "edit_file", content: "boom", tool_execution: { state: "error" } },
      // 被打断的 assistant：声明了 call_3 但结果没写出来（空结果行被跳过）——审计补占位
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_3", type: "function", function: { name: "bash", arguments: "{}" } }],
        interrupted_turn: true,
      },
      { role: "tool", tool_call_id: "call_3", name: "bash", content: null, interrupted_turn: true },
      // 没发给模型的 local_only 结果与孤儿结果
      { role: "tool", tool_call_id: "call_x", name: "__reasonix_local_only__", content: "宿主注入", local_only: true },
      { role: "tool", tool_call_id: "call_orphan", name: "read_file", content: "孤儿结果" },
      // 末轮：user（无 createdAt，继承前面的钟）+ assistant 纯文字
      { role: "user", content: "好了吗", raw_content: "好了吗", origin: "user" },
      { role: "assistant", content: "好了。", workDurationMs: 100 },
      // host 注入的快照：进 pi 不显示
      { role: "user", content: "<session-context>...</session-context>", origin: "host" },
    ),
  ).rows;

  const parsed = reasonixToMessages(rows, "prov", "opencode-go2/deepseek-v4-flash");

  test("消息流形状：system/记账/local_only/孤儿/打断的空结果都不在", () => {
    const roles = parsed.messages.map((message) => message.role);
    assert.deepEqual(roles, [
      "user",
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
      "assistant", // 被打断的那条（call_3）
      "toolResult", // call_3 的合成占位
      "user",
      "assistant",
      "user", // host 快照
    ]);
  });

  test("thinking 双形都转 thinking 块，签名进 thinkingSignature", () => {
    const first = parsed.messages[1] as AssistantMessage;
    assert.deepEqual(
      first.content.map((block) => block.type),
      ["thinking", "text", "toolCall"],
    );
    const old = first.content[0] as { thinking: string; thinkingSignature?: string };
    assert.equal(old.thinking, "用户要看 tmp.py，先读。");
    assert.equal(old.thinkingSignature, "sig-uuid-1");
    const second = parsed.messages[3] as AssistantMessage;
    const neo = second.content[0] as { thinking: string; thinkingSignature?: string };
    assert.equal(neo.thinkingSignature, "sig-uuid-2");
  });

  test("OpenAI function 形 → toolCall，坏 JSON 的 arguments 进 raw 键", () => {
    const call = (parsed.messages[1] as AssistantMessage).content[2] as { id: string; name: string; arguments: unknown };
    assert.equal(call.id, "call_1");
    assert.equal(call.name, "read_file");
    assert.deepEqual(call.arguments, { path: "tmp.py" });
    // 这条 assistant 的 content 是空串：text 块不生成，content = [thinking, toolCall]
    const bad = (parsed.messages[3] as AssistantMessage).content[1] as { arguments: Record<string, unknown> };
    assert.deepEqual(bad.arguments, { raw: "{path: tmp.py" });
  });

  test("结果配对：错误标记、打断占位、孤儿丢弃", () => {
    const ok = parsed.messages[2] as { toolCallId: string; isError: boolean };
    assert.equal(ok.toolCallId, "call_1");
    assert.equal(ok.isError, false);
    const bad = parsed.messages[4] as { toolCallId: string; isError: boolean };
    assert.equal(bad.toolCallId, "call_2");
    assert.equal(bad.isError, true);
    const patched = parsed.messages[6] as { toolCallId: string; content: { text: string }[] };
    assert.equal(patched.toolCallId, "call_3");
    assert.match(patched.content[0]!.text, /reasonix import/);
    assert.equal(parsed.stats.patchedToolCalls, 1);
    assert.equal(parsed.stats.orphanToolResults, 1);
    assert.equal(parsed.stats.localOnlyResults, 1);
    assert.equal(parsed.stats.interruptedResults, 1);
  });

  test("transcript 原文：raw_content 优先、host 不显示、无 raw_content 退 content", () => {
    assert.deepEqual(parsed.userDisplays, ["帮我看看 tmp.py", "好了吗", null]);
    assert.equal(parsed.firstPrompt, "帮我看看 tmp.py");
  });

  test("时间戳：assistant 没有钟，沿行序继承；之后继续给后面各行", () => {
    assert.equal(parsed.messages[0]!.timestamp, USER_AT);
    assert.equal(parsed.messages[1]!.timestamp, USER_AT);
    // 末轮 user 没有 createdAt，也继承（钟只进不退）
    const lastUser = parsed.messages[7]!;
    assert.equal(lastUser.timestamp, USER_AT);
  });

  test("pi 侧的章：api/provider/model/usage 全零/stopReason", () => {
    const assistant = parsed.messages[1] as {
      api: string;
      provider: string;
      model: string;
      usage: { totalTokens: number };
      stopReason: string;
    };
    assert.equal(assistant.api, "openai-completions");
    assert.equal(assistant.provider, "prov");
    assert.equal(assistant.model, "opencode-go2/deepseek-v4-flash");
    assert.equal(assistant.usage.totalTokens, 0);
    assert.equal(assistant.stopReason, "toolUse");
    const aborted = (parsed.messages[5] as AssistantMessage).stopReason;
    assert.equal(aborted, "aborted");
    const final = parsed.messages[8] as { stopReason: string };
    assert.equal(final.stopReason, "stop");
  });

  test("空 assistant 行（没字没思考没调用）跳过", () => {
    const parsed2 = reasonixToMessages(
      parseReasonixRows(rowsOf({ role: "assistant", content: null, reasoning_state: { status: "done" } })).rows,
      "prov",
      null,
    );
    assert.equal(parsed2.messages.length, 0);
    assert.equal(parsed2.stats.skippedRows, 1);
  });

  test("模型缺席时盖 unknown；user 缺 raw_content 时显示退 content", () => {
    const parsed3 = reasonixToMessages(
      parseReasonixRows(rowsOf({ role: "user", content: "只有 content", origin: "user" }, { role: "assistant", content: "好" })).rows,
      "prov",
      null,
    );
    assert.deepEqual(parsed3.userDisplays, ["只有 content"]);
    const assistant = parsed3.messages[1] as { model: string };
    assert.equal(assistant.model, "unknown");
  });
});

describe("meta 与清单", () => {
  test("readReasonixMeta：ISO 时间、字段缺席退 null、缺文件退 null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-reasonix-"));
    try {
      const session = join(dir, "20260906-021150.jsonl");
      await writeFile(
        `${session}.meta`,
        JSON.stringify({
          id: "20260906-021150",
          topic_title: "能不能用白痴的话解释一下",
          model: "opencode-go2/deepseek-v4-flash",
          workspace_root: "C:\\tmp\\proj",
          created_at: "2026-09-06T02:11:50.467Z",
          updated_at: "2026-09-06T02:50:15.223Z",
        }),
        "utf8",
      );
      const meta = await readReasonixMeta(session);
      assert.equal(meta?.title, "能不能用白痴的话解释一下");
      assert.equal(meta?.createdAt, Date.parse("2026-09-06T02:11:50.467Z"));
      await writeFile(join(dir, "bare.jsonl"), "{}\n", "utf8");
      assert.equal(await readReasonixMeta(join(dir, "bare.jsonl")), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("listReasonixSessions：走 projects/<项目>/sessions/，排除派生物与冲突副本", async () => {
    const root = await mkdtemp(join(tmpdir(), "orbita-reasonix-list-"));
    try {
      const sessions = join(root, "proj-a", "sessions");
      await mkdir(sessions, { recursive: true });
      await writeFile(join(sessions, "s1.jsonl"), '{"role":"user","content":"hi"}\n', "utf8");
      await writeFile(join(sessions, "s1.jsonl.meta"), JSON.stringify({ topic_title: "T1" }), "utf8");
      await writeFile(join(sessions, "s2.jsonl"), '{"role":"user","content":"yo"}\n', "utf8");
      await writeFile(join(sessions, "s2.jsonl.events.jsonl"), "{}\n", "utf8");
      await writeFile(join(sessions, "s3.conflicts.jsonl"), "{}\n", "utf8");
      await writeFile(join(sessions, "s3.jsonl.turns.jsonl"), "{}\n", "utf8");
      // 没有 sessions/ 的项目目录：跳过不报错
      await mkdir(join(root, "proj-b"), { recursive: true });

      const found = await listReasonixSessions(root);
      assert.equal(found.length, 2);
      const names = found.map((item) => item.file.endsWith("s1.jsonl")).sort();
      assert.deepEqual(names, [false, true]);
      assert.equal(found.find((item) => item.file.endsWith("s1.jsonl"))?.meta?.title, "T1");
      assert.equal(found.find((item) => item.file.endsWith("s2.jsonl"))?.meta, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("根不在（没装）返回空清单不抛", async () => {
    const missing = join(tmpdir(), "orbita-reasonix-missing-never-created");
    assert.deepEqual(await listReasonixSessions(missing), []);
  });
});
