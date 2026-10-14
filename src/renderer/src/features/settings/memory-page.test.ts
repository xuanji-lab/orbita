/**
 * 设置 › 记忆库纯函数层的测试：筛选、搜索、分组、统计。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry, MemoryLibraryItem } from "../../../../shared/memory.ts";
import {
  isPendingConflict,
  isStale,
  libraryGroups,
  libraryStats,
  matchesFilter,
  matchesQuery,
} from "./memory-page.ts";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

const entry = (id: string, extra: Partial<MemoryEntry> = {}): MemoryEntry => ({
  id,
  text: `条目 ${id}`,
  keywords: [],
  sessionId: "s1",
  timestamp: NOW - DAY,
  ...extra,
});

const item = (id: string, extra: Partial<MemoryEntry> = {}, usage: { count: number; lastAt: number | null } = { count: 0, lastAt: null }): MemoryLibraryItem => ({
  entry: entry(id, extra),
  usage,
  sessionTitle: "某次会话",
});

describe("isPendingConflict / isStale", () => {
  test("判过、没拍板、还活着才算待处理", () => {
    assert.equal(isPendingConflict(entry("a", { supersedes: "mem_old" })), true);
    assert.equal(isPendingConflict(entry("b", { supersedes: "mem_old", conflictResolution: "keep-both" })), false);
    assert.equal(isPendingConflict(entry("c", { supersedes: "mem_old", status: "muted" })), false);
    assert.equal(isPendingConflict(entry("d")), false);
  });

  test("90 天没注入过（或从没注入过且创建超 90 天）算闲置", () => {
    assert.equal(isStale(item("a", { timestamp: NOW - 91 * DAY }), NOW), true);
    assert.equal(isStale(item("b", { timestamp: NOW - 91 * DAY }, { count: 3, lastAt: NOW - 10 * DAY }), NOW), false);
    assert.equal(isStale(item("c", { timestamp: NOW - 10 * DAY }, { count: 1, lastAt: NOW - 91 * DAY }), NOW), true);
    assert.equal(isStale(item("d", { timestamp: NOW }), NOW), false);
  });
});

describe("matchesFilter", () => {
  const distilled = item("d1");
  const excerpt = item("e1", { source: "excerpt", pinned: true });
  const manual = item("m1", { source: "manual" });
  const conflict = item("c1", { supersedes: "mem_x" });
  const stale = item("s1", { timestamp: NOW - 100 * DAY });
  const all = [distilled, excerpt, manual, conflict, stale];

  test("来源档：旧条目（无 source）按蒸馏读；摘抄档含手动添加；冲突 / 闲置与来源可叠加", () => {
    // 蒸馏档收所有蒸馏来源的条目——包括正带冲突建议、或闲置的（chip 只按来源分，不叠加排除）
    assert.deepEqual(all.filter((x) => matchesFilter(x, "distilled", NOW)).map((x) => x.entry.id), ["d1", "c1", "s1"]);
    assert.deepEqual(all.filter((x) => matchesFilter(x, "excerpt", NOW)).map((x) => x.entry.id), ["e1", "m1"]);
    assert.equal(matchesFilter(distilled, "all", NOW), true);
  });

  test("冲突档只看待处理；闲置档按使用统计", () => {
    assert.deepEqual(all.filter((x) => matchesFilter(x, "conflict", NOW)).map((x) => x.entry.id), ["c1"]);
    assert.deepEqual(all.filter((x) => matchesFilter(x, "stale", NOW)).map((x) => x.entry.id), ["s1"]);
  });
});

describe("matchesQuery", () => {
  const words = { position: "我说的 · 立场", agree: "agent 说的 · 认同" } as Record<string, string>;
  const target = item("a", { text: "用户决定包管理器用 npm", keywords: ["npm", "包管理器"], stance: "agree" }, { count: 0, lastAt: null });
  target.sessionTitle = "换回 npm 的那次讨论";

  test("正文 / 关键词 / 会话标题 / 态度文案都搜得到，大小写不敏感", () => {
    assert.equal(matchesQuery(target, "npm", words), true);
    assert.equal(matchesQuery(target, "NPM", words), true);
    assert.equal(matchesQuery(target, "换回", words), true);
    assert.equal(matchesQuery(target, "认同", words), true);
    assert.equal(matchesQuery(target, "  ", words), true); // 空搜索 = 不过滤
    assert.equal(matchesQuery(target, "bun", words), false);
  });

  test("会话已删（标题 null）时按其余字段搜", () => {
    const gone = { ...target, sessionTitle: null };
    assert.equal(matchesQuery(gone, "npm", words), true);
    assert.equal(matchesQuery(gone, "换回", words), false);
  });
});

describe("libraryGroups", () => {
  test("三组各归各：冲突组含新旧两侧，摘抄组含手动，其余蒸馏；组内按最近使用降序", () => {
    const old = item("old", { timestamp: NOW - 5 * DAY }, { count: 9, lastAt: NOW - DAY });
    const fresh = item("fresh", { supersedes: "old", timestamp: NOW - DAY });
    const excerpt = item("ex", { source: "excerpt" }, { count: 1, lastAt: NOW - 2 * DAY });
    const manual = item("mn", { source: "manual" });
    const plain = item("plain");
    const { groups, pendingOldIds } = libraryGroups([plain, manual, excerpt, fresh, old], NOW);
    assert.deepEqual(pendingOldIds, new Set(["old"]));
    assert.deepEqual(
      groups.map((group) => [group.id, group.items.map((x) => x.entry.id)]),
      [
        ["conflicts", ["fresh", "old"]],
        ["excerpts", ["mn", "ex"]],
        ["distilled", ["plain"]],
      ],
    );
  });

  test("拍板过的旧条目（superseded）不再进冲突组，留在蒸馏组由标签交代", () => {
    const old = item("old", { status: "superseded", supersededBy: "fresh" });
    const fresh = item("fresh", { supersedes: "old", conflictResolution: "replace" });
    const { groups, pendingOldIds } = libraryGroups([old, fresh], NOW);
    assert.equal(pendingOldIds.size, 0);
    assert.equal(groups.some((group) => group.id === "conflicts"), false);
    assert.deepEqual(
      groups.find((group) => group.id === "distilled")?.items.map((x) => x.entry.id),
      ["old", "fresh"],
    );
  });

  test("空组不出现（空库 = 空分组列表）", () => {
    assert.deepEqual(libraryGroups([], NOW).groups, []);
  });
});

describe("libraryStats", () => {
  test("总数 · 本周新增（7 天内）· 待处理冲突数", () => {
    const stats = libraryStats(
      [
        item("a", { timestamp: NOW - DAY }),
        item("b", { timestamp: NOW - 2 * DAY }),
        item("c", { timestamp: NOW - 8 * DAY }),
        item("d", { supersedes: "x", timestamp: NOW - 9 * DAY }),
        item("e", { supersedes: "y", conflictResolution: "keep-both", timestamp: NOW - 9 * DAY }),
      ],
      NOW,
    );
    assert.deepEqual(stats, { total: 5, week: 2, conflicts: 1 });
  });
});
