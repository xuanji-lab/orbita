import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { matchesSessionQuery, openRowsLimit, workspaceRowCurrent, workspaceRowFocus, workspaceRows } from "./workspace-rows.ts";
import type { SessionMeta } from "../../../shared/session.ts";
import type { SessionRunState } from "../features/notify/completion-notice.ts";

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    titleSource: "user",
    cwd: "/w",
    workspaceId: "w",
    providerId: "p",
    modelId: "m",
    thinkingLevel: "medium",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}

describe("workspaceRows —— 工作区下面只露没了结的", () => {
  const states: Record<string, SessionRunState> = { run: "running", ask: "waiting", bad: "failed", seen: null, unseen: "done", kid: "running", kidDone: null, old: null };
  const stateOf = (m: SessionMeta): SessionRunState => states[m.id] ?? null;

  test("主智能体自己不成行；它派的活与旧会话按状态分两拨，急的在前", () => {
    const list = [
      meta("main", { role: "main" }),
      meta("run", { updatedAt: 9 }),
      meta("ask", { updatedAt: 2 }),
      meta("bad"),
      meta("seen", { updatedAt: 5 }),
      meta("unseen"),
      meta("kid", { parentId: "main", updatedAt: 10 }),
      meta("kidDone", { parentId: "main", updatedAt: 7 }),
      meta("old", { updatedAt: 3 }),
    ];
    const rows = workspaceRows(list, "w", stateOf);
    assert.equal(rows.main?.id, "main");
    assert.deepEqual(rows.open.map((m) => m.id), ["ask", "bad", "kid", "run", "unseen"]);
    assert.deepEqual(rows.earlier.map((m) => m.id), ["kidDone", "seen", "old"]);
    // 一条不丢：没了结的 + 以前的 = 除主智能体以外的全部
    assert.equal(rows.open.length + rows.earlier.length, list.length - 1);
  });

  test("别的工作区、归档的、别的会话的子会话、没转正的自动化会话都不算", () => {
    const list = [
      meta("main", { role: "main" }),
      meta("other", { workspaceId: "x" }),
      meta("arch", { archived: true }),
      meta("grand", { parentId: "old" }),
      meta("old"),
      meta("auto", { automationId: "a1" }),
      meta("promoted", { automationId: "a2", promoted: true }),
      meta("otherMain", { role: "main", workspaceId: "x" }),
    ];
    const rows = workspaceRows(list, "w", stateOf);
    assert.deepEqual([...rows.open, ...rows.earlier].map((m) => m.id).sort(), ["old", "promoted"]);
  });

  test("还没说过话（没有主会话）：旧会话照样分拨，主智能体为空", () => {
    const rows = workspaceRows([meta("run"), meta("old")], "w", stateOf);
    assert.equal(rows.main, null);
    assert.deepEqual(rows.open.map((m) => m.id), ["run"]);
    assert.deepEqual(rows.earlier.map((m) => m.id), ["old"]);
  });
});

describe("workspaceRows —— 暂停着的活", () => {
  test("没有状态饼也留在没了结里，排在在跑之后、做完没看之前", () => {
    const states: Record<string, SessionRunState> = { run: "running", unseen: "done" };
    const list = [meta("main", { role: "main" }), meta("held", { parentId: "main" }), meta("run"), meta("unseen"), meta("old")];
    const rows = workspaceRows(list, "w", (m) => states[m.id] ?? null, (m) => m.id === "held");
    assert.deepEqual(rows.open.map((m) => m.id), ["run", "held", "unseen"]);
    assert.deepEqual(rows.earlier.map((m) => m.id), ["old"]);
  });
});

describe("matchesSessionQuery", () => {
  test("标题或最近提问里有就算，不分大小写，空查询全中", () => {
    const m = meta("a", { title: "复现 UrbanGPT", recentQueries: ["看看 ArXiv 那篇"] });
    assert.equal(matchesSessionQuery(m, "urbangpt"), true);
    assert.equal(matchesSessionQuery(m, "arxiv"), true);
    assert.equal(matchesSessionQuery(m, "  "), true);
    assert.equal(matchesSessionQuery(m, "海报"), false);
  });
});

describe("openRowsLimit —— 展开的工作区最多露 6 行，等你的永远露出", () => {
  const list = (waiting: number, other: number) => [
    ...Array.from({ length: waiting }, (_, i) => meta(`w${i}`)),
    ...Array.from({ length: other }, (_, i) => meta(`o${i}`)),
  ];
  const stateOf = (m: SessionMeta): SessionRunState => (m.id.startsWith("w") ? "waiting" : "running");
  test("平常最多 6 行", () => assert.equal(openRowsLimit(list(2, 6), stateOf, false), 6));
  test("等你的多于 6 件就全露", () => assert.equal(openRowsLimit(list(8, 2), stateOf, false), 8));
  test("点过「还有 N 件」= 全露", () => assert.equal(openRowsLimit(list(2, 6), stateOf, true), 8));
});

describe("工作区行与主区的关系（高亮与读屏）", () => {
  const main = meta("main", { role: "main" });
  const job = meta("job", { parentId: "main" });
  const other = meta("other");
  const all = [main, job, other];

  test("正跟主智能体说话：main，读屏说当前页", () => {
    assert.equal(workspaceRowFocus(main, "main", all, false), "main");
    assert.equal(workspaceRowCurrent("main"), "page");
  });

  test("正看它派出的一件活：行亮着（job），但不是当前页", () => {
    assert.equal(workspaceRowFocus(main, "job", all, false), "job");
    assert.equal(workspaceRowCurrent("job"), undefined);
  });

  test("看别的会话 / 首页：不亮；主智能体还没说过话的空态算 main", () => {
    assert.equal(workspaceRowFocus(main, "other", all, false), null);
    assert.equal(workspaceRowFocus(main, null, all, false), null);
    assert.equal(workspaceRowFocus(null, null, all, true), "main");
    assert.equal(workspaceRowCurrent(null), undefined);
  });
});
