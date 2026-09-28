import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import {
  opencodeSessionBytes,
  opencodeToMessages,
  opencodeUserText,
  readOpencodeMessages,
  readOpencodeSessions,
  withOpencodeDb,
  type OpencodeMessageRow,
} from "./opencode.ts";

let partSeq = 0;
function message(id: string, info: Record<string, unknown>, parts: Record<string, unknown>[]): OpencodeMessageRow {
  return {
    id,
    data: JSON.stringify(info),
    parts: parts.map((part) => ({ id: `prt_${String((partSeq += 1)).padStart(4, "0")}`, data: JSON.stringify(part) })),
  };
}
const user = (id: string, parts: Record<string, unknown>[], created = 1000): OpencodeMessageRow =>
  message(id, { role: "user", time: { created } }, parts);
const assistant = (id: string, parts: Record<string, unknown>[], extra: Record<string, unknown> = {}): OpencodeMessageRow =>
  message(id, { role: "assistant", time: { created: 2000 }, providerID: "zhipuai", modelID: "glm-5.1", ...extra }, parts);
const finish = (reason: string): Record<string, unknown> => ({
  type: "step-finish",
  reason,
  tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 2 } },
});
const tool = (callID: string, name: string, state: Record<string, unknown>): Record<string, unknown> => ({ type: "tool", callID, tool: name, state });

function describeMessages(messages: readonly Message[]): string[] {
  return messages.map((item) => {
    if (item.role === "user") {
      const content = (item as UserMessage).content;
      return `user:${typeof content === "string" ? content : content.map((block) => (block.type === "text" ? block.text : "img")).join("|")}`;
    }
    if (item.role === "assistant") {
      return `assistant:${(item as AssistantMessage).content.map((block) => (block.type === "text" ? block.text : block.type === "thinking" ? "think" : `call ${block.id}`)).join("|")}`;
    }
    return `result:${(item as ToolResultMessage).toolCallId}`;
  });
}

describe("opencodeUserText", () => {
  test("插件插的整段不显示；用户的话后面挂的 system-reminder 剥掉", () => {
    assert.equal(opencodeUserText("<system-reminder>\n[BACKGROUND TASK COMPLETED]\n…"), null);
    assert.equal(opencodeUserText("[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]\n…"), null);
    assert.equal(opencodeUserText("[search-mode]\nMAXIMIZE SEARCH EFFORT."), null);
    assert.equal(opencodeUserText("<ultrawork-mode>\n**MANDATORY**"), null);
    assert.equal(opencodeUserText("帮我写分镜。\n\n<system-reminder>\n<agent-context>\n  agent: Mavis\n</agent-context>\n</system-reminder>"), "帮我写分镜。");
    assert.equal(opencodeUserText("没闭合的\n<system-reminder>\nagent: x"), "没闭合的");
    assert.equal(opencodeUserText("[x] 这是用户自己写的清单"), "[x] 这是用户自己写的清单");
  });
});

