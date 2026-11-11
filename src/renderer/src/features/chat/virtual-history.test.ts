import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  createHeightCache,
  messageRowIndex,
  prependAnchorTarget,
  rowIndexByKey,
  viewRowIndex,
  virtualHistoryRows,
  type VirtualHistoryRow,
} from "./virtual-history.ts";
import type { ToolTranscriptItem } from "@earendil-works/pi-protocol";
import type { ScanAnswerCard, ToolResultIndex, TurnViewEntry } from "./tool-results.ts";

/** 测试用的最小条目工厂：只塞判定会读到的字段 */
function user(key: string): TurnViewEntry {
  return {
    kind: "user",
    key,
    item: { id: key, role: "user", timestamp: 0, content: [] },
  } as unknown as TurnViewEntry;
}

function text(key: string, messageId: string): TurnViewEntry {
  return { kind: "text", key, messageId, text: "x", timestamp: 0 } as TurnViewEntry;
}

function toolCall(key: string, toolCallId: string, toolName = "show_image", messageId = "m"): TurnViewEntry {
  return { kind: "toolCall", key, messageId, toolCallId, toolName, input: {}, timestamp: 0 } as TurnViewEntry;
}

function toolGroup(key: string, messageIds: string[]): TurnViewEntry {
  return {
    kind: "toolGroup",
    key,
    calls: messageIds.map((messageId, i) => ({
      kind: "toolCall",
      key: `${key}:${i}`,
      messageId,
      toolCallId: `${key}:${i}`,
      toolName: "read",
      input: {},
      timestamp: 0,
    })),
    durationMs: 0,
    startedAt: 0,
  } as unknown as TurnViewEntry;
}

function turnGroup(key: string, members: TurnViewEntry[]): TurnViewEntry {
  return {
    kind: "turnGroup",
    key,
    members: members.filter((entry) => entry.kind !== "text" && entry.kind !== "user"),
    durationMs: 0,
    startedAt: 0,
  } as TurnViewEntry;
}

function turnProcess(key: string, steps: TurnViewEntry[]): TurnViewEntry {
  return {
    kind: "turnProcess",
    key,
    steps,
    durationMs: 0,
    startedAt: 0,
    live: false,
    answering: false,
  } as TurnViewEntry;
}

function completeResult(toolCallId: string): ToolTranscriptItem {
  return { toolCallId, status: "complete", content: [], timestamp: 0 } as unknown as ToolTranscriptItem;
}

function resultIndex(ids: string[]): ToolResultIndex {
  return new Map(ids.map((id) => [id, completeResult(id)]));
}

const NO_CARDS: ReadonlyMap<string, ScanAnswerCard> = new Map();
const NO_BRANCHES: ReadonlyMap<number, string> = new Map();

function rows(view: TurnViewEntry[], results: ToolResultIndex = resultIndex([]), cards = NO_CARDS, branches = NO_BRANCHES) {
  return virtualHistoryRows(view, results, cards, "parent", branches);
}

describe("virtualHistoryRows", () => {
  test("普通行全部保留，index 是原视图下标", () => {
    const view = [user("u1"), text("a:0", "a"), toolGroup("g:1", ["b", "c"])];
    assert.deepEqual(rows(view).map((row) => [row.entry.key, row.index]), [
      ["u1", 0],
      ["a:0", 1],
      ["g:1", 2],
    ]);
  });

  test("相邻成功 show_image 只留第一张，失败的结果切断画廊", () => {
    const view = [toolCall("t:0", "s1"), toolCall("t:1", "s2"), toolCall("t:2", "s3"), toolCall("t:3", "bad"), toolCall("t:4", "s4")];
    const results: ToolResultIndex = new Map([
      ["s1", completeResult("s1")],
      ["s2", completeResult("s2")],
      ["s3", completeResult("s3")],
      ["bad", { ...completeResult("bad"), status: "error" } as ToolTranscriptItem],
      ["s4", completeResult("s4")],
    ]);
    assert.deepEqual(rows(view, results).map((row) => row.entry.key), ["t:0", "t:3", "t:4"]);
  });

  test("同一条消息的后续 text 块被扫描卡吸收，但带分支行时保留", () => {
    const view = [text("a:0", "a"), text("a:1", "a"), text("a:2", "a")];
    const cards = new Map<string, ScanAnswerCard>([
      ["a", { firstKey: "a:0", scan: {} } as unknown as ScanAnswerCard],
    ]);
    assert.deepEqual(rows(view, resultIndex([]), cards).map((row) => row.entry.key), ["a:0"]);
    const branches = new Map([[2, "anchor"]]);
    assert.deepEqual(rows(view, resultIndex([]), cards, branches).map((row) => row.entry.key), ["a:0", "a:2"]);
  });

  test("通道标记：父看子非 progress 保留，父看子 progress 丢弃", () => {
    const mark = (key: string, from: "parent" | "child", kind: string): TurnViewEntry =>
      ({ kind: "channelMark", key, mark: { peerId: "p", messageId: `m-${key}`, from, kind }, timestamp: 0 } as TurnViewEntry);
    const view = [mark("c1", "child", "task"), mark("c2", "child", "progress"), mark("c3", "parent", "task")];
    assert.deepEqual(rows(view).map((row) => row.entry.key), ["c1"]);
  });

  test("子会话视角：父发来的消息保留（同一判定另一分支）", () => {
    const view: TurnViewEntry[] = [
      { kind: "channelMark", key: "k", mark: { peerId: "p", messageId: "m", from: "parent", kind: "task" }, timestamp: 0 } as TurnViewEntry,
    ];
    const kept = virtualHistoryRows(view, resultIndex([]), NO_CARDS, "child", NO_BRANCHES);
    assert.equal(kept.length, 1);
  });
});

