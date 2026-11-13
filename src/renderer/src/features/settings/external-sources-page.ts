/**
 * 设置 › 外部来源页的纯逻辑：步骤状态、来源行的状态、底栏（技能与 MCP 的导入）的句子。
 * 不碰 React、不碰 IPC，`node --test` 直接测（external-sources-page.test.ts）。
 *
 * 页面两件事分开讲：
 * - 别的工具里的聊天记录：**只读**，留在源头，read_task 去读；这里只管看见哪些来源、开关、加目录。
 * - 技能与 MCP：是配置，复制一次就对（2026-10 用户裁决「skills 和 MCP 是配置……迁移保留」），
 *   扫描、勾选、导入照旧。
 */
import type { ExternalSourceInfo } from "@shared/external-sources";
import type { ImportRunReport, ImportSkillMode, ImportSourceId } from "@shared/import";
import type { Messages } from "../../messages-en.ts";

/** 左侧编号圆点的三态：还没轮到 / 正在这一步 / 做完了（打勾） */
export type StepState = "pending" | "current" | "done";

export interface StepStates {
  sources: StepState;
  skills: StepState;
  mcp: StepState;
  import: StepState;
}

/**
 * 四步的状态。来源一列出来就打勾（只读，没什么要做的）；技能与 MCP 扫描前是当前步，扫出来
 * 没有可导条目的那段直接打勾；导入完成后全部打勾。底栏在至少一段有可导条目时是当前步。
 */
export function stepStates(input: { listed: boolean; scanned: boolean; imported: boolean; hasSkills: boolean; hasMcp: boolean }): StepStates {
  const sources: StepState = input.listed ? "done" : "current";
  if (!input.scanned) return { sources, skills: "current", mcp: "pending", import: "pending" };
  const pick = (has: boolean): StepState => (input.imported || !has ? "done" : "current");
  return {
    sources,
    skills: pick(input.hasSkills),
    mcp: pick(input.hasMcp),
    import: input.imported ? "done" : input.hasSkills || input.hasMcp ? "current" : "pending",
  };
}

/**
 * 技能与 MCP 从哪些来源扫：有 skills 目录或 MCP 配置的那几家，加多家共用的 ~/.agents/skills。
 * 没装的来源主进程照常扫空，不报错。
 */
export const CONFIG_SOURCES: readonly ImportSourceId[] = ["proma", "claude-code", "kimi-code", "opencode", "agent-skills"];

// ---------------------------------------------------------------------------
// 来源行
// ---------------------------------------------------------------------------

export type SourceRowState =
  /** 本机没发现 */
  | { kind: "missing" }
  /** 发现了：会话数（关着的也照数） */
  | { kind: "found"; sessions: number };

export function sourceRowState(source: ExternalSourceInfo): SourceRowState {
  return source.roots.length === 0 ? { kind: "missing" } : { kind: "found", sessions: source.sessions };
}

/** 一个来源都没发现：页面出空态，告诉用户下一步能做什么。 */
export function noneFound(sources: readonly ExternalSourceInfo[]): boolean {
  return sources.every((source) => source.roots.length === 0);
}

/** 打开 / 关上一个来源后要存的整张开关表（其余来源保持页面上看到的状态）。 */
export function switchesAfter(
  sources: readonly ExternalSourceInfo[],
  id: ExternalSourceInfo["id"],
  enabled: boolean,
): Partial<Record<ExternalSourceInfo["id"], boolean>> {
  return Object.fromEntries(sources.map((source) => [source.id, source.id === id ? enabled : source.enabled]));
}

// ---------------------------------------------------------------------------
// 底栏
// ---------------------------------------------------------------------------

/** 「1 skill」；数量为 0 返回 null，给 joined 滤掉。单复数 / 量词在文案表里 */
export function counted(count: number, format: (count: number) => string): string | null {
  return count > 0 ? format(count) : null;
}

export function joined(parts: readonly (string | null)[], separator = " · "): string {
  return parts.filter((part): part is string => part !== null).join(separator);
}

/** 底栏主句：「Import 5 skills · 1 MCP server」；什么都没勾「Nothing ticked」。 */
export function headline(skills: number, mcp: number, t: Messages): string {
  const m = t.migration;
  const imports = joined([counted(skills, m.skills), counted(mcp, m.mcpServers)]);
  return imports === "" ? m.nothingTicked : m.importOnly(imports);
}

/** 执行中的主句：「Importing 5 skills, 1 MCP server…」 */
export function runningHeadline(skills: number, mcp: number, t: Messages): string {
  const m = t.migration;
  return m.importingList(joined([counted(skills, m.skills), counted(mcp, m.mcpServers)], t.common.listSeparator));
}

export type FootFactKind = "skills" | "mcp";

/** 底栏副行的一项：图标 + 短事实常驻，整句进悬停。 */
export interface FootFact {
  kind: FootFactKind;
  text: string;
  tip: string;
}

/** 导入前的副行：skill 的方式（复制 / 链接）、MCP 导进来是停用的。 */
export function footFacts(skills: number, skillMode: ImportSkillMode, mcp: number, t: Messages): FootFact[] {
  const m = t.migration;
  const facts: FootFact[] = [];
  if (skills > 0) {
    facts.push(
      skillMode === "copy"
        ? { kind: "skills", text: m.skillsCopied, tip: m.skillsCopiedTip }
        : { kind: "skills", text: m.skillsLinked, tip: m.skillsLinkedTip },
    );
  }
  if (mcp > 0) facts.push({ kind: "mcp", text: m.mcpOff, tip: m.mcpOffTip });
  return facts;
}

/** 完成态主句：「Imported 5 skills · 1 MCP server (off)」；什么都没落进来「Nothing imported」。 */
export function doneHeadline(result: ImportRunReport, t: Messages): string {
  const m = t.migration;
  const imports = joined([counted(result.skillsImported, m.skills), counted(result.mcpImported, m.mcpImportedOff)]);
  return imports === "" ? m.nothingImported : m.importedOnly(imports);
}

export interface DoneFact {
  text: string;
  tip: string;
}

/** 完成态副行：失败的 skill / MCP 各一项，悬停写第一条原因。 */
export function doneFacts(result: ImportRunReport, t: Messages): DoneFact[] {
  const m = t.migration;
  const facts: DoneFact[] = [];
  const skill = result.skillsFailed[0];
  if (skill !== undefined) facts.push({ text: m.skillsFailed(result.skillsFailed.length), tip: `${skill.slug}: ${skill.error}` });
  const mcp = result.mcpFailed[0];
  if (mcp !== undefined) facts.push({ text: m.mcpFailed(result.mcpFailed.length), tip: `${mcp.name}: ${mcp.error}` });
  return facts;
}
