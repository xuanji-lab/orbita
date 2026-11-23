import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../notify/completion-notice.ts";
import {
  dayKeyOf,
  daysAgo,
  daysOf,
  dayStartsOf,
  mainConversationOf,
  orchestraKey,
  orchestraTree,
  TREE_CHILD_CAP,
  TREE_IDLE_MS,
  TREE_SESSION_CAP,
} from "./orchestra-data.ts";

const NOW = new Date(2026, 10, 24, 15, 0, 0).getTime();
const HOUR = 3_600_000;

function meta(id: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    title: id,
    titleSource: "user",
    cwd: "/w",
    workspaceId: "ws",
    providerId: "p",
    modelId: "m",
    mode: "skip",
    thinkingLevel: "medium",
    piSessionFile: null,
    pinned: false,
    archived: false,
    recentQueries: [],
    stats: null,
    createdAt: NOW - HOUR,
    updatedAt: NOW - HOUR,
    ...over,
  };
}

describe("主对话指针", () => {
  test("指针指向的会话在、是根会话、没归档、仍属于这个工作区才算；主目录用固定键", () => {
    const sessions = [meta("main"), meta("kid", { parentId: "main" }), meta("gone", { archived: true }), meta("moved", { workspaceId: "other" }), meta("home", { workspaceId: null })];
    assert.equal(mainConversationOf(sessions, "ws", { ws: "main" })?.id, "main");
    assert.equal(mainConversationOf(sessions, "ws", undefined), null);
    assert.equal(mainConversationOf(sessions, "ws", { ws: "missing" }), null);
    assert.equal(mainConversationOf(sessions, "ws", { ws: "kid" }), null, "子会话不能当主对话");
    assert.equal(mainConversationOf(sessions, "ws", { ws: "gone" }), null, "归档的当作没有");
    assert.equal(mainConversationOf(sessions, "ws", { ws: "moved" }), null, "移到别的工作区的当作没有");
    assert.equal(mainConversationOf(sessions, null, { [orchestraKey(null)]: "home" })?.id, "home");
    assert.equal(orchestraKey("ws"), "ws");
  });
});

describe("按天", () => {
  const at = (d: number, h: number) => new Date(2026, 10, d, h, 0, 0).getTime();
  const records = [
    { id: "u1", role: "user", timestamp: at(22, 9) },
    { id: "a1", role: "assistant", timestamp: at(22, 9) },
    { id: "u2", role: "user", timestamp: at(22, 23) },
    { id: "u3", role: "user", timestamp: at(24, 0) },
    { id: "a3", role: "assistant", timestamp: at(24, 1) },
    { id: "u4", role: "user", timestamp: at(24, 14) },
  ];
  test("按本地日历日分组、新的在前；只数用户消息；每天第一句是分隔线的位置", () => {
    assert.deepEqual(daysOf(records), [
      { day: "2026-11-24", firstUserId: "u3", count: 2 },
      { day: "2026-11-22", firstUserId: "u1", count: 2 },
    ]);
    assert.deepEqual([...dayStartsOf(records)], [["u1", "2026-11-22"], ["u3", "2026-11-24"]]);
    assert.deepEqual(daysOf([]), []);
    assert.equal(dayKeyOf(at(24, 0)), "2026-11-24", "零点算当天");
  });
  test("相对今天按日历日算：昨天 23 点到今天 0 点也是隔一天", () => {
    assert.equal(daysAgo("2026-11-24", NOW), 0);
    assert.equal(daysAgo("2026-11-23", NOW), 1);
    assert.equal(daysAgo("2026-11-01", NOW), 23);
  });
});

