/**
 * 斜杠指令面板的**可测内核**：分节行模型、键盘导航、几何定位。DOM 测量（textarea
 * 里 `/` 字符的坐标，见 caret-point.ts）与渲染在 Composer.tsx，这里只放纯函数。
 *
 * 面板语义（2026-10-03 用户裁决）：
 * - **往下开**：顶缘在 `/` 所在行下方、盖住输入卡底栏也可以，但**不得伸出输入卡**；
 *   高度 = min(可见三行条目, 到卡内底边的距离)，超出部分内部滚动。
 * - **宽度**：理想宽 400，卡内放不下就收窄；左缘对齐 `/` 的横坐标，靠右放不下就
 *   向左平移，仍留在卡内。说明文字（description）在面板够宽时显示，窄了隐藏。
 * - **分节**：指令（/compact /new，仅消息开头的主模式）→ Skills → MCP，各节带
 *   kicker 标头（sticky 吸顶，不占可见三行的名额）。↑↓ 跨节线性移动（节边界
 *   自然续到下一节、循环）；←→ 跳到相邻节并选中它的第一项。
 */

import type { SkillMeta } from "@shared/skill";
import { filterSkills, skillsByPrefix } from "../features/skills/skill-filter.ts";

/** 面板里的一行。name 是等宽主名（面板里显示的插入形态），description 是说明 */
export type SlashRow =
  | { kind: "command"; action: "compact" | "new"; name: string; description: string }
  | { kind: "skill"; slug: string; name: string; description: string }
  | { kind: "mcp"; server: string; name: string; description: string };

export interface SlashSection {
  id: "commands" | "skills" | "mcp";
  rows: SlashRow[];
}

/**
 * 组节。查询词按节过滤：指令与 MCP 用前缀（打字辅助），skill 沿用既有分工
 * （主模式子串搜索 / 补全模式严格前缀——第三道闸）。**空节剔除**：←→ 只在
 * 非空节间轮转，面板不为空节画 kicker。
 */
export function slashSections(args: {
  /** token 处于消息开头 = 主模式；补全模式（句中）不列动作项 */
  atMessageStart: boolean;
  query: string;
  /** 动作项（文案已由调用方注入） */
  commands: readonly { kind: "compact" | "new"; name: string; description: string }[];
  /** 可用 skill（missing 已滤） */
  skills: readonly SkillMeta[];
  /** 已配置且未停用的 MCP server */
  servers: readonly { name: string; detail: string }[];
}): SlashSection[] {
  const q = args.query.trim().toLowerCase();
  const sections: SlashSection[] = [];
  if (args.atMessageStart) {
    const rows = args.commands
      .filter((command) => command.name.startsWith(q))
      .map<SlashRow>((command) => ({ kind: "command", action: command.kind, name: `/${command.name}`, description: command.description }));
    if (rows.length > 0) sections.push({ id: "commands", rows });
  }
  const usable = args.skills.filter((meta) => !meta.missing);
  const matched = args.atMessageStart ? filterSkills([...usable], q) : skillsByPrefix([...usable], q);
  const skillRows = matched.map<SlashRow>((meta) => ({
    kind: "skill",
    slug: meta.slug,
    name: `/skill:${meta.slug}`,
    description: meta.description,
  }));
  if (skillRows.length > 0) sections.push({ id: "skills", rows: skillRows });
  const mcpRows = args.servers
    .filter((server) => server.name.toLowerCase().startsWith(q))
    .map<SlashRow>((server) => ({ kind: "mcp", server: server.name, name: `/mcp:${server.name}`, description: server.detail }));
  if (mcpRows.length > 0) sections.push({ id: "mcp", rows: mcpRows });
  return sections;
}

export function slashRowCount(sections: readonly SlashSection[]): number {
  return sections.reduce((sum, section) => sum + section.rows.length, 0);
}

