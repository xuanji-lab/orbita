import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  clampRowEstimate,
  createHeightCache,
  createRowHeightEstimator,
  DEFAULT_ROW_ESTIMATE,
  estimateRowHeight,
  MAX_ROW_ESTIMATE,
  MIN_ROW_ESTIMATE,
  ROW_KIND_ESTIMATES,
  messageRowIndex,
  prependAnchorTarget,
  rowIndexByKey,
  viewRowIndex,
  virtualHistoryRows,
  type VirtualHistoryRow,
} from "./virtual-history.ts";
import type { ToolTranscriptItem } from "@shared/transcript";
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

describe("clampRowEstimate", () => {
  test("正常值四舍五入后原样返回", () => {
    assert.equal(clampRowEstimate(230), 230);
    assert.equal(clampRowEstimate(218.6), 219);
  });

  test("低于下限夹到 32，高于上限夹到 1200", () => {
    assert.equal(clampRowEstimate(10), MIN_ROW_ESTIMATE);
    assert.equal(clampRowEstimate(0), MIN_ROW_ESTIMATE);
    assert.equal(clampRowEstimate(5000), MAX_ROW_ESTIMATE);
  });

  test("边界值不夹", () => {
    assert.equal(clampRowEstimate(MIN_ROW_ESTIMATE), MIN_ROW_ESTIMATE);
    assert.equal(clampRowEstimate(MAX_ROW_ESTIMATE), MAX_ROW_ESTIMATE);
  });

  test("非有限值回退典型初值", () => {
    assert.equal(clampRowEstimate(Number.NaN), DEFAULT_ROW_ESTIMATE);
    assert.equal(clampRowEstimate(Number.POSITIVE_INFINITY), DEFAULT_ROW_ESTIMATE);
    assert.equal(clampRowEstimate(Number.NEGATIVE_INFINITY), DEFAULT_ROW_ESTIMATE);
  });
});

describe("createRowHeightEstimator", () => {
  test("没有样本时：全局用初值，已知 kind 用先验，未知 kind 回退全局", () => {
    const estimator = createRowHeightEstimator();
    assert.equal(estimator.typical, DEFAULT_ROW_ESTIMATE);
    assert.equal(estimator.value(null), DEFAULT_ROW_ESTIMATE);
    assert.equal(estimator.value("text"), ROW_KIND_ESTIMATES["text"]);
    assert.equal(estimator.value("turnProcess"), ROW_KIND_ESTIMATES["turnProcess"]);
    assert.equal(estimator.value("mystery"), DEFAULT_ROW_ESTIMATE);
  });

  test("同类首个样本从该类的先验起步，而不是从全局值起步", () => {
    const estimator = createRowHeightEstimator({ factor: 0.15 });
    estimator.push("text", 100); // text 先验 800
    const value = estimator.value("text");
    assert.ok(value < ROW_KIND_ESTIMATES["text"]!, `text=${value} 应向样本下降`);
    assert.ok(value > 600, `text=${value} 不该一步跳到 100`);
  });

  test("kindInitial 可覆盖先验", () => {
    const estimator = createRowHeightEstimator({ kindInitial: { text: 300 } });
    assert.equal(estimator.value("text"), 300);
    assert.equal(estimator.value("user"), DEFAULT_ROW_ESTIMATE);
  });

  test("单个样本只走一步 EMA，不会直接跳到实测值", () => {
    const estimator = createRowHeightEstimator({ factor: 0.15 });
    estimator.push(null, 5000); // 先夹到 1200
    const value = estimator.value(null);
    assert.ok(value > DEFAULT_ROW_ESTIMATE, `${value} 应大于初值`);
    assert.ok(value < 500, `${value} 不该一步跳到 1200`);
    assert.equal(value, 376);
  });

  test("同类样本逐步收敛到该类均值", () => {
    const estimator = createRowHeightEstimator({ factor: 0.15, kindInitial: {} });
    const values = [];
    for (let i = 0; i < 20; i += 1) {
      estimator.push("text", 752);
      values.push(estimator.value("text"));
    }
    assert.ok(values[0]! < values[19]!, "估值应随样本增加而上升");
    assert.ok(values[19]! > 700, `20 个样本后应接近 752，实际 ${values[19]}`);
    assert.ok(values[19]! <= 752, "不该超过实测均值");
  });

  test("不同 kind 分开积累", () => {
    const estimator = createRowHeightEstimator({ factor: 0.5 });
    for (let i = 0; i < 10; i += 1) {
      estimator.push("text", 750);
      estimator.push("turnProcess", 69);
    }
    assert.ok(estimator.value("text") > 600, `text=${estimator.value("text")}`);
    assert.ok(estimator.value("turnProcess") < 120, `turnProcess=${estimator.value("turnProcess")}`);
    assert.ok(estimator.value("text") - estimator.value("turnProcess") > 400);
  });

  test("估计值始终夹在 32–1200", () => {
    const low = createRowHeightEstimator({ factor: 0.5 });
    for (let i = 0; i < 40; i += 1) low.push("tiny", 1);
    assert.equal(low.value("tiny"), MIN_ROW_ESTIMATE);
    const high = createRowHeightEstimator({ factor: 0.5 });
    for (let i = 0; i < 40; i += 1) high.push("huge", 50000);
    assert.equal(high.value("huge"), MAX_ROW_ESTIMATE);
  });

  test("非有限 / 非正高度忽略，不改变估计", () => {
    const estimator = createRowHeightEstimator();
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5]) {
      estimator.push("text", height);
    }
    assert.equal(estimator.value("text"), ROW_KIND_ESTIMATES["text"]);
    assert.equal(estimator.typical, DEFAULT_ROW_ESTIMATE);
  });
});

describe("estimateRowHeight", () => {
  test("缓存命中优先于估值", () => {
    const cache = createHeightCache(4);
    cache.set("a", 640);
    const estimator = createRowHeightEstimator({ factor: 0.5 });
    estimator.push("text", 180);
    assert.equal(estimateRowHeight("a", "text", cache, estimator), 640);
  });

  test("缓存未命中时用该 kind 的估值", () => {
    const cache = createHeightCache(4);
    const estimator = createRowHeightEstimator({ factor: 0.5 });
    estimator.push("text", 180);
    assert.equal(estimateRowHeight("missing", "text", cache, estimator), estimator.value("text"));
    assert.equal(estimateRowHeight("missing", "mystery", cache, estimator), estimator.typical);
  });

  test("缓存里的实测高度不被估值夹取改写", () => {
    const cache = createHeightCache(4);
    cache.set("tall", 3200);
    const estimator = createRowHeightEstimator();
    assert.equal(estimateRowHeight("tall", "text", cache, estimator), 3200);
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
