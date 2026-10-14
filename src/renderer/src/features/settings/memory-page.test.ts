import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { MemoryEntry } from "../../../../shared/memory.ts";
import type { Workspace } from "../../../../shared/workspace.ts";
import { memoryGroups } from "./memory-page.ts";

let seq = 0;
function workspace(overrides: Partial<Workspace> = {}): Workspace {
  seq += 1;
  return {
    id: `w-${seq}`,
    name: `workspace ${seq}`,
    path: `/repo/w-${seq}`,
    createdAt: 0,
    attachedDirs: [],
    ...overrides,
  };
}

function entry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  seq += 1;
  return {
    id: `mem-${seq}`,
    text: `memory ${seq}`,
    keywords: [],
    sessionId: `s-${seq}`,
    timestamp: seq,
    ...overrides,
  };
}

describe("memoryGroups —— 设置 › 记忆的分组", () => {
  test("正常：有条目工作区按 workspaceApi 的顺序成组", () => {
    const a = workspace({ name: "alpha" });
    const b = workspace({ name: "beta" });
    const c = workspace({ name: "gamma" });
    // 显式时间戳：组内按新的在前（b2 比 b1 新）——这一条测的是组序，顺手把组内序也钉住
    const entries = new Map<string, MemoryEntry[]>([
      [a.id, [entry({ text: "a1", timestamp: 100 })]],
      [
        b.id,
        [entry({ text: "b1", timestamp: 200 }), entry({ text: "b2", timestamp: 300 })],
      ],
    ]);
    const groups = memoryGroups([a, b, c], (ws) => entries.get(ws.id) ?? []);
    assert.deepEqual(
      groups.map((group) => [group.workspace.name, group.entries.map((e) => e.text)]),
      [
        ["alpha", ["a1"]],
        ["beta", ["b2", "b1"]],
      ],
    );
  });

  test("没有条目的工作区不成组——页面列的单位是条目，不是工作区", () => {
    const a = workspace();
    const b = workspace();
    const entries = new Map<string, MemoryEntry[]>([[b.id, [entry()]]]);
    const groups = memoryGroups([a, b], (ws) => entries.get(ws.id) ?? []);
    assert.deepEqual(
      groups.map((group) => group.workspace.id),
      [b.id],
    );
  });

  test("整个库空：返回空数组（页面的空态信号）", () => {
    const groups = memoryGroups([workspace(), workspace()], () => []);
    assert.deepEqual(groups, []);
  });

  test("组内按 timestamp 新的在前", () => {
    const ws = workspace();
    const entries = [
      entry({ text: "old", timestamp: 1000 }),
      entry({ text: "new", timestamp: 3000 }),
      entry({ text: "mid", timestamp: 2000 }),
    ];
    const groups = memoryGroups([ws], () => entries);
    assert.deepEqual(
      groups[0]?.entries.map((e) => e.text),
      ["new", "mid", "old"],
    );
  });

  test("同一轮的多条时间戳相同：保持落盘顺序（稳定排序）", () => {
    const ws = workspace();
    const entries = [
      entry({ text: "first", timestamp: 5000 }),
      entry({ text: "second", timestamp: 5000 }),
      entry({ text: "third", timestamp: 5000 }),
    ];
    const groups = memoryGroups([ws], () => entries);
    assert.deepEqual(
      groups[0]?.entries.map((e) => e.text),
      ["first", "second", "third"],
    );
  });

  test("不改调用方给的数组", () => {
    const ws = workspace();
    const entries = [entry({ timestamp: 1 }), entry({ timestamp: 2 })];
    memoryGroups([ws], () => entries);
    assert.deepEqual(
      entries.map((e) => e.timestamp),
      [1, 2],
    );
  });
});
