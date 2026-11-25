import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { lastAssistantLineOf, malformedMessageCount, MOBILE_TAIL_TEXT_MAX_BYTES, tailEntriesOf, tailPageOf } from "./mobile-tail.ts";
import { MOBILE_LAST_LINE_MAX, MOBILE_TAIL_PAGE, MOBILE_TAIL_PAGE_MAX_BYTES, type TailEntry } from "./mobile.ts";
import type { CompactedRecord, SessionRecord } from "./session.ts";
import type { AssistantTranscriptItem, ToolTranscriptItem, TranscriptItem } from "@earendil-works/pi-protocol";

const user = (id: string, at: number, text = "看看这个", images = 0): TranscriptItem => ({
  id,
  role: "user",
  timestamp: at,
  content: [...(text === "" ? [] : [{ type: "text" as const, text }]), ...Array.from({ length: images }, () => ({ type: "image" as const, data: "", mimeType: "image/png" }))],
});

const said = (id: string, at: number, text: string, toolCalls = 0): TranscriptItem => ({
  id,
  role: "assistant",
  timestamp: at,
  status: "complete",
  stopReason: toolCalls > 0 ? "toolUse" : "stop",
  model: { provider: "p", id: "m" },
  content: [
    ...(text === "" ? [] : [{ type: "text" as const, text }]),
    ...Array.from({ length: toolCalls }, (_, i) => ({ type: "toolCall" as const, toolCallId: `${id}-${i}`, toolName: "read", input: {} })),
  ],
});

const ran = (id: string, at: number): ToolTranscriptItem => ({
  id,
  role: "tool",
  timestamp: at,
  toolCallId: id,
  toolName: "read",
  input: {},
  content: [],
  status: "complete",
  isError: false,
});

const failedRun = (id: string, at: number): ToolTranscriptItem => ({
  ...ran(id, at),
  status: "error",
  isError: true,
});

const compacted = (id: string, at: number): CompactedRecord => ({ role: "compacted", id, summary: "…", tokensBefore: 1, timestamp: at });

