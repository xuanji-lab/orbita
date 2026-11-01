/**
 * 能力面板的行（纯函数，`node --test` 直接加载）：Skills 与 MCP 服务合成同一种行，
 * 筛选、分组、页签计数与「/ + 空格」选取态的可选行都在这里算，组件只管画。
 *
 * 一行回答三件事：它是什么（类别 + 名字）、在**这条会话所在的工作区**里能不能用
 * （行首状态槽 + 第二行）、开关管什么（行尾开关）。「这个工作区」是可用性的唯一
 * 口径——选取态只列这里用得上的，浏览态的组头数「这里能用几个 / 一共几个」。
 *
 * 可用性与发送端同源：
 * - Skill 用 `isSkillAvailable`（主进程组装指令块也用它）——选得到的发出去必然认；
 * - MCP 按主进程解析会话那份配置的同一组条件推（`resolveServersForWorkspace`：
 *   文件里的 disabled、`workspaces` 白名单、只在某些工作区 `.mcp.json` 里定义、Home
 *   会话跳过用了 `${workspaceFolder}` 的）。渲染层拿不到两样东西，近似处理并写明：
 *   工作区自带配置里对同名全局条目写的 `disabled`（行上只有全局文件的事实）、
 *   env / cwd / headers 里的 `${workspaceFolder}`（`detail` 只含命令行与 URL）。
 *
 * 开关的口径（2026-10-30 能力面板）：Skill 的开关只管当前工作区（链 / 解链
 * `skill-links/<工作区>/`）；全局 skill 与「不在工作区里」的会话没法只动这一处，
 * 开关锁住、点开详情改范围。MCP 服务的开关仍是 mcp.json 的 `disabled`，**管所有
 * 工作区**——配置格式里没有「只在某个工作区停用」的写法，加一个是改配置格式，
 * 留给用户拍板；面板上如实说「管所有工作区」，不装作只管这一处。
 */
import { isSkillAvailable, type SkillMeta } from "../../../../shared/skill.ts";
import { WORKSPACE_FOLDER_VAR, type McpServerInfo, type McpStatus } from "../../../../shared/mcp.ts";
import { mcpToken, skillToken } from "../../shell/panel-token.ts";

/** 行的类别：Skill（绿）/ MCP 服务（蓝）——与输入框里两种 token 胶囊同色 */
export type AbilityKind = "skill" | "mcp";

/** 列表顶上的三个页签，Tab 键按这个顺序轮换 */
export type AbilityTab = "all" | AbilityKind;
export const ABILITY_TABS: readonly AbilityTab[] = ["all", "skill", "mcp"];

/** 这条会话所在的工作区：可用性按它算、Skill 的开关管它。null = 不属于任何工作区 */
export interface AbilityWorkspace {
  id: string;
  name: string;
}

/**
 * 行首状态槽：
 * - on：能用（Skill 在这里启用 / MCP 已连接）——满绿；
 * - off：这里没启用——空圈；
 * - idle：MCP 启用了、这个工作区还没连过（下一轮发消息时连）——空圈，第二行说清；
 * - failed：MCP 启动失败 / Skill 文件夹不在了——满红；
 * - connecting：MCP 正在连——1/3 蓝（与会话状态饼「在跑」同一个符号：进行中）。
 */
export type AbilityState = "on" | "off" | "idle" | "failed" | "connecting";

/** 第二行写什么。这里只给事实，文案在组件里按语言取 */
export type AbilitySub =
  | { kind: "description"; text: string }
  | { kind: "missing" }
  | { kind: "ready"; tools: number }
  | { kind: "failed"; message: string }
  | { kind: "connecting" }
  | { kind: "idle" }
  | { kind: "disabled" }
  /** 只在别的工作区可用（白名单 / 只定义在那些工作区的 .mcp.json 里）：列出在哪 */
  | { kind: "elsewhere"; workspaces: string[] };

/**
 * 行尾开关：
 * - workspace：Skill 链 / 解链当前工作区；
 * - global：MCP 服务 mcp.json 的 disabled（管所有工作区）；
 * - locked：动不了，原因给 tooltip——全局 skill（要改范围去详情）、会话不在工作区里、
 *   MCP 只来自工作区自带的 .mcp.json（写全局文件够不着它）。
 */
export type AbilitySwitch =
  | { kind: "workspace"; on: boolean; workspaceId: string }
  | { kind: "global"; on: boolean }
  | { kind: "locked"; on: boolean; reason: "global-skill" | "no-workspace" | "workspace-file" };

