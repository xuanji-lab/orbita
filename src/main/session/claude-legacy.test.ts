/**
 * claude legacy 转换器的测试 —— 两层：
 *
 * 1. **真实样本快照**：night-run fixtures 的 11 份本机 Proma 真源（2026-09-22 取样，
 *    manifest.json 记录索引条目）。对着真实数据测是调研 §四.6 的教训——重抄外部格式的
 *    parser 会随内部格式漂移而坏。fixture 不进仓（绝对路径读 + 缺失 skip），再生方法：
 *    从 ~/.proma-dev/agent-sessions.json 过滤 legacyTranscript.sourceRuntime === "claude"，
 *    按 manifest.json 的 id 拷贝 <id>.jsonl。
 * 2. **人造边界 fixture**（动态生成 tmp）：坏行、流式碎片合并、usage 缺席/部分、图片、
 *    空会话、孤儿 tool_result、打断补合成结果、子代理行、旧扁平行。只读投影（Proma adapter 读
 *    Claude 时代会话）的端到端在 external-adapters.test.ts。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import {
  claudeRowsToMessages,
  parseClaudeRows,
} from "./claude-legacy.ts";
import { messagesToRecords } from "./pi-book.ts";

/** fixture 根（会话工作台 night-run，不进仓）。 */
const FIXTURES =
  "/Users/guanhongli/.proma-dev/agent-workspaces/orbita/81a23de1-4caa-48a9-bda8-841eddac0923/night-run/fixtures/claude-legacy";

/** fixture 是否在盘上（缺失时真实样本组整体 skip——CI 或别的机器上没有这批数据）。 */
async function fixturesPresent(): Promise<boolean> {
  try {
    await readFile(join(FIXTURES, "manifest.json"), "utf8");
    return true;
  } catch {
    return false;
  }
}

interface FixtureManifestItem {
  id: string;
  tag: string;
  title: string;
  workspaceId: string | null;
  modelId: string | null;
  createdAt: number | null;
  updatedAt: number | null;
  archived: boolean;
  pinned: boolean;
}

// ---------------------------------------------------------------------------
// 人造 fixture 的搭台
// ---------------------------------------------------------------------------

/** 最小 user 行。 */
const userTextRow = (text: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "user",
  message: { role: "user", content: [{ type: "text", text }] },
  parent_tool_use_id: null,
  _createdAt: 1780000000000,
  ...extra,
});

/** 最小 assistant 流式块行（一行一个块）。 */
const assistantBlockRow = (
  messageId: string,
  block: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  type: "assistant",
  message: { id: messageId, role: "assistant", type: "message", model: "glm-5.1", content: [block], stop_reason: null, usage: { input_tokens: 100, output_tokens: 5 }, context_management: null },
  parent_tool_use_id: null,
  _createdAt: 1780000001000,
  ...extra,
});

/** 最小 user tool_result 行。 */
const toolResultRow = (toolUseId: string, content: unknown, isError = false): Record<string, unknown> => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }] },
  parent_tool_use_id: null,
  _createdAt: 1780000002000,
});

const resultRow = (): Record<string, unknown> => ({
  type: "result",
  subtype: "success",
  is_error: false,
  usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 },
  num_turns: 1,
});

// ---------------------------------------------------------------------------
// 转换器单测（人造边界）
// ---------------------------------------------------------------------------

describe("清洗：行级过滤", () => {
  test("坏行（半截 JSON / 非 object）跳过不炸，好行照收", () => {
    const { rows, stats } = parseClaudeRows(
      [
        JSON.stringify(userTextRow("问")),
        '{"type": "assistant", "message": {"id": "m1", "cont',
        "not json at all",
        JSON.stringify(assistantBlockRow("m1", { type: "text", text: "答" })),
        JSON.stringify(resultRow()),
      ].join("\n"),
    );
    assert.equal(stats.badLines, 2);
    assert.equal(stats.resultRows, 1);
    assert.equal(rows.length, 2);
  });

  test("旧扁平行（无 type、带 events）与 system/result 行不进主对话", () => {
    const { rows, stats } = parseClaudeRows(
      [
        JSON.stringify({ id: "old-1", role: "user", content: "旧格式", createdAt: 1, events: [] }),
        JSON.stringify({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 1 } }),
        JSON.stringify(resultRow()),
        JSON.stringify(userTextRow("新格式")),
      ].join("\n"),
    );
    assert.deepEqual(stats, {
      badLines: 0,
      oldFlatRows: 1,
      subagentRows: 0,
      systemRows: 1,
      resultRows: 1,
      otherTypedRows: 0,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.type, "user");
  });

  test("子代理行（parent_tool_use_id 非空）跳过", () => {
    const { rows, stats } = parseClaudeRows(
      [
        JSON.stringify(userTextRow("主对话")),
        JSON.stringify({ ...assistantBlockRow("sub", { type: "text", text: "子代理" }), parent_tool_use_id: "toolu_x" }),
      ].join("\n"),
    );
    assert.equal(stats.subagentRows, 1);
    assert.equal(rows.length, 1);
  });
});

