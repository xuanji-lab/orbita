import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { addUnread, clearUnread, planNotice, settledSessions, type PhaseSlot } from "./completion-notice.ts";

const slot = (phase: PhaseSlot["phase"], queued = 0): PhaseSlot => ({ phase, queued: Array(queued).fill(null) });
const map = (entries: Record<string, PhaseSlot>) => new Map(Object.entries(entries));

describe("settledSessions", () => {
  it("turn → idle 且队列空算跑完", () => {
    deepStrictEqual(settledSessions(map({ a: slot("turn") }), map({ a: slot("idle") })), ["a"]);
  });

  it("压缩中 → idle 也算跑完（压缩是这一轮的尾巴）", () => {
    deepStrictEqual(settledSessions(map({ a: slot("compaction") }), map({ a: slot("idle") })), ["a"]);
  });

  it("idle 那拍队列里还有排队消息不算——下一条马上要投递", () => {
    deepStrictEqual(settledSessions(map({ a: slot("turn") }), map({ a: slot("idle", 1) })), []);
  });

  it("一直 idle、一直在跑、新建的槽都不算", () => {
    deepStrictEqual(
      settledSessions(
        map({ idle: slot("idle"), busy: slot("turn") }),
        map({ idle: slot("idle"), busy: slot("turn"), fresh: slot("idle") }),
      ),
      [],
    );
  });

  it("多条同拍落定全部报出", () => {
    deepStrictEqual(
      settledSessions(map({ a: slot("turn"), b: slot("turn") }), map({ a: slot("idle"), b: slot("idle") })),
      ["a", "b"],
    );
  });
});

describe("planNotice", () => {
  it("正看着且窗口在前台：什么都不做", () => {
    deepStrictEqual(planNotice({ watched: true, windowActive: true, soundOn: true }), { sound: false, unread: false });
  });

  it("正看着但窗口在后台：只响不标未读", () => {
    deepStrictEqual(planNotice({ watched: true, windowActive: false, soundOn: true }), { sound: true, unread: false });
  });

  it("没在看：响 + 未读", () => {
    deepStrictEqual(planNotice({ watched: false, windowActive: true, soundOn: true }), { sound: true, unread: true });
  });

  it("关了提示音：不响，但未读照标", () => {
    deepStrictEqual(planNotice({ watched: false, windowActive: false, soundOn: false }), { sound: false, unread: true });
    deepStrictEqual(planNotice({ watched: true, windowActive: false, soundOn: false }), { sound: false, unread: false });
  });
});

describe("未读集合", () => {
  it("没有变化时返回原引用", () => {
    const unread: ReadonlySet<string> = new Set(["a"]);
    strictEqual(addUnread(unread, ["a"]), unread);
    strictEqual(clearUnread(unread, ["b"]), unread);
  });

  it("加与清", () => {
    const added = addUnread(new Set(["a"]), ["b"]);
    deepStrictEqual([...added].sort(), ["a", "b"]);
    deepStrictEqual([...clearUnread(added, ["a", "x"])], ["b"]);
  });
});
