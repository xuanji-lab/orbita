import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { SkillMeta } from "../../../../shared/skill.ts";
import type { McpServerInfo, McpStatus } from "../../../../shared/mcp.ts";
import {
  abilityRows,
  clampPick,
  groupRows,
  mcpRow,
  mcpStatusIn,
  movePick,
  nextTab,
  pickView,
  skillRow,
  tabCounts,
  visibleRows,
} from "./abilities-view.ts";

const ORBITA = { id: "ws-orbita", name: "orbita" };
const THESIS = { id: "ws-thesis", name: "thesis" };

function skill(slug: string, patch: Partial<SkillMeta> = {}): SkillMeta {
  return {
    slug,
    name: slug,
    description: `${slug} 的描述`,
    global: false,
    workspaces: [],
    missing: false,
    linkedPath: null,
    ...patch,
  };
}

function server(name: string, patch: Partial<McpServerInfo> = {}): McpServerInfo {
  return {
    name,
    detail: `npx -y ${name}`,
    status: { kind: "idle" },
    disabled: false,
    scopedTo: [],
    source: { global: true, workspaces: [] },
    instances: [],
    ...patch,
  };
}

function instance(scope: string, status: McpStatus) {
  return { scope, workspace: scope, label: `/tmp/${scope}`, status };
}

describe("skillRow：可用性按这个工作区算，开关只管这个工作区", () => {
  test("链在这个工作区：能用、满绿，开关是「这个工作区」且开着", () => {
    const row = skillRow(skill("pr-review", { workspaces: [ORBITA.id] }), ORBITA);
    assert.equal(row.usable, true);
    assert.equal(row.state, "on");
    assert.deepEqual(row.toggle, { kind: "workspace", on: true, workspaceId: ORBITA.id });
    assert.equal(row.token, "/skill:pr-review ");
  });

  test("只链在别的工作区：这里不能用、空圈，开关关着、拨开 = 链进这个工作区", () => {
    const row = skillRow(skill("design-audit", { workspaces: [THESIS.id] }), ORBITA);
    assert.equal(row.usable, false);
    assert.equal(row.state, "off");
    assert.deepEqual(row.toggle, { kind: "workspace", on: false, workspaceId: ORBITA.id });
  });

  test("全局 skill：能用，开关锁着（只动这一处做不到，去详情改范围）", () => {
    const row = skillRow(skill("commit-style", { global: true }), ORBITA);
    assert.equal(row.usable, true);
    assert.deepEqual(row.toggle, { kind: "locked", on: true, reason: "global-skill" });
  });

  test("会话不在工作区里：只有全局的能用，开关全锁", () => {
    const global = skillRow(skill("a", { global: true }), null);
    const linked = skillRow(skill("b", { workspaces: [ORBITA.id] }), null);
    assert.equal(global.usable, true);
    assert.equal(linked.usable, false);
    assert.deepEqual(linked.toggle, { kind: "locked", on: false, reason: "no-workspace" });
  });

  test("文件夹不在了：满红、第二行说缺失、插不了也没有开关", () => {
    const row = skillRow(skill("gone", { missing: true, global: true }), ORBITA);
    assert.equal(row.usable, false);
    assert.equal(row.state, "failed");
    assert.deepEqual(row.sub, { kind: "missing" });
    assert.equal(row.token, null);
    assert.equal(row.toggle, null);
  });

  test("第二行只取描述的第一条非空行", () => {
    const row = skillRow(skill("x", { description: "\n  第一行  \n第二行" }), ORBITA);
    assert.deepEqual(row.sub, { kind: "description", text: "第一行" });
  });
});