describe("opencodeToMessages", () => {
  test("一条 assistant 按 step 拆，结果跟在各自的 step 后；synthetic 文字进 pi 不进 transcript；ignored 不进", () => {
    const parsed = opencodeToMessages(
      [
        user("msg_1", [
          { type: "text", text: "修一下测试" },
          { type: "text", text: "[analyze-mode]\nANALYSIS MODE." },
          { type: "text", text: "Called the Read tool with …", synthetic: true },
          { type: "text", text: "▣ DCP | removed", ignored: true },
          { type: "file", mime: "image/png", url: "data:image/png;base64,QUJD" },
          { type: "file", mime: "application/pdf", url: "data:application/pdf;base64,JVBE" },
          { type: "file", mime: "text/plain", url: "file:///repo/a.md" },
        ]),
        assistant("msg_2", [
          { type: "step-start" },
          { type: "reasoning", text: "先看看" },
          { type: "text", text: "我来读。" },
          tool("c1", "read", { status: "completed", input: { filePath: "a.py" }, output: "print(1)", attachments: [{ type: "file", mime: "image/png", url: "data:image/png;base64,WFla" }] }),
          tool("c2", "bash", { status: "error", input: { command: "false" }, error: "exit 1" }),
          finish("tool-calls"),
          { type: "patch", hash: "h", files: ["a.py"] },
          { type: "step-start" },
          { type: "text", text: "改好了。" },
          finish("stop"),
        ]),
      ],
      "zai",
      null,
    );
    assert.deepEqual(describeMessages(parsed.messages), [
      "user:修一下测试|[analyze-mode]\nANALYSIS MODE.|Called the Read tool with …|img",
      "assistant:think|我来读。|call c1|call c2",
      "result:c1",
      "result:c2",
      "assistant:改好了。",
    ]);
    assert.deepEqual(parsed.userDisplays, ["修一下测试"]);
    assert.equal(parsed.model, "glm-5.1");
    assert.equal(parsed.stats.droppedFiles, 1);
    const first = parsed.messages[1] as AssistantMessage;
    assert.deepEqual([first.api, first.provider, first.model, first.stopReason], ["openai-completions", "zai", "glm-5.1", "toolUse"]);
    assert.deepEqual(first.usage, {
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 2,
      totalTokens: 117,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const read = parsed.messages[2] as ToolResultMessage;
    assert.deepEqual([read.toolName, read.isError, read.content], [
      "read",
      false,
      [
        { type: "text", text: "print(1)" },
        { type: "image", data: "WFla", mimeType: "image/png" },
      ],
    ]);
    const failed = parsed.messages[3] as ToolResultMessage;
    assert.deepEqual([failed.isError, failed.content], [true, [{ type: "text", text: "exit 1" }]]);
    assert.equal((parsed.messages[4] as AssistantMessage).stopReason, "stop");
  });

  test("anthropic 的思考带签名；被打断的 step：悬空 toolCall 补结果、stopReason aborted", () => {
    const parsed = opencodeToMessages(
      [
        user("msg_1", [{ type: "text", text: "写个文件" }]),
        assistant(
          "msg_2",
          [
            { type: "step-start" },
            { type: "reasoning", text: "写吧", metadata: { anthropic: { signature: "sig" } } },
            tool("c1", "write", { status: "running", input: { filePath: "b.py" } }),
          ],
          { providerID: "anthropic", modelID: "claude-sonnet-4-5", error: { name: "MessageAbortedError", data: { message: "Aborted" } } },
        ),
        user("msg_3", [{ type: "text", text: "算了" }]),
      ],
      "anthropic",
      null,
    );
    assert.deepEqual(describeMessages(parsed.messages), ["user:写个文件", "assistant:think|call c1", "result:c1", "user:算了"]);
    const reply = parsed.messages[1] as AssistantMessage;
    assert.equal(reply.api, "anthropic-messages");
    assert.equal(reply.stopReason, "aborted");
    assert.deepEqual(reply.content[0], { type: "thinking", thinking: "写吧", thinkingSignature: "sig" });
    assert.equal(parsed.stats.patchedToolCalls, 1);
  });

  test("历史全留；摘要记成一处压缩（位置、全文、压缩前 token），压缩请求不导；撤回点之后的消息不导，带 partID 的从那个 part 截掉", () => {
    const rows = [
      user("msg_1", [{ type: "text", text: "一" }]),
      assistant("msg_2", [{ type: "step-start" }, { type: "text", text: "答一" }, finish("stop")]),
      user("msg_3", [{ type: "compaction", auto: true }]),
      assistant("msg_4", [{ type: "step-start" }, { type: "text", text: "摘要……" }, finish("stop")], { summary: true }),
      user("msg_5", [{ type: "text", text: "二" }]),
      assistant("msg_6", [{ type: "step-start" }, { type: "text", text: "答二前半" }, { type: "text", text: "答二后半" }, finish("stop")]),
      user("msg_7", [{ type: "text", text: "三" }]),
    ];
    const plain = opencodeToMessages(rows, "p", null);
    assert.deepEqual(describeMessages(plain.messages), ["user:一", "assistant:答一", "user:二", "assistant:答二前半|答二后半", "user:三"]);
    assert.equal(plain.stats.compactionMessages, 2);
    // 摘要落在「答一」之后（前面有 2 条消息）；tokensBefore = 摘要那一步的 input + cache（10 + 100 + 2）
    assert.deepEqual(
      plain.compactions.map((compaction) => [compaction.at, compaction.summary, compaction.tokensBefore]),
      [[2, "摘要……", 112]],
    );

    const reverted = opencodeToMessages(rows, "p", JSON.stringify({ messageID: "msg_7" }));
    assert.deepEqual(describeMessages(reverted.messages).at(-1), "assistant:答二前半|答二后半");
    assert.equal(reverted.stats.revertedMessages, 1);

    const partial = opencodeToMessages(rows, "p", JSON.stringify({ messageID: "msg_6", partID: rows[5]!.parts[2]!.id }));
    assert.deepEqual(describeMessages(partial.messages).slice(-2), ["user:二", "assistant:答二前半"]);
  });
});

describe("读 opencode 的库", () => {
  let root = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "orbita-opencode-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("只列根会话；默认标题算没有；消息按时间、part 按 id；只读打开", () => {
    const dbFile = join(root, "opencode.db");
    const db = new DatabaseSync(dbFile);
    db.exec(`
      create table session (id text primary key, project_id text, parent_id text, directory text, title text, time_created integer, time_updated integer, revert text);
      create table message (id text primary key, session_id text, time_created integer, time_updated integer, data text);
      create table part (id text primary key, message_id text, session_id text, time_created integer, time_updated integer, data text);
      insert into session values ('ses_a', 'p', null, '/repo', 'New session - 2026-01-17T07:10:22.607Z', 1, 2, null);
      insert into session values ('ses_b', 'p', null, '/repo', '修测试', 3, 4, '{"messageID":"msg_2"}');
      insert into session values ('ses_child', 'p', 'ses_b', '/repo', 'task', 5, 6, null);
      insert into message values ('msg_2', 'ses_b', 20, 20, '{"role":"assistant"}');
      insert into message values ('msg_1', 'ses_b', 10, 10, '{"role":"user"}');
      insert into part values ('prt_2', 'msg_1', 'ses_b', 0, 0, '{"type":"text","text":"b"}');
      insert into part values ('prt_1', 'msg_1', 'ses_b', 0, 0, '{"type":"text","text":"a"}');
      insert into part values ('prt_3', 'msg_2', 'ses_b', 0, 0, '{"type":"tool","state":{}}');
    `);
    db.close();
    withOpencodeDb(dbFile, (readonly) => {
      assert.deepEqual(
        readOpencodeSessions(readonly).map((session) => [session.id, session.title, session.revert]),
        [
          ["ses_a", null, null],
          ["ses_b", "修测试", '{"messageID":"msg_2"}'],
        ],
      );
      const rows = readOpencodeMessages(readonly, "ses_b");
      assert.deepEqual(rows.map((row) => [row.id, row.parts.map((part) => part.id)]), [
        ["msg_1", ["prt_1", "prt_2"]],
        ["msg_2", ["prt_3"]],
      ]);
      assert.ok(opencodeSessionBytes(readonly, "ses_b") > 0);
      assert.throws(() => readonly.exec("delete from session"), /readonly/i);
    });
  });
});
