import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { ImportPlanItem, ImportScanReport } from "../../../../shared/import.ts";
import type { Workspace } from "../../../../shared/workspace.ts";
import {
  DEFAULT_FILTERS,
  abbreviateHome,
  allSelectable,
  destinationChoices,
  destinationLabel,
  destinationOptions,
  groupName,
  groupSessions,
  selectedSourceFiles,
  summarize,
} from "./migration-groups.ts";

const NOW = Date.UTC(2026, 8, 24);
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function item(overrides: Partial<ImportPlanItem>): ImportPlanItem {
  seq += 1;
  return {
    sourceId: `s-${seq}`,
    source: "proma",
    sourceKind: "pi",
    change: "new",
    newMessages: 0,
    folder: null,
    sourceFile: `/proma/${seq}.jsonl`,
    title: `session ${seq}`,
    workspaceId: null,
    cwd: "/tmp",
    providerId: "p",
    modelId: "glm-5.3",
    importedModel: "glm-5.3",
    sessionId: `o-${seq}`,
    parentId: null,
    modelMatched: true,
    archived: false,
    pinned: false,
    starred: false,
    createdAt: NOW - DAY,
    updatedAt: NOW - DAY,
    bytes: 100,
    ...overrides,
  };
}

function report(plan: ImportPlanItem[], newWorkspaceIds: string[] = []): ImportScanReport {
  return {
    plan,
    newWorkspaces: newWorkspaceIds.map((id) => ({ id, name: id, path: `/repo/${id}`, merged: false })),
    mergedWorkspaceIds: [],
    skipped: [],
    withoutPiSession: 0,
    totalBytes: 0,
    modelFallbackCount: 0,
    subSessionCount: 0,
    orphanedSubSessions: 0,
    lastImportAt: null,
  };
}

const orbita: Workspace = { id: "w-orbita", name: "orbita", path: "/repo/orbita", createdAt: 1, attachedDirs: [] };
const lab: Workspace = { id: "w-lab", name: "orbita-lab", path: "/repo/lab", createdAt: 1, attachedDirs: [] };

describe("groupSessions", () => {
  test("按文件夹分组：多的在前，没有文件夹的一组垫底；子会话计进母会话那一行", () => {
    const parent = item({ folder: "/repo/orbita", workspaceId: "w-orbita" });
    const plan = [
      item({ folder: null }),
      item({ folder: null }),
      item({ folder: null }),
      parent,
      item({ folder: "/repo/orbita", parentId: parent.sessionId, bytes: 50 }),
      item({ folder: "/repo/orbita", workspaceId: "w-orbita" }),
      item({ folder: "/repo/new", workspaceId: "w-new" }),
    ];
    const grouped = groupSessions(report(plan, ["w-new"]), DEFAULT_FILTERS, NOW);
    assert.deepEqual(
      grouped.groups.map((group) => [group.folder, group.rows.length]),
      [
        ["/repo/orbita", 2],
        ["/repo/new", 1],
        [null, 3],
      ],
    );
    const parentRow = grouped.groups[0]?.rows.find((row) => row.item.sessionId === parent.sessionId);
    assert.equal(parentRow?.subSessions, 1);
    assert.equal(parentRow?.bytes, 150);
    assert.equal(grouped.total, 6);
    assert.deepEqual(grouped.groups[0]?.defaultDestination, { kind: "workspace", workspaceId: "w-orbita" });
    assert.deepEqual(grouped.groups[1]?.defaultDestination, { kind: "new-workspace" });
    assert.deepEqual(grouped.groups[2]?.defaultDestination, { kind: "tasks" });
  });

  test("筛选：默认全部；不含归档、时间范围都会把条目算进 hidden，组空了就不出现", () => {
    const plan = [
      item({ folder: "/repo/a", archived: true }),
      item({ folder: "/repo/b", updatedAt: NOW - 100 * DAY }),
      item({ folder: "/repo/b" }),
    ];
    assert.equal(groupSessions(report(plan), DEFAULT_FILTERS, NOW).hidden, 0);
    const narrowed = groupSessions(report(plan), { range: "90d", includeArchived: false }, NOW);
    assert.equal(narrowed.hidden, 2);
    assert.deepEqual(
      narrowed.groups.map((group) => group.folder),
      ["/repo/b"],
    );
  });
});

