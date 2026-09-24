import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai";
import { kimiBlobRefs, parseKimiSessionState, parseKimiWire } from "./kimi-code.ts";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

/** wire 的一行（time 递增，便于断言顺序）。 */
let clock = 1000;
function rec(record: Record<string, unknown>): string {
  clock += 1;
  return JSON.stringify({ ...record, time: clock });
}
function user(text: string, origin: Record<string, unknown> = { kind: "user" }, id?: string): string {
  return rec({ type: "context.append_message", message: { role: "user", content: [{ type: "text", text }], toolCalls: [], origin, ...(id === undefined ? null : { id }) } });
}
function loop(event: Record<string, unknown>): string {
  return rec({ type: "context.append_loop_event", agentId: "main", event });
}
const begin = (uuid: string): string => loop({ type: "step.begin", uuid, turnId: "0", step: 1 });
const think = (text: string): string => loop({ type: "content.part", part: { type: "think", think: text, reasoningKey: "reasoning_content" } });
const say = (text: string): string => loop({ type: "content.part", part: { type: "text", text } });
const call = (id: string, name: string, args: Record<string, unknown> = {}): string => loop({ type: "tool.call", toolCallId: id, name, args });
const result = (id: string, output: unknown, extra: Record<string, unknown> = {}): string =>
  loop({ type: "tool.result", toolCallId: id, result: { output, ...extra } });
const end = (uuid: string, finishReason: string): string =>
  loop({ type: "step.end", uuid, finishReason, usage: { inputOther: 10, output: 5, inputCacheRead: 100, inputCacheCreation: 0 } });

function userText(message: UserMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "img")).join("|");
}

function roles(messages: readonly Message[]): string[] {
  return messages.map((message) =>
    message.role === "user"
      ? `user:${userText(message as UserMessage)}`
      : message.role === "assistant"
        ? `assistant:${(message as AssistantMessage).content.map((block) => (block.type === "text" ? block.text : block.type === "thinking" ? "think" : `call ${block.id}`)).join("|")}`
        : `result:${(message as ToolResultMessage).toolCallId}`,
  );
}

describe("parseKimiSessionState", () => {
  test("New Session 不算标题；新旧两种时间都认；坏 JSON 返回 null", () => {
    assert.deepEqual(parseKimiSessionState(JSON.stringify({ title: "New Session", isCustomTitle: false, createdAt: "2026-06-23T11:32:27.132Z" })), {
      title: null,
      cwd: null,
      createdAt: Date.parse("2026-06-23T11:32:27.132Z"),
      updatedAt: null,
    });
    assert.equal(parseKimiSessionState(JSON.stringify({ title: "修 bug", cwd: "/repo", createdAt: 5, updatedAt: 9 }))?.title, "修 bug");
    assert.equal(parseKimiSessionState("{"), null);
  });
});

