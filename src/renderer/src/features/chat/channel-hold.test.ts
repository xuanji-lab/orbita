import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import type { ChannelMessage } from "../../../../shared/channel.ts";
import {
  addHeld,
  decodePending,
  dropAnsweredQuestions,
  encodePending,
  oneLine,
  orderForDelivery,
  READING_QUIET_MS,
  readingReason,
  removeHeld,
  shouldAutoRelease,
  shouldHold,
  summarizeHeld,
  type HeldReport,
  type ReadingSignals,
} from "./channel-hold.ts";

const calm: ReadingSignals = {
  windowFocused: true,
  draftNonEmpty: false,
  viewed: true,
  scrolledUp: false,
  lastActivityAt: null,
};

function report(id: string, childId: string, kind: ChannelMessage["kind"], text = id, createdAt = 1, recovered = false): HeldReport {
  return {
    id,
    childId,
    childWorkbench: `/wb/${childId}`,
    recovered,
    message: { id, from: "child", author: "model", kind, text, delivery: "followUp", createdAt },
  };
}

describe("readingReason：用户在读 / 在写吗", () => {
  it("什么信号都没有 = 不在读", () => {
    strictEqual(readingReason(calm, 1_000_000), null);
  });

  it("输入框有未发送的字：在写，不论这条会话有没有被看着", () => {
    strictEqual(readingReason({ ...calm, draftNonEmpty: true }, 0), "draft");
    strictEqual(readingReason({ ...calm, draftNonEmpty: true, viewed: false }, 0), "draft");
  });

  it("对话列不在底部：在读，但只有这条会话被看着才算", () => {
    strictEqual(readingReason({ ...calm, scrolledUp: true }, 0), "scrolled-up");
    strictEqual(readingReason({ ...calm, scrolledUp: true, viewed: false }, 0), null);
  });

  it("最近 N 秒内动过：N 之内算，刚好到 N 就不算（静止窗口是左闭右开）", () => {
    const at = 50_000;
    strictEqual(readingReason({ ...calm, lastActivityAt: at }, at + READING_QUIET_MS - 1), "active");
    strictEqual(readingReason({ ...calm, lastActivityAt: at }, at + READING_QUIET_MS), null);
    strictEqual(readingReason({ ...calm, lastActivityAt: at }, at + 600, 500), null, "quietMs 可调");
  });

  it("没被看着的会话，动静不算它的阅读", () => {
    strictEqual(readingReason({ ...calm, viewed: false, lastActivityAt: 10 }, 11), null);
  });

  it("窗口不在前台：用户不在，等回来", () => {
    strictEqual(readingReason({ ...calm, windowFocused: false }, 0), "background");
    strictEqual(readingReason({ ...calm, windowFocused: false, viewed: false }, 0), "background");
  });

  it("多个原因并存时，输入框 > 往上翻 > 刚动过 > 窗口在后台", () => {
    const all = { ...calm, draftNonEmpty: true, scrolledUp: true, lastActivityAt: 1, windowFocused: false };
    strictEqual(readingReason(all, 2), "draft");
    strictEqual(readingReason({ ...all, draftNonEmpty: false }, 2), "scrolled-up");
    strictEqual(readingReason({ ...all, draftNonEmpty: false, scrolledUp: false }, 2), "active");
    strictEqual(readingReason({ ...all, draftNonEmpty: false, scrolledUp: false, lastActivityAt: null }, 2), "background");
  });

  it("回到底部 + 清空输入框之后仍要静止一阵：回底那一下滚动自己就是一次活动", () => {
    const t0 = 100_000;
    // 往上翻着
    strictEqual(readingReason({ ...calm, scrolledUp: true, lastActivityAt: t0 - 60_000 }, t0), "scrolled-up");
    // 滚回底部（活动时刻 = t0）：scrolledUp 已清，但静止窗口还没过
    strictEqual(readingReason({ ...calm, lastActivityAt: t0 }, t0 + 1_000), "active");
    strictEqual(readingReason({ ...calm, lastActivityAt: t0 }, t0 + READING_QUIET_MS + 1), null);
  });
});

describe("shouldHold / shouldAutoRelease", () => {
  it("开关开着：一律攒；开关关着：在读才攒；forced 永不攒", () => {
    strictEqual(shouldHold({ holdOn: true, reading: null, forced: false }), true);
    strictEqual(shouldHold({ holdOn: false, reading: "draft", forced: false }), true);
    strictEqual(shouldHold({ holdOn: false, reading: null, forced: false }), false);
    strictEqual(shouldHold({ holdOn: true, reading: "draft", forced: true }), false);
  });

  const live = [report("a", "c1", "done")];
  it("四个条件同时成立才自动投：开关关、父空闲、没在读、有非恢复项", () => {
    const ok = { holdOn: false, phase: "idle" as const, reading: null, held: live };
    strictEqual(shouldAutoRelease(ok), true);
    strictEqual(shouldAutoRelease({ ...ok, holdOn: true }), false);
    strictEqual(shouldAutoRelease({ ...ok, phase: "turn" }), false);
    strictEqual(shouldAutoRelease({ ...ok, phase: "compaction" }), false);
    strictEqual(shouldAutoRelease({ ...ok, reading: "active" }), false);
    strictEqual(shouldAutoRelease({ ...ok, held: [] }), false);
  });

  it("重启恢复出来的不自动投，哪怕什么条件都满足；混着有新的就一起投", () => {
    const base = { holdOn: false, phase: "idle" as const, reading: null };
    strictEqual(shouldAutoRelease({ ...base, held: [report("r", "c1", "done", "r", 1, true)] }), false);
    strictEqual(
      shouldAutoRelease({ ...base, held: [report("r", "c1", "done", "r", 1, true), report("n", "c2", "done")] }),
      true,
    );
  });
});