/** 全局行号落在哪一节（-1 或越界按第 0 节；没有节返回 -1） */
export function slashSectionIndexOf(sections: readonly SlashSection[], row: number): number {
  if (sections.length === 0) return -1;
  let seen = 0;
  for (let index = 0; index < sections.length; index++) {
    seen += sections[index]?.rows.length ?? 0;
    if (row < seen) return index;
  }
  return sections.length - 1;
}

/** 某一节第一行的全局行号；空节 / 越界返回 null */
export function slashFirstRowOfSection(sections: readonly SlashSection[], sectionIndex: number): number | null {
  const section = sections[sectionIndex];
  if (section === undefined || section.rows.length === 0) return null;
  let before = 0;
  for (let index = 0; index < sectionIndex; index++) before += sections[index]?.rows.length ?? 0;
  return before;
}

/** 全局行号 → 那一行（越界返回 undefined） */
export function slashRowAt(sections: readonly SlashSection[], row: number): SlashRow | undefined {
  if (row < 0) return undefined;
  let before = 0;
  for (const section of sections) {
    if (row < before + section.rows.length) return section.rows[row - before];
    before += section.rows.length;
  }
  return undefined;
}

/**
 * 键盘导航，返回新的全局行号（-1 = 无高亮）。
 * up / down：跨节线性移动，两端循环；无高亮时 down 落首行、up 落末行（既有语义）。
 * left / right：跳到相邻节（循环）并选中它的**第一项**；无高亮时按第 0 节起算。
 * 没有行 / 没有节时原样返回。
 */
export function moveSlashSelection(
  sections: readonly SlashSection[],
  current: number,
  key: "up" | "down" | "left" | "right",
): number {
  const total = slashRowCount(sections);
  if (total === 0 || sections.length === 0) return current;
  if (key === "up" || key === "down") {
    if (current === -1) return key === "down" ? 0 : total - 1;
    return key === "down" ? (current + 1) % total : (current - 1 + total) % total;
  }
  const from = slashSectionIndexOf(sections, current);
  const to = (from + (key === "right" ? 1 : -1) + sections.length) % sections.length;
  return slashFirstRowOfSection(sections, to) ?? current;
}

/** 面板理想宽度与最小宽度（px）。说明文字要和等宽主名并排，窄于 DESC_MIN 就藏 */
export const SLASH_PANEL_WIDTH = 400;
export const SLASH_PANEL_DESC_MIN = 340;
/** 卡内边距（面板不贴卡边）与 `/` 行下缘到面板顶的缝 */
const PANEL_MARGIN = 4;
const LINE_GAP = 4;
/** 可见「三行」的量：三行条目 + 一条 sticky kicker + 上下 padding */
const THREE_ROWS = 3 * 30 + 22 + 12;
/** 再矮也得给一行多：面板开都开了，一行都看不见等于没开 */
const MIN_HEIGHT = 44;

export interface SlashPanelBox {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
  showDescription: boolean;
}

/**
 * 面板几何。坐标都在输入卡的 **padding box** 里（绝对定位的参照系）。
 * `slashLeft` = `/` 字符的 x；`lineBottom` = `/` 所在行的下缘 y；`cardBottom` =
 * 卡内底边（clientHeight - 底部留白）。高度不超过卡、宽度同理，说明按宽度取舍。
 */
export function slashPanelBox(args: {
  slashLeft: number;
  lineBottom: number;
  cardWidth: number;
  cardBottom: number;
}): SlashPanelBox {
  const width = Math.min(SLASH_PANEL_WIDTH, Math.max(args.cardWidth - PANEL_MARGIN * 2, 0));
  const left = Math.min(Math.max(args.slashLeft, PANEL_MARGIN), Math.max(PANEL_MARGIN, args.cardWidth - width - PANEL_MARGIN));
  const available = args.cardBottom - args.lineBottom - LINE_GAP;
  const maxHeight = Math.min(THREE_ROWS, Math.max(MIN_HEIGHT, available));
  return {
    left,
    top: args.lineBottom + LINE_GAP,
    width,
    maxHeight,
    showDescription: width >= SLASH_PANEL_DESC_MIN,
  };
}
