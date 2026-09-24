import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  claudeCodeRootUuid,
  claudeCodeUserText,
  parseClaudeCodeSession,
  parseClaudeDesktopSession,
} from "./claude-code.ts";
import { claudeRowsToMessages } from "./claude-legacy.ts";

let clock = Date.parse("2026-09-20T10:00:00.000Z");
function at(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

function user(uuid: string, parentUuid: string | null, content: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    isSidechain: false,
    cwd: "/repo/app",
    timestamp: at(),
    message: { role: "user", content },
    ...extra,
  });
}

function assistant(uuid: string, parentUuid: string, messageId: string, block: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    isSidechain: false,
    cwd: "/repo/app",
    timestamp: at(),
    message: {
      id: messageId,
      role: "assistant",
      model: "claude-opus-5-5",
      content: [block],
      stop_reason: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    },
    ...extra,
  });
}

function toolResult(uuid: string, parentUuid: string, toolUseId: string, text: string): string {
  return user(uuid, parentUuid, [{ type: "tool_result", tool_use_id: toolUseId, content: text }], {
    toolUseResult: { stdout: text },
  });
}

function attachment(uuid: string, parentUuid: string, body: Record<string, unknown>): string {
  return JSON.stringify({ type: "attachment", uuid, parentUuid, isSidechain: false, timestamp: at(), attachment: body });
}

function system(uuid: string, parentUuid: string, subtype: string): string {
  return JSON.stringify({ type: "system", subtype, uuid, parentUuid, isSidechain: false, timestamp: at() });
}

describe("parseClaudeCodeSession", () => {
  test("字符串形态的用户行包成 text 块；assistant 按 message.id 合组；显示文本与用户消息一一对得上", () => {
    const raw = [
      JSON.stringify({ type: "mode", mode: "default" }),
      user("u1", null, "修一下登录页"),
      assistant("a1", "u1", "m1", { type: "text", text: "先看代码" }),
      assistant("a2", "a1", "m1", { type: "tool_use", id: "t1", name: "Read", input: { path: "a.ts" } }),
      toolResult("r1", "a2", "t1", "file body"),
      assistant("a3", "r1", "m2", { type: "text", text: "改好了" }),
      system("s1", "a3", "turn_duration"),
      JSON.stringify({ type: "ai-title", aiTitle: "登录页修复" }),
    ].join("\n");
    const session = parseClaudeCodeSession(raw);
    assert.equal(session.cwd, "/repo/app");
    assert.equal(session.title, "登录页修复");
    assert.equal(session.firstPrompt, "修一下登录页");
    assert.equal(session.rootUuid, "u1");

    const { messages, userRowIndexes } = claudeRowsToMessages(session.rows, "anthropic");
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "toolResult", "assistant"],
    );
    assert.deepEqual(
      userRowIndexes.map((index) => session.displays[index]),
      ["修一下登录页"],
    );
  });

  test("sidechain / 附件 / system / 合成错误回复都不进对话；isMeta 进模型上下文但不显示", () => {
    const raw = [
      user("w1", null, "Warmup", { isSidechain: true }),
      user("u1", null, "你好"),
      attachment("x1", "u1", { type: "total_tokens_reminder" }),
      user("meta1", "x1", "[Image: original 100x100]", { isMeta: true }),
      assistant("e1", "meta1", "err", { type: "text", text: "API Error: 529" }, { isApiErrorMessage: true }),
      assistant("a1", "meta1", "m1", { type: "text", text: "你好！" }),
    ].join("\n");
    const session = parseClaudeCodeSession(raw);
    assert.equal(session.stats.apiErrors, 1);
    assert.equal(session.rootUuid, "u1");
    const { messages, userRowIndexes } = claudeRowsToMessages(session.rows, "anthropic");
    assert.equal(messages.length, 3);
    assert.deepEqual(
      userRowIndexes.map((index) => session.displays[index]),
      ["你好", null],
    );
    const reply = messages[2];
    assert.equal(reply?.role, "assistant");
    assert.equal(reply?.role === "assistant" ? reply.model : "", "claude-opus-5-5");
  });

  test("排队消息推迟到下一条 assistant 之前：不夹进并行工具结果中间，也不产生补位结果", () => {
    const raw = [
      user("u1", null, "跑两个检查"),
      assistant("a1", "u1", "m1", { type: "tool_use", id: "t1", name: "Bash", input: { command: "a" } }),
      assistant("a2", "a1", "m1", { type: "tool_use", id: "t2", name: "Bash", input: { command: "b" } }),
      toolResult("r1", "a1", "t1", "ok a"),
      attachment("q1", "r1", { type: "queued_command", prompt: "顺便看下日志", commandMode: "prompt" }),
      attachment("q2", "q1", { type: "queued_command", prompt: "<task-notification>done</task-notification>", commandMode: "task-notification" }),
      toolResult("r2", "a2", "t2", "ok b"),
      assistant("a3", "r2", "m2", { type: "text", text: "都过了" }),
    ].join("\n");
    const session = parseClaudeCodeSession(raw);
    assert.equal(session.stats.queued, 2);
    const { messages, stats, userRowIndexes } = claudeRowsToMessages(session.rows, "anthropic");
    assert.equal(stats.patchedToolCalls, 0);
    assert.equal(stats.orphanToolResults, 0);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "toolResult", "toolResult", "user", "user", "assistant"],
    );
    assert.deepEqual(
      userRowIndexes.map((index) => session.displays[index]),
      ["跑两个检查", "顺便看下日志", null],
    );
  });

  test("回退：用户写的行接回更早的一行，之后收的旧枝作废；只跳过几条非消息行不算回退", () => {
    const raw = [
      user("u1", null, "第一问"),
      assistant("a1", "u1", "m1", { type: "text", text: "第一答" }),
      system("s1", "a1", "turn_duration"),
      attachment("x1", "s1", { type: "total_tokens_reminder" }),
      // 接在 system 行后面而不是最后的附件后面：正常续问
      user("u2", "s1", "第二问"),
      assistant("a2", "u2", "m2", { type: "text", text: "旧的第二答" }),
      // 回退到第一答之后重写第二问
      user("u3", "a1", "第二问（改）"),
      assistant("a3", "u3", "m3", { type: "text", text: "新的第二答" }),
    ].join("\n");
    const session = parseClaudeCodeSession(raw);
    assert.equal(session.stats.rewinds, 1);
    const { messages, userRowIndexes } = claudeRowsToMessages(session.rows, "anthropic");
    assert.deepEqual(
      userRowIndexes.map((index) => session.displays[index]),
      ["第一问", "第二问（改）"],
    );
    assert.equal(messages.length, 4);
  });

  test("用户粘贴的图片进用户消息；只有图没有字的行显示空串", () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "aW1n" } };
    const raw = [
      user("u1", null, [image]),
      assistant("a1", "u1", "m1", { type: "text", text: "看到了" }),
    ].join("\n");
    const session = parseClaudeCodeSession(raw);
    const { messages, userRowIndexes } = claudeRowsToMessages(session.rows, "anthropic");
    const first = messages[0];
    assert.equal(first?.role, "user");
    assert.deepEqual(first?.role === "user" ? first.content : null, [{ type: "image", data: "aW1n", mimeType: "image/png" }]);
    assert.deepEqual(
      userRowIndexes.map((index) => session.displays[index]),
      [""],
    );
  });

  test("标题：最后一条 custom-title 优先于 ai-title；坏行跳过计数", () => {
    const raw = [
      JSON.stringify({ type: "custom-title", customTitle: "旧名" }),
      "{not json",
      user("u1", null, "hi"),
      JSON.stringify({ type: "ai-title", aiTitle: "模型起的" }),
      JSON.stringify({ type: "custom-title", customTitle: "新名" }),
    ].join("\n");
    const session = parseClaudeCodeSession(raw);
    assert.equal(session.title, "新名");
    assert.equal(session.stats.badLines, 1);
  });
});