describe("mcpRow：这个工作区里的连接状态", () => {
  test("这个工作区的实例就绪：满绿，第二行数工具", () => {
    const row = mcpRow(
      server("github", { instances: [instance(ORBITA.id, { kind: "ready", tools: ["a", "b", "c"] })] }),
      ORBITA,
    );
    assert.equal(row.state, "on");
    assert.deepEqual(row.sub, { kind: "ready", tools: 3 });
    assert.equal(row.token, "/mcp:github ");
    assert.deepEqual(row.toggle, { kind: "global", on: true });
  });

  test("合并状态就绪、这个工作区的实例失败：按失败画，红字写第一行原因（不让别处的就绪遮住）", () => {
    const info = server("filesystem", {
      status: { kind: "ready", tools: ["read"] },
      instances: [
        instance(THESIS.id, { kind: "ready", tools: ["read"] }),
        instance(ORBITA.id, { kind: "failed", message: "spawn npx ENOENT\n    at Process.spawn" }),
      ],
    });
    const row = mcpRow(info, ORBITA);
    assert.equal(row.state, "failed");
    assert.deepEqual(row.sub, { kind: "failed", message: "spawn npx ENOENT" });
    // 失败的服务仍是「启用了」：选取态照样能选（token 插进去，模型会看到它连不上）
    assert.equal(row.usable, true);
  });

  test("这个工作区还没有实例：退回合并状态；都没有就是「启用了、还没连上」", () => {
    assert.deepEqual(mcpStatusIn(server("a", { status: { kind: "connecting" } }), ORBITA), { kind: "connecting" });
    const row = mcpRow(server("a"), ORBITA);
    assert.equal(row.state, "idle");
    assert.deepEqual(row.sub, { kind: "idle" });
    assert.equal(row.usable, true);
  });

  test("文件里停用：这里不能用，开关关着（管所有工作区）", () => {
    const row = mcpRow(server("linear", { disabled: true, status: { kind: "disabled" } }), ORBITA);
    assert.equal(row.usable, false);
    assert.equal(row.state, "off");
    assert.deepEqual(row.sub, { kind: "disabled" });
    assert.deepEqual(row.toggle, { kind: "global", on: false });
  });

  test("白名单不含这个工作区：不能用，第二行说只在哪；名或 id 命中都算", () => {
    const scoped = server("aw", { scopedTo: ["thesis"] });
    const row = mcpRow(scoped, ORBITA);
    assert.equal(row.usable, false);
    assert.deepEqual(row.sub, { kind: "elsewhere", workspaces: ["thesis"] });
    assert.equal(mcpRow(scoped, THESIS).usable, true);
    assert.equal(mcpRow(server("aw", { scopedTo: [ORBITA.id] }), ORBITA).usable, true);
    assert.equal(mcpRow(scoped, null).usable, false);
  });

  test("只定义在某个工作区的 .mcp.json：那个工作区能用、开关锁着；别处不能用", () => {
    const local = server("paper", { source: { global: false, workspaces: ["thesis"] } });
    const there = mcpRow(local, THESIS);
    assert.equal(there.usable, true);
    assert.deepEqual(there.toggle, { kind: "locked", on: true, reason: "workspace-file" });
    const here = mcpRow(local, ORBITA);
    assert.equal(here.usable, false);
    assert.deepEqual(here.sub, { kind: "elsewhere", workspaces: ["thesis"] });
  });

  test("不在工作区里的会话：用了 ${workspaceFolder} 的跳过（主进程同样跳过）", () => {
    const bound = server("aw", { detail: "node aw.js --root ${workspaceFolder}" });
    assert.equal(mcpRow(bound, null).usable, false);
    assert.equal(mcpRow(bound, ORBITA).usable, true);
  });

  test("重新加载中：用得上的行转「连接中」，停用的不动", () => {
    assert.equal(mcpRow(server("a", { status: { kind: "ready", tools: [] } }), ORBITA, true).state, "connecting");
    assert.equal(mcpRow(server("b", { disabled: true }), ORBITA, true).state, "off");
  });
});

