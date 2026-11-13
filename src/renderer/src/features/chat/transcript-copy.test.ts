import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { TranscriptItem } from "@shared/transcript";
import type { TranscriptRecord } from "@shared/session";
import {
  shouldInterceptSelectAll,
  transcriptCopyText,
  type SelectAllFocus,
  type SelectAllKeyEvent,
} from "./transcript-copy.ts";

/** 测试用的最小条目工厂：只塞拼文本会读到的字段 */
function user(id: string, blocks: unknown[]): TranscriptRecord {
  return { id, role: "user", content: blocks, timestamp: 0 } as TranscriptItem;
}

function assistant(id: string, blocks: unknown[]): TranscriptRecord {
  return { id, role: "assistant", content: blocks, timestamp: 0 } as TranscriptItem;
}

function text(value: string): { type: "text"; text: string } {
  return { type: "text", text: value };
}

describe("transcriptCopyText", () => {
  test("user 与 assistant 的 text 块按顺序拼接，块间与记录间空一行", () => {
    const records: TranscriptRecord[] = [
      user("u1", [text("问一句")]),
      assistant("a1", [text("答一句")]),
      user("u2", [text("再问")]),
      assistant("a2", [text("再答")]),
    ];
    assert.equal(transcriptCopyText(records), "问一句\n\n答一句\n\n再问\n\n再答");
  });

  test("同一条记录里的多个 text 块逐块收，thinking / toolCall 块跳过", () => {
    const records: TranscriptRecord[] = [
      user("u1", [text("第一问")]),
      assistant("a1", [
        { type: "thinking", thinking: "这段不该进剪贴板" },
        text("第一块"),
        { type: "toolCall", toolCallId: "t1", toolName: "read", input: { path: "a.ts" } },
        text("第二块"),
      ]),
    ];
    assert.equal(transcriptCopyText(records), "第一问\n\n第一块\n\n第二块");
  });

  test("非对话记录整条跳过：工具结果、压缩摘要、通道标记、轮尾文件账", () => {
    const records: TranscriptRecord[] = [
      user("u1", [text("保留我")]),
      { role: "tool", id: "t1", toolCallId: "t1", toolName: "read", input: {}, content: [text("大工具输出")], timestamp: 0, status: "complete", isError: false } as TranscriptRecord,
      {
        role: "compacted",
        id: "c1",
        summary: "压缩摘要",
        tokensBefore: 1000,
        timestamp: 0,
      },
      {
        role: "channel-mark",
        id: "k1",
        peerId: "child",
        messageId: "m1",
        from: "child",
        kind: "question",
        timestamp: 0,
      },
      { role: "file-turn", id: "f1", timestamp: 0, changes: [] },
      assistant("a1", [text("也保留我")]),
    ];
    assert.equal(transcriptCopyText(records), "保留我\n\n也保留我");
  });

  test("空白块与空记录不占段；整段为空返回空串", () => {
    const records: TranscriptRecord[] = [
      user("u1", [text("  \n\t ")]),
      assistant("a1", [text("")]),
      user("u2", [text("唯一的正文")]),
      assistant("a2", [text(" \n ")]),
    ];
    assert.equal(transcriptCopyText(records), "唯一的正文");
    assert.equal(transcriptCopyText([]), "");
    assert.equal(transcriptCopyText([user("u1", [text("  ")])]), "");
  });

  test("块内原有换行与缩进原样保留", () => {
    const code = "```ts\n  const a = 1;\n\n  const b = 2;\n```";
    assert.equal(transcriptCopyText([assistant("a1", [text(code)])]), code);
  });
});

describe("shouldInterceptSelectAll", () => {
  const ctrlA: SelectAllKeyEvent = {
    key: "a",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
  };
  const metaA: SelectAllKeyEvent = { ...ctrlA, ctrlKey: false, metaKey: true };
  const inTranscript: SelectAllFocus = { tagName: "DIV", isContentEditable: false, inTranscript: true };
  const outside: SelectAllFocus = { tagName: "BODY", isContentEditable: false, inTranscript: false };

  test("焦点/选区在转录里：Ctrl+A 与 Cmd+A 都接管", () => {
    assert.equal(shouldInterceptSelectAll(ctrlA, inTranscript), true);
    assert.equal(shouldInterceptSelectAll(metaA, inTranscript), true);
  });

  test("点正文后焦点在 body、选区在转录里（inTranscript 由选区算出）仍接管", () => {
    assert.equal(
      shouldInterceptSelectAll(ctrlA, { tagName: "BODY", isContentEditable: false, inTranscript: true }),
      true,
    );
  });

  test("输入框里的 Ctrl+A 不接管：INPUT / TEXTAREA / contentEditable 优先", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "input", "textarea"]) {
      assert.equal(shouldInterceptSelectAll(ctrlA, { tagName, isContentEditable: false, inTranscript: true }), false);
    }
    assert.equal(shouldInterceptSelectAll(ctrlA, { tagName: "DIV", isContentEditable: true, inTranscript: true }), false);
  });

  test("焦点与选区都在转录外不接管", () => {
    assert.equal(shouldInterceptSelectAll(ctrlA, outside), false);
    assert.equal(shouldInterceptSelectAll(ctrlA, null), false);
  });

  test("组合键边界：无 Ctrl/Cmd、Alt、Shift 都不接管", () => {
    const plain: SelectAllKeyEvent = { ...ctrlA, ctrlKey: false };
    assert.equal(shouldInterceptSelectAll(plain, inTranscript), false);
    assert.equal(shouldInterceptSelectAll({ ...ctrlA, altKey: true }, inTranscript), false);
    assert.equal(shouldInterceptSelectAll({ ...ctrlA, shiftKey: true }, inTranscript), false);
  });

  test("非 A 键不接管；大小写不敏感（CapsLock 下 key 是 A）", () => {
    assert.equal(shouldInterceptSelectAll({ ...ctrlA, key: "c" }, inTranscript), false);
    assert.equal(shouldInterceptSelectAll({ ...ctrlA, key: "A" }, inTranscript), true);
  });
});