describe("选择与汇总", () => {
  test("默认全勾可选条目；执行只交勾选且可见的，去向只交改过的", () => {
    const a = item({ folder: "/repo/a", workspaceId: "w-new" });
    const b = item({ folder: "/repo/b", archived: true });
    const r = report([a, b], ["w-new"]);
    const selected = allSelectable(r);
    assert.equal(selected.size, 2);
    const visible = groupSessions(r, { range: "all", includeArchived: false }, NOW);
    assert.deepEqual(selectedSourceFiles(visible, selected), [a.sourceFile]);

    const overrides = new Map([
      ["/repo/a", { kind: "new-workspace" as const }],
      ["/repo/b", { kind: "tasks" as const }],
    ]);
    // /repo/a 改成与默认相同 → 不交；/repo/b 被藏了 → 不交
    assert.deepEqual(destinationChoices(visible, overrides), []);
    const all = groupSessions(r, DEFAULT_FILTERS, NOW);
    const moved = new Map([["/repo/a", { kind: "tasks" as const }]]);
    assert.deepEqual(destinationChoices(all, moved), [{ folder: "/repo/a", destination: { kind: "tasks" } }]);
  });

  test("汇总：子会话、字节、新建工作区数随去向变；模型兜底按勾选的算", () => {
    const parent = item({ folder: "/repo/a", workspaceId: "w-new", modelMatched: false, importedModel: "claude-opus-5-5" });
    const kid = item({ folder: "/repo/a", parentId: parent.sessionId, bytes: 40 });
    const other = item({ folder: null });
    const grouped = groupSessions(report([parent, kid, other], ["w-new"]), DEFAULT_FILTERS, NOW);
    const selected = new Set([parent.sourceFile]);
    const summary = summarize(grouped, selected, new Map());
    assert.equal(summary.sessions, 1);
    assert.equal(summary.subSessions, 1);
    assert.equal(summary.bytes, 140);
    assert.equal(summary.newWorkspaces, 1);
    assert.deepEqual(summary.fallback, { count: 1, models: ["claude-opus-5-5"], fallbackModel: "glm-5.3" });
    assert.equal(summarize(grouped, selected, new Map([["/repo/a", { kind: "tasks" as const }]])).newWorkspaces, 0);
  });
});

describe("去向选项与文案", () => {
  test("默认在最前；新建只在默认就是新建时出现；已是默认的工作区不重复列", () => {
    const grouped = groupSessions(
      report([item({ folder: "/repo/orbita", workspaceId: "w-orbita" }), item({ folder: "/repo/fresh", workspaceId: "w-new" })], ["w-new"]),
      DEFAULT_FILTERS,
      NOW,
    );
    const merged = grouped.groups.find((group) => group.folder === "/repo/orbita");
    const fresh = grouped.groups.find((group) => group.folder === "/repo/fresh");
    assert.ok(merged !== undefined && fresh !== undefined);
    assert.deepEqual(
      destinationOptions(merged, [orbita, lab]).map((option) => option.label),
      ["Into orbita", "Into Tasks", "Into orbita-lab"],
    );
    assert.deepEqual(
      destinationOptions(fresh, [orbita, lab]).map((option) => option.label),
      ["New workspace", "Into Tasks", "Into orbita", "Into orbita-lab"],
    );
    assert.equal(destinationLabel({ kind: "workspace", workspaceId: "gone" }, [orbita]), "Missing workspace");
  });

  test("组名取文件夹末段；家目录缩成 ~", () => {
    assert.equal(groupName("/Users/me/Documents/repo/orbita/"), "orbita");
    assert.equal(groupName(null), "No folder");
    assert.equal(abbreviateHome("/Users/me/.proma-dev/agent-sessions.json", "/Users/me"), "~/.proma-dev/agent-sessions.json");
    assert.equal(abbreviateHome("/Users/meta/x", "/Users/me"), "/Users/meta/x");
  });
});