describe("尾部折成条目", () => {
  test("一条 user、一条 assistant、一轮三个工具调用折成一条 process", () => {
    const entries = tailEntriesOf([
      user("u1", 1, "帮我看一下这个文件"),
      said("a1", 2, "我先读一下", 3),
      ran("t1", 3),
      ran("t2", 4),
      failedRun("t3", 5),
      said("a2", 6, "看完了，第二行有个错别字。"),
    ]);
    assert.deepEqual(entries, [
      { id: "u1", at: 1, kind: "user", text: "帮我看一下这个文件" },
      { id: "a1", at: 2, kind: "assistant", text: "我先读一下" },
      { id: "t3", at: 5, kind: "process", steps: 3, failed: 1 },
      { id: "a2", at: 6, kind: "assistant", text: "看完了，第二行有个错别字。" },
    ]);
  });

  test("说了话的回答把过程切开；只有工具调用或只有思考的回答不切", () => {
    const thinking = (id: string, at: number): TranscriptItem =>
      ({
        ...said(id, at, ""),
        stopReason: "toolUse",
        content: [{ type: "thinking", thinking: "想一想" }, { type: "toolCall", toolCallId: `${id}-0`, toolName: "bash", input: {} }],
      }) as AssistantTranscriptItem;
    const entries = tailEntriesOf([
      user("u1", 1),
      said("a1", 2, "", 2), // 没说话，直接调工具
      ran("t1", 3),
      ran("t2", 4),
      thinking("a2", 5), // 一段思考 + 继续调工具：不打断
      ran("t3", 6),
      said("a3", 7, "先到这里，我再查一下", 1), // 说话了：过程收尾
      ran("t4", 8),
      said("a4", 9, "查完了。"),
    ]);
    assert.deepEqual(entries, [
      { id: "u1", at: 1, kind: "user", text: "看看这个" },
      { id: "t3", at: 6, kind: "process", steps: 3, failed: 0 },
      { id: "a3", at: 7, kind: "assistant", text: "先到这里，我再查一下" },
      { id: "t4", at: 8, kind: "process", steps: 1, failed: 0 },
      { id: "a4", at: 9, kind: "assistant", text: "查完了。" },
    ]);
  });

  test("compacted、file-turn、revert、undo、channel-mark、intent-recall 不给，但会切断过程", () => {
    const skipped = [
      { role: "file-turn", id: "f1", timestamp: 10, changes: [] },
      { role: "undo", id: "x1", timestamp: 11, turnId: "t" },
      { role: "revert", id: "x2", timestamp: 12, targetMessageId: "u1", restored: [] },
      { role: "channel-mark", id: "x3", timestamp: 13, peerId: "p", messageId: "m", from: "parent", kind: "task" },
      { role: "intent-recall", id: "x4", timestamp: 14, turnId: "u1", status: "done", runId: null, startedAt: 0, finishedAt: 0, scene: null, qaTotal: null, passed: null, budgetMs: null, peak: false, timings: null, summary: null, selected: [], ask: [], error: null, skipped: null, gateWhy: null, halted: null },
    ] as unknown as SessionRecord[];
    const entries = tailEntriesOf([user("u1", 1), ran("t1", 2), ...skipped, compacted("c1", 15), ran("t2", 16), said("a1", 17, "好")]);
    assert.deepEqual(entries, [
      { id: "u1", at: 1, kind: "user", text: "看看这个" },
      { id: "t1", at: 2, kind: "process", steps: 1, failed: 0 },
      { id: "t2", at: 16, kind: "process", steps: 1, failed: 0 },
      { id: "a1", at: 17, kind: "assistant", text: "好" },
    ]);
  });

  test("用户消息只给自己打的那部分，并数清带了几张图", () => {
    const quoted = `<quoted_context index="1" role="user" turn="3">
<before>x</before>
<quoted>被引用的一长段</quoted>
<after>y</after>
</quoted_context>

真正想说的一句话`;
    const entries = tailEntriesOf([user("u1", 1, quoted, 2), user("u2", 2, "", 1), user("u3", 3, "<mentioned_tools>\n/skill:x\n</mentioned_tools>\n\n写个脚本")]);
    assert.deepEqual(entries, [
      { id: "u1", at: 1, kind: "user", text: "真正想说的一句话", images: 2 },
      { id: "u2", at: 2, kind: "user", images: 1 },
      { id: "u3", at: 3, kind: "user", text: "写个脚本" },
    ]);
  });

  test("单条文字超过上限时按字符边界截断并说明去哪看", () => {
    const long = "字".repeat(MOBILE_TAIL_TEXT_MAX_BYTES);
    const [entry] = tailEntriesOf([said("a1", 1, long)]);
    assert.ok(entry?.text !== undefined);
    assert.ok(new TextEncoder().encode(entry.text).length <= MOBILE_TAIL_TEXT_MAX_BYTES);
    assert.ok(!entry.text.includes("\ufffd"), "没把字符劈开");
    assert.match(entry.text, /完整内容在电脑上看/);
    // 多字节的字符不会刚好卡在边界上：截掉了一点，没超
    assert.ok(entry.text.length < long.length);
  });
});

describe("agent 最近一句", () => {
  test("取最后一条说了话的回答的首行，截到 120 个字符", () => {
    const line = "第".repeat(MOBILE_LAST_LINE_MAX + 5);
    assert.equal(lastAssistantLineOf([user("u1", 1), said("a1", 2, line)]), `${"第".repeat(MOBILE_LAST_LINE_MAX)}…`);
    assert.equal(lastAssistantLineOf([said("a1", 2, "早先的话"), user("u2", 3), said("a2", 4, "  第一行有时间\n\n第二行不取 ")]), "第一行有时间");
  });

  test("跳过只有工具调用 / 思考的回答与工具记录；没说过话是 null", () => {
    assert.equal(lastAssistantLineOf([said("a1", 1, "", 1), ran("t1", 2)]), null);
    assert.equal(lastAssistantLineOf([]), null);
    assert.equal(lastAssistantLineOf([user("u1", 1)]), null);
    assert.equal(lastAssistantLineOf([said("a1", 1, "旧的"), said("a2", 2, "", 1), ran("t1", 3)]), "旧的");
  });
});

