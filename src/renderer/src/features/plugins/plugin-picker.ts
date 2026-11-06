/**
 * 「/ + 空格」在插件面板里的选取态——纯逻辑（行怎么排、↑↓ ↵ → ← 各落到哪、未启用的怎么挡）。
 * 画与键盘在 PluginsView.tsx；写成纯函数只为可测（`node --test` 只加载 .ts）。
 *
 * 行就是插件页的行（PluginView），一份数据不开第二份：真插件、你原来零散的技能、你原来的 MCP 都在里面。
 * 选中后插回输入框的 token 随来源走：真插件 `/plugin:<name>`、零散技能 `/skill:<slug>`、零散 MCP `/mcp:<server>`
 * （老用法不变）。→ 展开一个真插件，列出它里面的技能，选其中一条插回 `/skill:<slug>`。
 * 这个工作区没启用的排在下面、灰着，选了只给提示、不插入（发出去模型也用不了它）。
 */
import { parsePluginViewId, scopeApplies, type PluginSkillInfo, type PluginView } from "../../../../shared/plugin.ts";
import { mcpToken, pluginToken, skillToken } from "../../shell/panel-token.ts";
import { filterPlugins } from "./plugin-view.ts";

/** 选取态里的一行：一个插件，或展开后它里面的一条技能。 */
export type PickerRow =
  | {
      kind: "plugin";
      /** 视图 id（展开状态按它记） */
      id: string;
      view: PluginView;
      /** 对这个工作区有效：能选、能展开 */
      usable: boolean;
      /** 选中回车插回输入框的 token */
      token: string;
      /** 能展开：真插件、此处可用、里面有技能 */
      expandable: boolean;
      /** 此刻是展开的 */
      expanded: boolean;
    }
  | {
      kind: "skill";
      /** 它所在的插件（视图 id） */
      parentId: string;
      skill: PluginSkillInfo;
      token: string;
    };

export interface PickerGroup {
  /** usable = 这个工作区能用的；elsewhere = 别处的 / 未启用 */
  key: "usable" | "elsewhere";
  rows: PickerRow[];
}

export interface PickerModel {
  groups: PickerGroup[];
  /** 键盘走的顺序：两组的行依次展平（展开的插件后面紧跟它的技能行） */
  flat: PickerRow[];
}

/** 真插件排前面，其次零散技能，最后零散 MCP；同类按显示名、再按 id，顺序稳定。 */
const ORIGIN_RANK: Record<PluginView["origin"], number> = { plugin: 0, "user-skill": 1, "user-mcp": 2 };

function compare(a: PluginView, b: PluginView): number {
  const byOrigin = ORIGIN_RANK[a.origin] - ORIGIN_RANK[b.origin];
  if (byOrigin !== 0) return byOrigin;
  const byName = a.name.localeCompare(b.name);
  return byName !== 0 ? byName : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** 一个视图选中后插回输入框的 token；id 拆不开（不该发生）为 null。 */
export function tokenOfView(view: Pick<PluginView, "id">): string | null {
  const parsed = parsePluginViewId(view.id);
  if (parsed === null) return null;
  return parsed.origin === "plugin" ? pluginToken(parsed.key) : parsed.origin === "user-skill" ? skillToken(parsed.key) : mcpToken(parsed.key);
}

/**
 * 排出选取态的两组行。`query` 沿用插件页的筛选（名字、描述、技能名、服务名）；
 * `expandedId` 是展开着的插件（只有此处可用、里面有技能的才真展开）。
 * 一个工作区也没有（Home 会话，`workspaceId` 为 null）时只有「所有工作区」范围的算可用，与开轮装配同一口径（scopeApplies）。
 */
export function buildPicker(
  views: readonly PluginView[],
  workspaceId: string | null,
  query: string,
  expandedId: string | null,
): PickerModel {
  const usable: PickerRow[] = [];
  const elsewhere: PickerRow[] = [];
  for (const view of [...filterPlugins(views, query)].sort(compare)) {
    const token = tokenOfView(view);
    if (token === null) continue;
    const isUsable = scopeApplies(view.scope, workspaceId);
    const expandable = isUsable && view.origin === "plugin" && view.skills.length > 0;
    const expanded = expandable && expandedId === view.id;
    const row: PickerRow = { kind: "plugin", id: view.id, view, usable: isUsable, token, expandable, expanded };
    const into = isUsable ? usable : elsewhere;
    into.push(row);
    if (expanded) {
      for (const skill of view.skills) into.push({ kind: "skill", parentId: view.id, skill, token: skillToken(skill.slug) });
    }
  }
  const groups: PickerGroup[] = [];
  if (usable.length > 0) groups.push({ key: "usable", rows: usable });
  if (elsewhere.length > 0) groups.push({ key: "elsewhere", rows: elsewhere });
  return { groups, flat: groups.flatMap((group) => group.rows) };
}

/** ↑↓ 移高亮：到头绕回；没有行 = -1；还没高亮时 ↓ 落第一行、↑ 落最后一行 */
export function movePick(index: number, delta: 1 | -1, count: number): number {
  if (count === 0) return -1;
  if (index < 0) return delta > 0 ? 0 : count - 1;
  return (index + delta + count) % count;
}

/** 行变了（筛选、展开收起、列表读回来）：高亮夹回范围；有行就至少亮第一行 */
export function clampPick(index: number, count: number): number {
  if (count === 0) return -1;
  return Math.min(Math.max(index, 0), count - 1);
}

/** 一次按键（或点击）的结果，由画面去执行。 */
export type PickerOutcome =
  /** 把 token 插回输入框 */
  | { kind: "insert"; token: string }
  /** 没启用：面板里提示「先在这个工作区启用」，不插入 */
  | { kind: "blocked"; name: string }
  /** 展开 / 收起某个插件；收起时高亮落回那个插件行 */
  | { kind: "expand"; id: string }
  | { kind: "collapse"; id: string }
  | { kind: "none" };

/** ↵ / 点击：整个插件（或展开后的某条技能）插回；没启用的只提示。 */
export function activateRow(row: PickerRow | undefined): PickerOutcome {
  if (row === undefined) return { kind: "none" };
  if (row.kind === "skill") return { kind: "insert", token: row.token };
  return row.usable ? { kind: "insert", token: row.token } : { kind: "blocked", name: row.view.name };
}

/** →：能展开又还没展开的插件展开；其它什么也不做。 */
export function expandRow(row: PickerRow | undefined): PickerOutcome {
  return row !== undefined && row.kind === "plugin" && row.expandable && !row.expanded ? { kind: "expand", id: row.id } : { kind: "none" };
}

/** ←：展开着的插件收起；展开里的技能行收起它所在的插件。 */
export function collapseRow(row: PickerRow | undefined): PickerOutcome {
  if (row === undefined) return { kind: "none" };
  if (row.kind === "skill") return { kind: "collapse", id: row.parentId };
  return row.expanded ? { kind: "collapse", id: row.id } : { kind: "none" };
}

/** 收起后高亮该落在哪：那个插件行在展平列表里的下标（找不到为 -1）。 */
export function indexOfPlugin(flat: readonly PickerRow[], id: string): number {
  return flat.findIndex((row) => row.kind === "plugin" && row.id === id);
}