describe("攒着的增删", () => {
  it("addHeld 按 id 去重（同一条事件重复到达），removeHeld 找不到返回同一引用", () => {
    const a = report("a", "c1", "done");
    const once = addHeld([], a);
    strictEqual(addHeld(once, a), once);
    strictEqual(removeHeld(once, new Set(["zzz"])), once);
    deepStrictEqual(removeHeld(once, new Set(["a"])), []);
  });

  it("dropAnsweredQuestions：只丢该子会话里不晚于回复的 question，其余不动", () => {
    const list = [
      report("q-old", "c1", "question", "q", 5),
      report("q-new", "c1", "question", "q", 20),
      report("d1", "c1", "done", "d", 6),
      report("q-other", "c2", "question", "q", 5),
    ];
    deepStrictEqual(
      dropAnsweredQuestions(list, "c1", 10).map((item) => item.id),
      ["q-new", "d1", "q-other"],
    );
    strictEqual(dropAnsweredQuestions(list, "c9", 99), list);
  });
});

describe("合并投递的顺序", () => {
  const rank = (id: string): number => ({ c1: 0, c2: 1, c3: 2 })[id] ?? Infinity;

  it("先按子会话（派出先后），同一子会话内按消息时间", () => {
    const list = [
      report("c3-done", "c3", "done", "x", 1),
      report("c2-late", "c2", "done", "x", 9),
      report("c1-done", "c1", "done", "x", 7),
      report("c2-early", "c2", "progress", "x", 3),
    ];
    deepStrictEqual(
      orderForDelivery(list, rank).map((item) => item.id),
      ["c1-done", "c2-early", "c2-late", "c3-done"],
    );
  });

  it("不认识的子会话排最后，彼此保持到达先后，且同一个子会话不被别人隔开", () => {
    const list = [report("u1a", "u1", "done", "x", 1), report("u2", "u2", "done", "x", 2), report("u1b", "u1", "done", "x", 3), report("k", "c1", "done", "x", 4)];
    deepStrictEqual(
      orderForDelivery(list, rank).map((item) => item.id),
      ["k", "u1a", "u1b", "u2"],
    );
  });

  it("不改入参", () => {
    const list = [report("b", "c2", "done"), report("a", "c1", "done")];
    orderForDelivery(list, rank);
    deepStrictEqual(list.map((item) => item.id), ["b", "a"]);
  });
});

describe("提示条摘要", () => {
  it("每个子会话一行；来自几个子会话数的是子会话不是条数", () => {
    const summary = summarizeHeld([
      report("a1", "c1", "progress", "跑到一半", 1),
      report("a2", "c1", "done", "# 做完了\n细节", 2),
      report("b1", "c2", "failed", "构建挂了", 3),
    ]);
    strictEqual(summary.children, 2);
    deepStrictEqual(summary.rows, [
      { childId: "c1", count: 2, kind: "done", summary: "做完了" },
      { childId: "c2", count: 1, kind: "failed", summary: "构建挂了" },
    ]);
    strictEqual(summary.hasQuestion, false);
  });

  it("有 question：标出来，而且 question 压过同一子会话后来的进度", () => {
    const summary = summarizeHeld([
      report("q", "c1", "question", "要不要继续？", 1),
      report("p", "c1", "progress", "还在跑", 2),
      report("d", "c2", "done", "好了", 3),
    ]);
    strictEqual(summary.hasQuestion, true);
    strictEqual(summary.questions, 1);
    strictEqual(summary.rows[0]?.kind, "question");
  });

  it("空列表 = 0 个、没有 question", () => {
    deepStrictEqual(summarizeHeld([]), { children: 0, rows: [], hasQuestion: false, questions: 0 });
  });

  it("oneLine 取首个非空行、去 markdown 前缀、超长截断", () => {
    strictEqual(oneLine("\n\n  ## 标题行\n下一行"), "标题行");
    strictEqual(oneLine("- 列表项"), "列表项");
    strictEqual(oneLine("一二三四五六七八九十", 5), "一二三四…");
    strictEqual(oneLine("   "), "");
  });
});

describe("待投引用的落盘往返", () => {
  it("编码再解码得到同一份；空列表不写出", () => {
    const map = new Map([
      ["p1", [{ childId: "c1", messageId: "m1", childWorkbench: "/wb/c1" }]],
      ["p2", []],
    ]);
    const decoded = decodePending(encodePending(map));
    deepStrictEqual([...decoded], [["p1", [{ childId: "c1", messageId: "m1", childWorkbench: "/wb/c1" }]]]);
  });

  it("坏 JSON、坏结构、坏条目都不抛：跳过", () => {
    strictEqual(decodePending(null).size, 0);
    strictEqual(decodePending("{坏").size, 0);
    strictEqual(decodePending("[1,2]").size, 0);
    const odd = decodePending(JSON.stringify({ p: [{ childId: 1 }, null, { childId: "c", messageId: "m" }], q: "x" }));
    deepStrictEqual([...odd], [["p", [{ childId: "c", messageId: "m", childWorkbench: "" }]]]);
  });
});