export interface AbilityRow {
  /** `${kind}:${id}`——两类的 id 可能撞名（skill 叫 github、MCP 也叫 github） */
  key: string;
  kind: AbilityKind;
  /** skill 的 slug（目录名）/ MCP 服务名 */
  id: string;
  name: string;
  /** 筛选匹配的字（小写）：skill 的名字、slug、描述；MCP 的名字 */
  search: string;
  state: AbilityState;
  sub: AbilitySub;
  /** 这个工作区用得上：选取态只有它们可选 */
  usable: boolean;
  /** 插进输入框的 token；null = 插不了（skill 文件夹不在了，展开不了） */
  token: string | null;
  /** null = 没有开关（skill 文件夹不在了：要做的是清理，在详情里） */
  toggle: AbilitySwitch | null;
}

/** 多行文字（描述、错误输出）只取第一条非空行：第二行只有一行高 */
function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== "")?.trim() ?? "";
}

export function skillRow(meta: SkillMeta, workspace: AbilityWorkspace | null): AbilityRow {
  const usable = isSkillAvailable(meta, workspace?.id ?? null);
  let toggle: AbilitySwitch | null;
  if (meta.missing) toggle = null;
  else if (workspace === null) toggle = { kind: "locked", on: meta.global, reason: "no-workspace" };
  else if (meta.global) toggle = { kind: "locked", on: true, reason: "global-skill" };
  else toggle = { kind: "workspace", on: meta.workspaces.includes(workspace.id), workspaceId: workspace.id };
  return {
    key: `skill:${meta.slug}`,
    kind: "skill",
    id: meta.slug,
    name: meta.name,
    search: `${meta.name}\n${meta.slug}\n${meta.description}`.toLowerCase(),
    state: meta.missing ? "failed" : usable ? "on" : "off",
    sub: meta.missing ? { kind: "missing" } : { kind: "description", text: firstLine(meta.description) },
    usable,
    token: meta.missing ? null : skillToken(meta.slug),
    toggle,
  };
}

/** 这台服务在这个工作区里会不会被拉起（主进程解析会话配置的同一组条件，见文件头） */
export function mcpUsableIn(server: McpServerInfo, workspace: AbilityWorkspace | null): boolean {
  if (server.disabled) return false;
  // 只定义在某些工作区自带的 .mcp.json 里：别处看不到它（source.workspaces 是工作区名）
  if (!server.source.global && (workspace === null || !server.source.workspaces.includes(workspace.name))) {
    return false;
  }
  // 白名单按名或 id 都能写；面板拿到的已经翻成名（翻不到的 id 原样）
  if (
    server.scopedTo.length > 0 &&
    (workspace === null || (!server.scopedTo.includes(workspace.name) && !server.scopedTo.includes(workspace.id)))
  ) {
    return false;
  }
  // Home 会话没有工作区根可换：用了 ${workspaceFolder} 的跳过（detail 只含命令行 / URL，近似）
  if (workspace === null && server.detail.includes(WORKSPACE_FOLDER_VAR)) return false;
  return true;
}

/**
 * 这个工作区里它此刻的连接状态：有这个工作区的实例就看它自己的——合并状态取各实例
 * 最优，别的工作区就绪会把这里的失败遮住；还没有实例（这里没连过 / Home 会话的实例
 * 不进明细）就退回合并状态。
 */
export function mcpStatusIn(server: McpServerInfo, workspace: AbilityWorkspace | null): McpStatus {
  if (workspace !== null) {
    const own = server.instances.find((instance) => instance.scope === workspace.id);
    if (own !== undefined) return own.status;
  }
  return server.status;
}

/** 只在别处可用时，「别处」是哪：白名单优先，其次是定义它的工作区配置 */
function placesOf(server: McpServerInfo): string[] {
  if (server.scopedTo.length > 0) return server.scopedTo;
  return server.source.global ? [] : server.source.workspaces;
}

/** `reloading`：面板正在重新加载 MCP——用得上的行转「连接中」，不装作状态没变 */
export function mcpRow(
  server: McpServerInfo,
  workspace: AbilityWorkspace | null,
  reloading = false,
): AbilityRow {
  const usable = mcpUsableIn(server, workspace);
  let state: AbilityState;
  let sub: AbilitySub;
  if (!usable) {
    state = "off";
    sub = server.disabled ? { kind: "disabled" } : { kind: "elsewhere", workspaces: placesOf(server) };
  } else {
    const status: McpStatus = reloading ? { kind: "connecting" } : mcpStatusIn(server, workspace);
    if (status.kind === "ready") {
      state = "on";
      sub = { kind: "ready", tools: status.tools.length };
    } else if (status.kind === "failed") {
      state = "failed";
      sub = { kind: "failed", message: firstLine(status.message) };
    } else if (status.kind === "connecting") {
      state = "connecting";
      sub = { kind: "connecting" };
    } else {
      // idle，或文件刚改成启用、快照还停在 disabled：都是「启用了、还没连上」
      state = "idle";
      sub = { kind: "idle" };
    }
  }
  return {
    key: `mcp:${server.name}`,
    kind: "mcp",
    id: server.name,
    name: server.name,
    search: server.name.toLowerCase(),
    state,
    sub,
    usable,
    token: mcpToken(server.name),
    toggle: server.source.global
      ? { kind: "global", on: !server.disabled }
      : { kind: "locked", on: !server.disabled, reason: "workspace-file" },
  };
}