describe("构造：流式碎片合并与块映射", () => {
  test("同一 message.id 的多行（thinking/text/tool_use 交错）合并为一条 assistant", () => {
    const { rows } = parseClaudeRows(
      [
        JSON.stringify(userTextRow("问")),
        JSON.stringify(assistantBlockRow("m1", { type: "thinking", thinking: "想", signature: "sig-1" })),
        JSON.stringify(assistantBlockRow("m1", { type: "text", text: "答" })),
        JSON.stringify(assistantBlockRow("m1", { type: "tool_use", id: "toolu_1", name: "read", input: { path: "/x" } })),
      ].join("\n"),
    );
    const { messages, stats } = claudeRowsToMessages(rows, "zai-coding");
    // tool_use 没等到结果行 → EOF 补合成 toolResult（配对审计）
    assert.deepEqual(stats, { droppedBlocks: 0, orphanToolResults: 0, patchedToolCalls: 1, emptyMessages: 0 });
    assert.equal(messages.length, 3);
    const assistant = messages[1];
    assert.ok(assistant?.role === "assistant");
    assert.equal(assistant.content.length, 3);
    assert.deepEqual(assistant.content[0], { type: "thinking", thinking: "想", thinkingSignature: "sig-1" });
    assert.deepEqual(assistant.content[1], { type: "text", text: "答" });
    const call = assistant.content[2];
    assert.ok(call?.type === "toolCall");
    assert.equal(call.id, "toolu_1");
    assert.equal(call.name, "read");
    // 组级 stopReason：无 tool_use 终态行 → stop；usage 换算自块行
    assert.equal(assistant.stopReason, "stop");
    assert.deepEqual(assistant.usage, {
      input: 100,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 105,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    assert.equal(assistant.provider, "zai-coding");
    assert.equal(assistant.model, "glm-5.1");
    assert.equal(assistant.api, "anthropic-messages");
  });

  test("stop_reason 映射：组内终态行 tool_use → toolUse；error 行 → error", () => {
    const rows1 = parseClaudeRows(
      [JSON.stringify(assistantBlockRow("m1", { type: "tool_use", id: "t1", name: "bash", input: {} }, { message: { id: "m1", role: "assistant", type: "message", model: "m", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }], stop_reason: "tool_use", usage: {} } }))].join("\n"),
    ).rows;
    const built1 = claudeRowsToMessages(rows1, "p");
    assert.equal(built1.messages[0]?.role === "assistant" ? built1.messages[0].stopReason : "", "toolUse");

    const rows2 = parseClaudeRows(
      [JSON.stringify({ ...assistantBlockRow("m2", { type: "text", text: "挂了" }), error: { message: "boom", errorType: "x" }, _errorCode: "x" })].join("\n"),
    ).rows;
    const built2 = claudeRowsToMessages(rows2, "p");
    assert.equal(built2.messages[0]?.role === "assistant" ? built2.messages[0].stopReason : "", "error");
  });

  test("usage 缺席 → 零值 Usage；部分字段只换算在场的", () => {
    const { rows } = parseClaudeRows(
      [
        JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "无 usage" }] }, parent_tool_use_id: null, _createdAt: 1 }),
        JSON.stringify({ type: "assistant", message: { id: "m2", role: "assistant", content: [{ type: "text", text: "部分" }], usage: { input_tokens: 7, cache_read_input_tokens: 9 } }, parent_tool_use_id: null, _createdAt: 2 }),
      ].join("\n"),
    );
    const { messages } = claudeRowsToMessages(rows, "p");
    const [none, partial] = messages as Extract<Message, { role: "assistant" }>[];
    assert.ok(none?.role === "assistant");
    assert.equal(none.usage.input, 0);
    assert.equal(none.usage.totalTokens, 0);
    assert.ok(partial?.role === "assistant");
    assert.equal(partial.usage.input, 7);
    assert.equal(partial.usage.cacheRead, 9);
    assert.equal(partial.usage.cacheWrite, 0);
    assert.equal(partial.usage.totalTokens, 16);
  });

  test("tool_result：string 与数组（text/image）两种 content 都翻译；is_error 传递", () => {
    const { rows } = parseClaudeRows(
      [
        JSON.stringify(userTextRow("问")),
        JSON.stringify(assistantBlockRow("m1", { type: "tool_use", id: "t1", name: "screenshot", input: {} })),
        JSON.stringify(assistantBlockRow("m1", { type: "tool_use", id: "t2", name: "view", input: {} })),
        JSON.stringify(toolResultRow("t1", "纯文本结果")),
        JSON.stringify(
          toolResultRow(
            "t2",
            [
              { type: "text", text: "带图" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } },
              { type: "image", source: { type: "url", url: "https://x/y.png" } },
            ],
            true,
          ),
        ),
      ].join("\n"),
    );
    const { messages, stats } = claudeRowsToMessages(rows, "p");
    // user + assistant + 2×toolResult；url 图像丢弃计 1
    assert.equal(messages.length, 4);
    assert.equal(stats.droppedBlocks, 1);
    const [t1, t2] = messages.slice(2) as Extract<Message, { role: "toolResult" }>[];
    assert.ok(t1?.role === "toolResult");
    assert.equal(t1.toolName, "screenshot");
    assert.deepEqual(t1.content, [{ type: "text", text: "纯文本结果" }]);
    assert.equal(t1.isError, false);
    assert.ok(t2?.role === "toolResult");
    assert.equal(t2.toolName, "view");
    assert.equal(t2.isError, true);
    assert.deepEqual(t2.content, [
      { type: "text", text: "带图" },
      { type: "image", data: "aW1n", mimeType: "image/png" },
    ]);
  });

  test("server_tool_use 与未知块丢弃，不进消息", () => {
    const { rows } = parseClaudeRows(
      [
        JSON.stringify(userTextRow("问")),
        JSON.stringify(assistantBlockRow("m1", { type: "server_tool_use", id: "c1", name: "analyze_image", input: {} })),
        JSON.stringify(assistantBlockRow("m1", { type: "sticker", emoji: "x" })),
        JSON.stringify(assistantBlockRow("m1", { type: "text", text: "正文" })),
      ].join("\n"),
    );
    const { messages, stats } = claudeRowsToMessages(rows, "p");
    assert.equal(stats.droppedBlocks, 2);
    assert.equal(messages.length, 2);
    const assistant = messages[1];
    assert.ok(assistant?.role === "assistant");
    assert.equal(assistant.content.length, 1);
  });

  test("空文本块不产出内容；块全丢的组跳过（emptyMessages）", () => {
    const { rows } = parseClaudeRows(
      [
        JSON.stringify(assistantBlockRow("m1", { type: "server_tool_use", id: "c1", name: "x", input: {} })),
        JSON.stringify(userTextRow("")),
      ].join("\n"),
    );
    const { messages, stats } = claudeRowsToMessages(rows, "p");
    assert.equal(messages.length, 0);
    assert.equal(stats.emptyMessages, 2);
  });
});