describe("转录里的坏记录", () => {
  // parseLogLine 只拒非对象行：长着消息的脸、却没有 content 的行照样放行——SessionRecord 的类型在这里说了谎
  const noContent = (id: string, role: "user" | "assistant"): SessionRecord => ({ id, role, timestamp: 1 } as unknown as SessionRecord);

  test("缺 content 的 user / assistant 记录当没有这条：不抛、不出条目、也不打断正在进行的过程", () => {
    const records = [user("u1", 1), noContent("a-bad", "assistant"), said("a1", 2, "好的那句"), noContent("u-bad", "user"), ran("t1", 3), ran("t2", 4), said("a2", 5, "做完了")];
    assert.equal(malformedMessageCount(records), 2);
    assert.deepEqual(tailEntriesOf(records), [
      { id: "u1", at: 1, kind: "user", text: "看看这个" },
      { id: "a1", at: 2, kind: "assistant", text: "好的那句" },
      { id: "t2", at: 4, kind: "process", steps: 2, failed: 0 },
      { id: "a2", at: 5, kind: "assistant", text: "做完了" },
    ]);
  });

  test("agent 最近一句跳过坏记录：取得到末尾说了话的那句；只有坏记录是 null", () => {
    assert.equal(lastAssistantLineOf([noContent("a-bad", "assistant"), said("a1", 2, "末尾这句")]), "末尾这句");
    assert.equal(lastAssistantLineOf([said("a0", 1, "旧的"), noContent("a-bad", "assistant")]), "旧的");
    assert.equal(lastAssistantLineOf([noContent("a-bad", "assistant")]), null);
  });

  test("content 里混了非对象、或者文字块没有 text：那一块不要，其余照常", () => {
    const holes = { id: "a1", role: "assistant", timestamp: 1, content: [null, { type: "text" }, { type: "text", text: "真的一句" }, "裸字符串"] } as unknown as SessionRecord;
    assert.deepEqual(tailEntriesOf([holes]), [{ id: "a1", at: 1, kind: "assistant", text: "真的一句" }]);
    assert.equal(lastAssistantLineOf([holes]), "真的一句");
    assert.equal(malformedMessageCount([holes]), 0, "content 是数组，只是里面有洞，不算坏记录");
  });
});

describe("分页", () => {
  const many: TailEntry[] = Array.from({ length: 150 }, (_, i) => ({ id: `e${i}`, at: i, kind: "user", text: `第 ${i} 条` }));

  test("不给 before：最后一页至多 60 条，hasMore 看前面还有没有", () => {
    const page = tailPageOf(many, undefined);
    assert.ok(page);
    assert.equal(page.entries.length, MOBILE_TAIL_PAGE);
    assert.equal(page.entries[0]?.id, "e90");
    assert.equal(page.hasMore, true);
    const short = tailPageOf(many.slice(0, 10), undefined);
    assert.ok(short);
    assert.equal(short.entries.length, 10);
    assert.equal(short.hasMore, false);
  });

  test("给 before：取它之前的那一页；锚点不在这一段里返回 null", () => {
    const page = tailPageOf(many, "e90");
    assert.ok(page);
    assert.equal(page.entries[0]?.id, "e30");
    assert.equal(page.entries.at(-1)?.id, "e89");
    assert.equal(page.hasMore, true);
    const last = tailPageOf(many, "e30");
    assert.ok(last);
    assert.equal(last.entries.length, 30);
    assert.equal(last.hasMore, false);
    assert.equal(tailPageOf(many, "e0")?.entries.length, 0);
    assert.equal(tailPageOf(many, "nope"), null);
  });

  test("一页的字节上限：够 60 条但太重时少给几条", () => {
    const heavy: TailEntry[] = Array.from({ length: 100 }, (_, i) => ({ id: `h${i}`, at: i, kind: "assistant", text: "x".repeat(8_000) }));
    const page = tailPageOf(heavy, undefined);
    assert.ok(page);
    const bytes = new TextEncoder().encode(JSON.stringify(page.entries)).length;
    assert.ok(bytes <= MOBILE_TAIL_PAGE_MAX_BYTES, `${bytes}`);
    assert.ok(page.entries.length < MOBILE_TAIL_PAGE && page.entries.length > 10, `${page.entries.length}`);
    assert.equal(page.hasMore, true);
    // 最尾那一条无论如何都给
    const giant: TailEntry[] = [{ id: "g", at: 0, kind: "assistant", text: "y".repeat(200_000) }];
    assert.deepEqual(tailPageOf(giant, undefined), { entries: giant, hasMore: false });
  });
});