/** 组内按名字排（不按开关状态排：拨了开关的行不该从手指底下跑开） */
function byName(a: AbilityRow, b: AbilityRow): number {
  const x = a.name.toLowerCase();
  const y = b.name.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 合成一串：Skills 在前、MCP 在后，各自按名字排 */
export function abilityRows(input: {
  skills: readonly SkillMeta[];
  servers: readonly McpServerInfo[];
  workspace: AbilityWorkspace | null;
  reloading?: boolean;
}): AbilityRow[] {
  const skills = input.skills.map((meta) => skillRow(meta, input.workspace)).sort(byName);
  const servers = input.servers
    .map((server) => mcpRow(server, input.workspace, input.reloading === true))
    .sort(byName);
  return [...skills, ...servers];
}

/** 页签 + 筛选词（子串、大小写不敏感）留下的行，顺序不变 */
export function visibleRows(rows: readonly AbilityRow[], tab: AbilityTab, query: string): AbilityRow[] {
  const q = query.trim().toLowerCase();
  return rows.filter((row) => (tab === "all" || row.kind === tab) && (q === "" || row.search.includes(q)));
}

/** 页签上的计数：每类一共几个（不随筛选变——计数说的是「有多少」，不是「剩多少」） */
export function tabCounts(rows: readonly AbilityRow[]): Record<AbilityTab, number> {
  const skill = rows.filter((row) => row.kind === "skill").length;
  return { all: rows.length, skill, mcp: rows.length - skill };
}

export interface AbilityGroup {
  kind: AbilityKind;
  rows: AbilityRow[];
  /** 组头的「这里能用几个 / 一共几个」：数这一类的全部行，不受筛选影响 */
  usable: number;
  total: number;
}

/** 分组：Skills 组在前、MCP 组在后；`shown` 里没有行的组不出 */
export function groupRows(all: readonly AbilityRow[], shown: readonly AbilityRow[]): AbilityGroup[] {
  const groups: AbilityGroup[] = [];
  for (const kind of ["skill", "mcp"] as const) {
    const rows = shown.filter((row) => row.kind === kind);
    if (rows.length === 0) continue;
    const ofKind = all.filter((row) => row.kind === kind);
    groups.push({ kind, rows, usable: ofKind.filter((row) => row.usable).length, total: ofKind.length });
  }
  return groups;
}

export interface PickView {
  /** 可选的分组（只含这个工作区用得上的行） */
  groups: AbilityGroup[];
  /** 扁平的可选行，↑↓ 的高亮下标指向它；顺序 = 分组的展示顺序 */
  pickable: AbilityRow[];
  /** 筛选命中、但这个工作区没启用的：灰着收在底部，不可选 */
  unusable: AbilityRow[];
}

/** 「/ + 空格」选取态：用得上的分组在上可选，没启用的灰着收底 */
export function pickView(all: readonly AbilityRow[], tab: AbilityTab, query: string): PickView {
  const shown = visibleRows(all, tab, query);
  const groups = groupRows(all, shown.filter((row) => row.usable));
  return {
    groups,
    pickable: groups.flatMap((group) => group.rows),
    unusable: shown.filter((row) => !row.usable),
  };
}

/** Tab 轮换页签（Shift+Tab 反着走） */
export function nextTab(tab: AbilityTab, backwards = false): AbilityTab {
  const n = ABILITY_TABS.length;
  const index = ABILITY_TABS.indexOf(tab);
  return ABILITY_TABS[(index + (backwards ? n - 1 : 1)) % n] ?? "all";
}

/** ↑↓ 移高亮：到头绕回；没有可选行 = -1；还没高亮时 ↓ 落第一行、↑ 落最后一行 */
export function movePick(index: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}

/** 可选行变了（筛选 / 切页签 / 清单读回来）：高亮夹回范围；有行就至少亮第一行 */
export function clampPick(index: number, count: number): number {
  if (count === 0) return -1;
  return Math.min(Math.max(index, 0), count - 1);
}