describe("行下标映射", () => {
  const view = [
    user("u1"),
    turnGroup("turn:a:0", [toolCall("a:0", "t1", "read", "a")]),
    turnProcess("proc:b:0", [text("b:0", "b"), toolGroup("g:b", ["b", "c"])]),
  ];
  const list: VirtualHistoryRow[] = rows(view);

  test("key → 虚拟行下标", () => {
    const map = rowIndexByKey(list);
    assert.equal(map.get("u1"), 0);
    assert.equal(map.get("turn:a:0"), 1);
    assert.equal(map.get("proc:b:0"), 2);
    assert.equal(map.get("nope"), undefined);
  });

  test("消息 id → 虚拟行下标，折叠成员与多消息组都能找到", () => {
    const map = messageRowIndex(list);
    assert.equal(map.get("u1"), 0);
    assert.equal(map.get("a"), 1);
    assert.equal(map.get("b"), 2);
    assert.equal(map.get("c"), 2);
  });

  test("同一条消息占多行时取最后一行", () => {
    const map = messageRowIndex(rows([text("a:0", "a"), text("a:1", "a")]));
    assert.equal(map.get("a"), 1);
  });

  test("视图下标 → 虚拟行下标（过滤掉的行没有映射）", () => {
    const filtered = rows([toolCall("t:0", "s1"), toolCall("t:1", "s2")], resultIndex(["s1", "s2"]));
    const map = viewRowIndex(filtered);
    assert.equal(map.get(0), 0);
    assert.equal(map.get(1), undefined);
  });
});

describe("prependAnchorTarget", () => {
  test("新行顶减旧视口偏移", () => {
    assert.equal(prependAnchorTarget(1000, 40), 960);
  });

  test("顶到 0 以下时夹到 0", () => {
    assert.equal(prependAnchorTarget(10, 40), 0);
  });

  test("缺少测量 / 非有限值返回 null", () => {
    assert.equal(prependAnchorTarget(undefined, 0), null);
    assert.equal(prependAnchorTarget(Number.NaN, 0), null);
    assert.equal(prependAnchorTarget(10, Number.POSITIVE_INFINITY), null);
  });
});

describe("createHeightCache", () => {
  test("存取与命中的 LRU 顺序", () => {
    const cache = createHeightCache(2);
    cache.set("a", 10);
    cache.set("b", 20);
    assert.equal(cache.get("a"), 10);
    cache.set("c", 30); // a 刚被读过，淘汰 b
    assert.equal(cache.get("b"), undefined);
    assert.equal(cache.get("a"), 10);
    assert.equal(cache.get("c"), 30);
    assert.equal(cache.size, 2);
  });

  test("重复 set 不增加条数，值更新", () => {
    const cache = createHeightCache(2);
    cache.set("a", 10);
    cache.set("a", 11);
    assert.equal(cache.size, 1);
    assert.equal(cache.get("a"), 11);
  });

  test("上限边界：刚好等于上限不淘汰，超一条淘汰最旧", () => {
    const cache = createHeightCache(2);
    cache.set("a", 1);
    cache.set("b", 2);
    assert.equal(cache.size, 2);
    cache.set("c", 3);
    assert.equal(cache.size, 2);
    assert.equal(cache.get("a"), undefined);
  });

  test("clear 清空", () => {
    const cache = createHeightCache(4);
    cache.set("a", 1);
    cache.clear();
    assert.equal(cache.size, 0);
    assert.equal(cache.get("a"), undefined);
  });
});