describe("parseKimiWire", () => {
  test("一轮带工具：step 拼成 assistant、结果跟在后面；注入进 pi 不进 transcript；思考带回原字段", () => {
    const raw = [
      rec({ type: "metadata", protocol_version: "1.5" }),
      user("看看这个视频"),
      user("<system-reminder>Today's date is 2026-09-21.</system-reminder>", { kind: "injection", variant: "date_change" }),
      rec({ type: "llm.request", model: "k3", modelAlias: "kimi-code/k3" }),
      begin("s1"),
      think("先看文件"),
      say("我来读一下。"),
      call("t1", "ReadMediaFile", { path: "/tmp/f.jpg" }),
      result("t1", [
        { type: "text", text: '<image path="/tmp/f.jpg">' },
        { type: "image_url", imageUrl: { url: `blobref:image/jpeg;${SHA_A}` } },
        { type: "image_url", imageUrl: { url: `blobref:image/png;${SHA_B}` } },
      ], { note: "<system>Read image file.</system>" }),
      end("s1", "tool_use"),
      begin("s2"),
      say("是一段录屏。"),
      end("s2", "end_turn"),
      rec({ type: "usage.record", usage: {} }),
    ].join("\n");
    assert.deepEqual(kimiBlobRefs(raw), [SHA_A, SHA_B]);
    const parsed = parseKimiWire(raw, "kimi", new Map([[SHA_A, "QUJD"]]));
    assert.deepEqual(roles(parsed.messages), [
      "user:看看这个视频",
      "user:<system-reminder>Today's date is 2026-09-21.</system-reminder>",
      "assistant:think|我来读一下。|call t1",
      "result:t1",
      "assistant:是一段录屏。",
    ]);
    assert.deepEqual(parsed.userDisplays, ["看看这个视频", null]);
    assert.equal(parsed.model, "k3");
    assert.equal(parsed.firstPrompt, "看看这个视频");
    const first = parsed.messages[2] as AssistantMessage;
    assert.equal(first.api, "openai-completions");
    assert.equal(first.provider, "kimi");
    assert.equal(first.model, "k3");
    assert.equal(first.stopReason, "toolUse");
    assert.deepEqual(first.content[0], { type: "thinking", thinking: "先看文件", thinkingSignature: "reasoning_content" });
    assert.deepEqual(first.usage, {
      input: 10,
      output: 5,
      cacheRead: 100,
      cacheWrite: 0,
      totalTokens: 115,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
    const toolResult = parsed.messages[3] as ToolResultMessage;
    assert.equal(toolResult.toolName, "ReadMediaFile");
    assert.deepEqual(toolResult.content, [
      { type: "text", text: '<image path="/tmp/f.jpg">' },
      { type: "image", data: "QUJD", mimeType: "image/jpeg" },
      { type: "text", text: "[image not available in the imported copy]" },
      { type: "text", text: "<system>Read image file.</system>" },
    ]);
    assert.equal(parsed.stats.missingImages, 1);
    assert.equal((parsed.messages[4] as AssistantMessage).stopReason, "stop");
  });

  test("step 进行中到达的通知排在结果之后；用户敲的 /技能 按命令显示，模型调的技能正文不显示", () => {
    const raw = [
      user("转写这段音频"),
      begin("s1"),
      call("t1", "Bash"),
      user("<notification>task done</notification>", { kind: "task", taskId: "bash-1" }),
      result("t1", "ok"),
      end("s1", "tool_use"),
      user("# Archify …", { kind: "skill_activation", skillName: "archify", skillArgs: "a.mov", trigger: "user-slash" }),
      user("# Audio …", { kind: "skill_activation", skillName: "audio", trigger: "model-tool" }),
      begin("s2"),
      say("好。"),
      end("s2", "end_turn"),
    ].join("\n");
    const parsed = parseKimiWire(raw, "p", new Map());
    assert.deepEqual(roles(parsed.messages), [
      "user:转写这段音频",
      "assistant:call t1",
      "result:t1",
      "user:<notification>task done</notification>",
      "user:# Archify …",
      "user:# Audio …",
      "assistant:好。",
    ]);
    assert.deepEqual(parsed.userDisplays, ["转写这段音频", null, "/archify a.mov", null]);
  });

  test("被打断的 step：悬空 toolCall 补结果；孤儿结果丢弃；空 step 不产出消息", () => {
    const raw = [
      user("跑一下"),
      begin("s1"),
      call("t1", "Bash"),
      end("s1", "interrupted"),
      result("ghost", "?"),
      begin("s2"),
      end("s2", "interrupted"),
      user("继续"),
      begin("s3"),
      say("好的"),
      end("s3", "end_turn"),
    ].join("\n");
    const parsed = parseKimiWire(raw, "p", new Map());
    assert.deepEqual(roles(parsed.messages), ["user:跑一下", "assistant:call t1", "result:t1", "user:继续", "assistant:好的"]);
    assert.equal((parsed.messages[1] as AssistantMessage).stopReason, "aborted");
    assert.equal((parsed.messages[2] as ToolResultMessage).isError, true);
    assert.equal(parsed.stats.patchedToolCalls, 1);
    assert.equal(parsed.stats.orphanToolResults, 1);
  });

  test("撤回：去掉最近的用户回合与它带的注入；撤不过 clear", () => {
    const turn = (text: string, id: string, reply: string): string[] => [
      user("<system-reminder>date</system-reminder>", { kind: "injection", ownerPromptId: id }),
      user(text, { kind: "user" }, id),
      begin(`s-${id}`),
      say(reply),
      end(`s-${id}`, "end_turn"),
    ];
    const raw = [
      ...turn("一", "p1", "答一"),
      rec({ type: "context.clear" }),
      ...turn("二", "p2", "答二"),
      ...turn("三", "p3", "答三"),
      rec({ type: "context.undo", count: 1 }),
      ...turn("三改", "p4", "答三改"),
      rec({ type: "context.undo", count: 5 }),
    ].join("\n");
    const parsed = parseKimiWire(raw, "p", new Map());
    assert.deepEqual(
      roles(parsed.messages).filter((line) => !line.includes("system-reminder")),
      ["user:一", "assistant:答一", "user:二", "assistant:答二", "user:三改", "assistant:答三改"],
    );
    // 「三」那一回合连同它的注入一起撤掉；count 超出可撤的回合数（越过 clear）时不撤
    assert.equal(parsed.stats.undoneMessages, 3);
  });

  test("分支式撤回：活动链 = 基线到 base.line + 新分支；配对的旧式 undo 行不再重复撤", () => {
    const lines = [
      user("一"), // 1
      begin("s1"), // 2
      say("答一"), // 3
      end("s1", "end_turn"), // 4
      user("二"), // 5
      begin("s2"), // 6
      say("答二"), // 7
      end("s2", "end_turn"), // 8
      rec({ type: "agent.switched", branch: "b1", base: { branch: "main", line: 4 }, legacyUndoLine: 10 }), // 9
      rec({ type: "context.undo", count: 1 }), // 10
      rec({ type: "context.undone" }), // 11
      user("二改"), // 12
      begin("s3"), // 13
      say("答二改"), // 14
      end("s3", "end_turn"), // 15
    ];
    const parsed = parseKimiWire(lines.join("\n"), "p", new Map());
    assert.deepEqual(roles(parsed.messages), ["user:一", "assistant:答一", "user:二改", "assistant:答二改"]);
    assert.equal(parsed.stats.undoneMessages, 0);
  });
});