describe("编排面板的树", () => {
  const none = (): SessionRunState => null;
  test("下一层 = 主对话派出去的活 + 这个工作区别的会话；子会话再往下一层；主对话自己不重复列", () => {
    const sessions = [
      meta("main", { createdAt: NOW - 10 * HOUR }),
      meta("job1", { parentId: "main", createdAt: NOW - 3 * HOUR }),
      meta("job2", { parentId: "main", createdAt: NOW - 2 * HOUR }),
      meta("s1", { createdAt: NOW - 5 * HOUR }),
      meta("s1-kid", { parentId: "s1" }),
      meta("elsewhere", { workspaceId: "other" }),
    ];
    const tree = orchestraTree({ sessions, workspaceId: "ws", mainId: "main", stateOf: none, now: NOW });
    assert.equal(tree.main?.id, "main");
    assert.deepEqual(tree.jobs.map((n) => n.meta.id), ["job2", "job1"], "新的在前");
    assert.deepEqual(tree.sessions.map((n) => n.meta.id), ["s1"]);
    assert.deepEqual(tree.sessions[0]?.children.map((n) => n.meta.id), ["s1-kid"]);
    assert.equal(tree.older, 0);
  });

  test("没有主对话：派出去的活为空，别的会话照列", () => {
    const tree = orchestraTree({ sessions: [meta("s1")], workspaceId: "ws", mainId: null, stateOf: none, now: NOW });
    assert.equal(tree.main, null);
    assert.deepEqual(tree.jobs, []);
    assert.equal(tree.sessions.length, 1);
  });

  test("状态变化不让行换位置：次序只按创建时间", () => {
    const sessions = [meta("a", { createdAt: NOW - 2 * HOUR }), meta("b", { createdAt: NOW - HOUR })];
    const idle = orchestraTree({ sessions, workspaceId: "ws", mainId: null, stateOf: none, now: NOW });
    const busy = orchestraTree({ sessions, workspaceId: "ws", mainId: null, stateOf: (m) => (m.id === "a" ? "waiting" : null), now: NOW });
    assert.deepEqual(idle.sessions.map((n) => n.meta.id), busy.sessions.map((n) => n.meta.id));
  });

  test("退场：没状态又 3 天没碰的折进「另有 N 条」；在跑 / 等你 / 子会话在跑的不退", () => {
    const old = NOW - TREE_IDLE_MS - HOUR;
    const sessions = [
      meta("stale", { updatedAt: old, createdAt: old }),
      meta("stale-running", { updatedAt: old, createdAt: old - 1 }),
      meta("stale-parent", { updatedAt: old, createdAt: old - 2 }),
      meta("kid", { parentId: "stale-parent" }),
    ];
    const stateOf = (m: SessionMeta): SessionRunState => (m.id === "stale-running" || m.id === "kid" ? "running" : null);
    const tree = orchestraTree({ sessions, workspaceId: "ws", mainId: null, stateOf, now: NOW });
    assert.deepEqual(tree.sessions.map((n) => n.meta.id), ["stale-running", "stale-parent"]);
    assert.equal(tree.sessions[1]?.activeBelow, true, "子会话在跑的默认展开");
    assert.equal(tree.older, 1);
  });

  test("满载：400 条会话只列上限条、其余计数；一条会话 40 个子会话只列 6 个 + 计数", () => {
    const sessions: SessionMeta[] = [];
    for (let i = 0; i < 400; i++) sessions.push(meta(`s${i}`, { createdAt: NOW - i * 60_000, updatedAt: NOW - i * 60_000 }));
    for (let i = 0; i < 40; i++) sessions.push(meta(`k${i}`, { parentId: "s0" }));
    const tree = orchestraTree({ sessions, workspaceId: "ws", mainId: null, stateOf: none, now: NOW });
    assert.equal(tree.sessions.length, TREE_SESSION_CAP);
    assert.equal(tree.older, 400 - TREE_SESSION_CAP);
    assert.equal(tree.sessions[0]?.children.length, TREE_CHILD_CAP);
    assert.equal(tree.sessions[0]?.hiddenChildren, 40 - TREE_CHILD_CAP);
  });

  test("归档的、自动化开出来没转正的不列；主目录只列不属于任何工作区的", () => {
    const sessions = [meta("arch", { archived: true }), meta("auto", { automationId: "x" }), meta("promoted", { automationId: "x", promoted: true }), meta("home", { workspaceId: null })];
    assert.deepEqual(orchestraTree({ sessions, workspaceId: "ws", mainId: null, stateOf: none, now: NOW }).sessions.map((n) => n.meta.id), ["promoted"]);
    assert.deepEqual(orchestraTree({ sessions, workspaceId: null, mainId: null, stateOf: none, now: NOW }).sessions.map((n) => n.meta.id), ["home"]);
  });
});