describe("构造：配对审计", () => {
  test("孤儿 tool_result（前文无对应 toolCall）丢弃", () => {
    const { rows } = parseClaudeRows(
      [JSON.stringify(toolResultRow("ghost", "没人调用过我"))].join("\n"),
    );
    const { messages, stats } = claudeRowsToMessages(rows, "p");
    assert.equal(stats.orphanToolResults, 1);
    assert.equal(messages.length, 0);
  });

  test("dangling toolCall（被打断、无结果行）在 EOF 补合成 toolResult", () => {
    const { rows } = parseClaudeRows(
      [
        JSON.stringify(userTextRow("问")),
        JSON.stringify(assistantBlockRow("m1", { type: "tool_use", id: "t1", name: "bash", input: {} })),
      ].join("\n"),
    );
    const { messages, stats } = claudeRowsToMessages(rows, "p");
    assert.equal(stats.patchedToolCalls, 1);
    assert.equal(messages.length, 3);
    const patched = messages[2];
    assert.ok(patched?.role === "toolResult");
    assert.equal(patched.toolCallId, "t1");
    assert.equal(patched.toolName, "bash");
    assert.equal(patched.isError, true);
  });

  test("用户插话触发补齐：dangling 在下一条 user 消息前补", () => {
    const { rows } = parseClaudeRows(
      [
        JSON.stringify(assistantBlockRow("m1", { type: "tool_use", id: "t1", name: "bash", input: {} })),
        JSON.stringify(userTextRow("算了别跑了")),
      ].join("\n"),
    );
    const { messages } = claudeRowsToMessages(rows, "p");
    // assistant → 补的 toolResult → 用户插话
    assert.equal(messages.length, 3);
    assert.equal(messages[1]?.role, "toolResult");
    assert.equal(messages[2]?.role, "user");
  });
});

// ---------------------------------------------------------------------------
// importer 集成：扫描与执行
// ---------------------------------------------------------------------------

