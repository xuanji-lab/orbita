/**
 * 设置 › 外部来源页的纯逻辑：来源行的状态、「从别的工具导入技能与 MCP」四步的状态与「导入」一步的句子。
 * 不碰 React、不碰 IPC，`node --test` 直接测（external-sources-page.test.ts）。
 *
 * 页面两件事分开讲：
 * - 别的工具里的聊天记录：**只读**，留在源头，read_task 去读；这里只管看见哪些来源、开关、加目录。
 * - 技能与 MCP：是配置，复制一次就对（2026-10 用户裁决「skills 和 MCP 是配置……迁移保留」），
 *   扫描、勾选、导入照旧。
 */
import type { ExternalSourceInfo } from "@shared/external-sources";
import type { ImportRunReport, ImportSkillMode } from "@shared/import";
import type { Messages } from "../../messages-en.ts";

/** 左侧编号圆点的三态：还没轮到 / 正在这一步 / 做完了（打勾） */
export type StepState = "pending" | "current" | "done";

/** 「从别的工具导入技能与 MCP」一块的四步（上面聊天记录那一块是常驻清单，不编号）。 */
export interface StepStates {
  sources: StepState;
  skills: StepState;
  mcp: StepState;
  import: StepState;
}

/**
 * 扫描前只有「来源」是当前步；扫描后来源打勾，技能与 MCP 同时是当前步，扫出来没有可导条目的那段
 * 直接打勾；导入完成后全部打勾。「导入」在扫描后、且至少一段有可导条目时是当前步。
 */
export function stepStates(input: { scanned: boolean; imported: boolean; hasSkills: boolean; hasMcp: boolean }): StepStates {
  if (!input.scanned) return { sources: "current", skills: "pending", mcp: "pending", import: "pending" };
  const pick = (has: boolean): StepState => (input.imported || !has ? "done" : "current");
  return {
    sources: "done",
    skills: pick(input.hasSkills),
    mcp: pick(input.hasMcp),
    import: input.imported ? "done" : input.hasSkills || input.hasMcp ? "current" : "pending",
  };
}

// ---------------------------------------------------------------------------
// 来源行
// ---------------------------------------------------------------------------

export type SourceRowState =
  /** 本机没发现：默认位置的目录都不在（手动加的目录也都不在了） */
  | { kind: "missing" }
  /** 目录在，但一个会话都没有：默认位置只有别的东西（如只有状态库的 ~/.codex），或手动加的目录是空的 */
  | { kind: "empty-dir" }
  /** 发现了：会话数（关着的也照数） */
  | { kind: "found"; sessions: number };

/**
 * 一行的状态。自动发现与手动加的走同一套说法：有会话才算「发现了」（才给开关）；目录在、
 * 0 个会话一律写「目录在，没有会话」，不写「0 个会话」配一个开关。
 */
export function sourceRowState(source: ExternalSourceInfo): SourceRowState {
  if (source.roots.length > 0 && source.sessions > 0) return { kind: "found", sessions: source.sessions };
  if (source.roots.length > 0) return source.roots.some((root) => root.hasData) ? { kind: "empty-dir" } : { kind: "missing" };
  return source.expectedExists ? { kind: "empty-dir" } : { kind: "missing" };
}

/** 一个来源都没发现：页面出空态，告诉用户下一步能做什么。 */
export function noneFound(sources: readonly ExternalSourceInfo[]): boolean {
  return sources.every((source) => sourceRowState(source).kind !== "found");
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

/**
 * 「导入」一步的主句：扫描前说下一步；扫出来一条可导的都没有写「没有可导入的」（全都已在 orbita
 * 里、或这几个来源里本来就没有）；有可导的但一个没勾才是「什么都没勾」；否则「导入 5 个技能 · 1 个 MCP 服务」。
 */
export function headline(input: { scanned: boolean; importable: number; skills: number; mcp: number }, t: Messages): string {
  const m = t.migration;
  if (!input.scanned) return t.externalSources.importHint;
  if (input.importable === 0) return t.externalSources.nothingImportable;
  const imports = joined([counted(input.skills, m.skills), counted(input.mcp, m.mcpServers)]);
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