describe("abilityRows / visibleRows / tabCounts", () => {
  const rows = abilityRows({
    skills: [skill("pr-review", { workspaces: [ORBITA.id] }), skill("Commit-style", { global: true })],
    servers: [server("linear", { disabled: true }), server("github")],
    workspace: ORBITA,
  });

  test("Skills 在前、MCP 在后，组内按名字排（大小写不敏感）", () => {
    assert.deepEqual(
      rows.map((row) => row.key),
      ["skill:Commit-style", "skill:pr-review", "mcp:github", "mcp:linear"],
    );
  });

  test("页签与筛选词：skill 按名字 / slug / 描述命中，MCP 按名字，大小写不敏感", () => {
    assert.deepEqual(visibleRows(rows, "mcp", "").map((row) => row.id), ["github", "linear"]);
    assert.deepEqual(visibleRows(rows, "all", "  COMMIT ").map((row) => row.id), ["Commit-style"]);
    assert.deepEqual(visibleRows(rows, "all", "pr-review 的描述").map((row) => row.id), ["pr-review"]);
    assert.deepEqual(visibleRows(rows, "skill", "git").map((row) => row.id), []);
  });

  test("页签计数是总数，不随筛选变", () => {
    assert.deepEqual(tabCounts(rows), { all: 4, skill: 2, mcp: 2 });
  });

  test("组头数这里能用几个 / 一共几个（不受筛选影响）；没有行的组不出", () => {
    const groups = groupRows(rows, visibleRows(rows, "all", "linear"));
    assert.equal(groups.length, 1);
    assert.equal(groups[0]?.kind, "mcp");
    assert.equal(groups[0]?.usable, 1);
    assert.equal(groups[0]?.total, 2);
  });
});

describe("pickView：选取态只列这个工作区用得上的", () => {
  const rows = abilityRows({
    skills: [
      skill("pr-review", { workspaces: [ORBITA.id] }),
      skill("design-audit", { workspaces: [THESIS.id] }),
      skill("gone", { missing: true, workspaces: [ORBITA.id] }),
    ],
    servers: [server("github"), server("linear", { disabled: true })],
    workspace: ORBITA,
  });

  test("可选行 = 用得上的、先 skill 后 MCP；没启用的（含缺失的）收在底部", () => {
    const view = pickView(rows, "all", "");
    assert.deepEqual(view.pickable.map((row) => row.key), ["skill:pr-review", "mcp:github"]);
    assert.deepEqual(view.unusable.map((row) => row.key), ["skill:design-audit", "skill:gone", "mcp:linear"]);
    assert.deepEqual(view.groups.map((group) => [group.kind, group.usable, group.total]), [
      ["skill", 1, 3],
      ["mcp", 1, 2],
    ]);
  });

  test("页签与筛选同样作用于可选行和底部的灰行", () => {
    const view = pickView(rows, "mcp", "lin");
    assert.deepEqual(view.pickable, []);
    assert.deepEqual(view.unusable.map((row) => row.id), ["linear"]);
  });
});

describe("键盘：Tab 轮换页签、↑↓ 绕回、高亮夹回", () => {
  test("Tab 全部 → Skills → MCP → 全部；Shift+Tab 反着走", () => {
    assert.equal(nextTab("all"), "skill");
    assert.equal(nextTab("skill"), "mcp");
    assert.equal(nextTab("mcp"), "all");
    assert.equal(nextTab("all", true), "mcp");
  });

  test("↑↓ 到头绕回；没高亮时 ↓ 第一行、↑ 最后一行；没行 = -1", () => {
    assert.equal(movePick(2, 1, 3), 0);
    assert.equal(movePick(0, -1, 3), 2);
    assert.equal(movePick(-1, 1, 3), 0);
    assert.equal(movePick(-1, -1, 3), 2);
    assert.equal(movePick(1, 1, 0), -1);
  });

  test("可选行变少时高亮夹回；有行至少亮第一行", () => {
    assert.equal(clampPick(5, 2), 1);
    assert.equal(clampPick(-1, 2), 0);
    assert.equal(clampPick(0, 0), -1);
  });
});