describe("真实样本快照（night-run fixtures）", async () => {
  const present = await fixturesPresent();
  const manifest: FixtureManifestItem[] = present
    ? (JSON.parse(await readFile(join(FIXTURES, "manifest.json"), "utf8")) as FixtureManifestItem[])
    : [];

  const EXPECTED: Record<string, { rows: number; messages: number; user: number; assistant: number; toolResult: number; model: string | null; convertible: boolean }> = {
    // 2026-09-22 对真实文件跑转换器锚定的计数（冒烟脚本产物）
    "890040d8-0855-472a-82da-dfc1102d1e19": { rows: 3, messages: 2, user: 1, assistant: 1, toolResult: 0, model: "MiniMax-M3", convertible: true },
    "612112c7-8fc1-4c2f-950f-b8c881487c91": { rows: 21, messages: 13, user: 2, assistant: 7, toolResult: 4, model: "glm-5.1", convertible: true },
    "5b3e1c68-92cd-4234-9d2d-577b1236ca03": { rows: 9, messages: 6, user: 2, assistant: 3, toolResult: 1, model: "qwen3.7-plus", convertible: true },
    "efd4133d-b08c-4891-9dbc-9011781f776e": { rows: 0, messages: 0, user: 0, assistant: 0, toolResult: 0, model: null, convertible: false },
    "23f4ec7b-4862-4741-bf8a-2ca56f267cf6": { rows: 75, messages: 59, user: 3, assistant: 28, toolResult: 28, model: "glm-5-turbo", convertible: true },
    "eed2cfac-a323-4c05-84d5-3224d7bb0b2e": { rows: 17, messages: 8, user: 1, assistant: 3, toolResult: 4, model: "glm-5-turbo", convertible: true },
    "d01250bf-a13f-4b48-a7f6-95a583b18d39": { rows: 174, messages: 111, user: 22, assistant: 55, toolResult: 34, model: "qwopus36-27b-v2-fp8", convertible: true },
    "cce3a9dd-1825-4321-b68f-ca3f539e9a68": { rows: 51, messages: 28, user: 7, assistant: 14, toolResult: 7, model: "glm-5-turbo", convertible: true },
    "5504542e-867c-4d0c-a021-1f4c667a1658": { rows: 48, messages: 28, user: 10, assistant: 14, toolResult: 4, model: "glm-5-turbo", convertible: true },
    "3ab5df2c-daac-42d6-a3d5-ade8062f53bc": { rows: 17, messages: 9, user: 1, assistant: 3, toolResult: 5, model: "glm-5.2", convertible: true },
    "f2f8141d-ba90-4b4b-95e5-9504d63bc5da": { rows: 117, messages: 72, user: 1, assistant: 33, toolResult: 38, model: "glm-5.2", convertible: true },
  };

  for (const item of manifest) {
    test(
      `${item.tag}（${item.id.slice(0, 8)}）`,
      { skip: present ? false : "fixtures 不在本机" },
      async () => {
        const expected = EXPECTED[item.id];
        assert.ok(expected !== undefined, "manifest 里有、快照表没有——新 fixture 要先锚定计数");
        const raw = await readFile(join(FIXTURES, `${item.id}.jsonl`), "utf8");
        const { rows } = parseClaudeRows(raw);
        const { messages } = claudeRowsToMessages(rows, "zai-coding");
        assert.equal(messages.some((m) => m.role === "assistant"), expected.convertible);
        if (!expected.convertible) {
          // 纯旧扁平：扫描口径是 unsupported-format
          assert.equal(rows.length, expected.rows);
          return;
        }
        assert.equal(rows.length, expected.rows, "主对话行数");
        assert.equal(messages.length, expected.messages, "消息总数");
        const byRole = messages.reduce<Record<string, number>>((acc, m) => {
          acc[m.role] = (acc[m.role] ?? 0) + 1;
          return acc;
        }, {});
        assert.equal(byRole["user"] ?? 0, expected.user);
        assert.equal(byRole["assistant"] ?? 0, expected.assistant);
        assert.equal(byRole["toolResult"] ?? 0, expected.toolResult);
        const lastAssistant = messages.filter((m) => m.role === "assistant").at(-1);
        assert.equal(lastAssistant?.role === "assistant" ? lastAssistant.model : null, expected.model);
        // 配对不变量：每条 toolResult 的 toolCallId 都能在前文 assistant 找到
        const callIds = new Set<string>();
        for (const m of messages) {
          if (m.role === "assistant") for (const b of m.content) if (b.type === "toolCall") callIds.add(b.id);
          if (m.role === "toolResult") assert.ok(callIds.has(m.toolCallId), `孤儿 toolResult ${m.toolCallId}`);
        }
        // 只读投影：每条消息都投成一条记录（空 error 回答除外，这批里没有）
        const records = messagesToRecords(messages, messages.flatMap((m) => (m.role === "user" ? ["shown"] : [])));
        assert.equal(records.length, expected.messages);
      },
    );
  }
});