describe("claudeCodeUserText", () => {
  test("斜杠命令折回用户打的样子", () => {
    assert.equal(
      claudeCodeUserText("<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>claude-sonnet-5</command-args>"),
      "/model claude-sonnet-5",
    );
    assert.equal(claudeCodeUserText("<command-name>login</command-name><command-args></command-args>"), "/login");
  });

  test("去 system-reminder、路径引号", () => {
    assert.equal(
      claudeCodeUserText('<system-reminder>\nworktree\n</system-reminder>\n看下 @"/a b/c.md" 和 @src/x.ts'),
      "看下 @/a b/c.md 和 @src/x.ts",
    );
  });

  test("Claude Code 自己生成的文字不显示", () => {
    assert.equal(claudeCodeUserText("[Request interrupted by user for tool use]"), null);
    assert.equal(claudeCodeUserText("<local-command-stdout>Login successful</local-command-stdout>"), null);
    assert.equal(claudeCodeUserText("<task-notification>\n<task-id>x</task-id>"), null);
    assert.equal(claudeCodeUserText('<cross-session-message from="uds:/tmp/a.sock">hi</cross-session-message>'), null);
  });

  test("用户自己写的标签原样保留", () => {
    assert.equal(claudeCodeUserText("<!-- reply -->\n> 引用\n\n回复"), "<!-- reply -->\n> 引用\n\n回复");
  });
});

describe("claudeCodeRootUuid", () => {
  test("跳过 sidechain 与非消息行；截断的末行不炸", () => {
    const head = [
      JSON.stringify({ type: "mode", mode: "default" }),
      user("w1", null, "Warmup", { isSidechain: true }),
      user("u1", null, "hi"),
      '{"type":"assistant","uuid":"a1"',
    ].join("\n");
    assert.equal(claudeCodeRootUuid(head), "u1");
    assert.equal(claudeCodeRootUuid(JSON.stringify({ type: "mode" })), null);
  });
});

describe("parseClaudeDesktopSession", () => {
  test("originCwd 优先；缺 cliSessionId 或坏 JSON 返回 null", () => {
    const parsed = parseClaudeDesktopSession(
      JSON.stringify({
        cliSessionId: "c3",
        priorCliSessionIds: ["c1", "c2", 7],
        title: " Handoff UI ",
        createdAt: 1790163914831,
        cwd: "/repo/app/.claude/worktrees/x",
        originCwd: "/repo/app",
      }),
    );
    assert.deepEqual(parsed, {
      cliSessionId: "c3",
      priorCliSessionIds: ["c1", "c2"],
      title: "Handoff UI",
      createdAt: 1790163914831,
      folder: "/repo/app",
    });
    assert.equal(parseClaudeDesktopSession(JSON.stringify({ title: "x" })), null);
    assert.equal(parseClaudeDesktopSession("{"), null);
  });
});
