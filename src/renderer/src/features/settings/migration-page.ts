/**
 * Migration 页骨架层的纯逻辑：步骤状态、来源行状态、行内徽标与事实条的文案、底栏的句子。
 * 与 migration-groups.ts 同样不碰 React、不碰 IPC，`node --test` 直接测（migration-page.test.ts）。
 *
 * 这一层只**描述**扫描报告与勾选的结果，不决定选什么、导什么——那些规则在
 * migration-groups / -skills / -mcp 与主进程里，这里一条都不改。
 *
 * 文案口径（设计系统 *Content fundamentals*）：常驻的只留名词与数字，整句进悬停；
 * 悬停句子之间用 `·` 连接。
 */
import type {
  ImportPlanItem,
  ImportRunReport,
  ImportScanReport,
  ImportSkillMode,
  ImportSkipItem,
  ImportSourceId,
  ImportSourceProbe,
} from "@shared/import";
import type { ModelPair } from "@shared/settings";
import type { ProviderDto } from "@shared/provider";
import type { Messages } from "../../messages-en.ts";
import { hasCredentials } from "./providers-view-model.ts";
import {
  formatBytes,
  formatMoment,
  type GroupedSessions,
  type ImportSummary,
} from "./migration-groups.ts";

// ---------------------------------------------------------------------------
// 步骤
// ---------------------------------------------------------------------------

/** 左侧编号圆点的三态：还没轮到 / 正在这一步 / 做完了（打勾） */
export type StepState = "pending" | "current" | "done";

export interface StepStates {
  sources: StepState;
  sessions: StepState;
  skills: StepState;
  mcp: StepState;
  import: StepState;
}

/**
 * 五步的状态。扫描前只有 Sources 是当前步；扫描后 Sources 打勾，Sessions / Skills / MCP
 * 同时是当前步（三段的勾选没有先后），其中扫出来没有可导条目的那段直接打勾（没什么要选的）；
 * 导入完成后全部打勾。底栏 Import 在扫描后、且至少一段有可导条目时是当前步。
 */
export function stepStates(input: {
  scanned: boolean;
  imported: boolean;
  hasSessions: boolean;
  hasSkills: boolean;
  hasMcp: boolean;
}): StepStates {
  if (!input.scanned) {
    return { sources: "current", sessions: "pending", skills: "pending", mcp: "pending", import: "pending" };
  }
  const pick = (has: boolean): StepState => (input.imported || !has ? "done" : "current");
  const any = input.hasSessions || input.hasSkills || input.hasMcp;
  return {
    sources: "done",
    sessions: pick(input.hasSessions),
    skills: pick(input.hasSkills),
    mcp: pick(input.hasMcp),
    import: input.imported ? "done" : any ? "current" : "pending",
  };
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** 路径清单里每一行的图标：JSON 文件 / 其他文件 / 目录（含 `*` 通配的目录）。 */
export type PathGlyph = "json" | "file" | "folder";

/**
 * 按末段判断：`.json` / `.jsonc` 是 JSON 文件；末段有扩展名（点前至少一个字符，
 * 所以 `.claude` 这种点开头的目录不算）是其他文件；其余是目录。探测结果不带类型，
 * 只能从路径形状看——这里只决定一个图标，猜错也不影响读什么。
 */
export function pathGlyph(path: string): PathGlyph {
  const last = path.split("/").filter((part) => part !== "").pop() ?? "";
  if (/.\.jsonc?$/i.test(last)) return "json";
  if (/.\.[a-z0-9]+$/i.test(last)) return "file";
  return "folder";
}

/** 这些来源扫描会读的全部路径，按来源顺序、去重。 */
export function sourcePaths(probes: readonly ImportSourceProbe[], ids: readonly ImportSourceId[]): string[] {
  const paths: string[] = [];
  for (const probe of probes) {
    if (!ids.includes(probe.id)) continue;
    for (const path of probe.paths) {
      if (!paths.includes(path)) paths.push(path);
    }
  }
  return paths;
}

/** 扫描后来源行尾的计数（能导的会话 / skill / MCP server 数） */
export interface SourceCounts {
  sessions: number;
  skills: number;
  mcp: number;
}

export type SourceStatus =
  | { kind: "not-found" }
  /** 在盘上、还没扫（只 stat 过，什么都没读） */
  | { kind: "found" }
  /** 扫描之后才勾上的来源：列表里还没有它，要 Rescan */
  | { kind: "not-scanned" }
  | { kind: "scanned"; counts: SourceCounts };

/**
 * 来源行尾的状态。`scanned` 是这一来源的计数，没参与上一次扫描为 null；
 * `scanReady` = 页面上有一份扫描结果。
 */
export function sourceStatus(
  probe: ImportSourceProbe,
  ticked: boolean,
  scanReady: boolean,
  scanned: SourceCounts | null,
): SourceStatus {
  if (!probe.found) return { kind: "not-found" };
  if (scanned !== null) return { kind: "scanned", counts: scanned };
  if (scanReady && ticked) return { kind: "not-scanned" };
  return { kind: "found" };
}

/** 「28 sessions · 4 skills · 1 MCP」：是 0 的那项不写；全是 0 返回空串（行尾写 Nothing new）。 */
export function countLine(counts: SourceCounts, t: Messages): string {
  return joined([
    counted(counts.sessions, t.migration.sessions),
    counted(counts.skills, t.migration.skills),
    counted(counts.mcp, t.migration.mcpShort),
  ]);
}

// ---------------------------------------------------------------------------
// Sessions：行内徽标与事实条
// ---------------------------------------------------------------------------

/** 单条会话行上「相对 orbita 的状态」徽标；没导过的没有。 */
export interface ChangeBadge {
  kind: "updated" | "diverged" | "deleted";
  text: string;
  tip: string;
}

export function changeBadge(item: ImportPlanItem, t: Messages): ChangeBadge | null {
  const source = t.migration.sources[item.source];
  if (item.change === "updated") {
    return {
      kind: "updated",
      text: `+${item.newMessages}`,
      tip: t.migration.updatedBadgeTip(item.newMessages, source),
    };
  }
  if (item.change === "diverged") {
    return { kind: "diverged", text: t.migration.divergedBadge(item.newMessages), tip: t.migration.divergedTip(source) };
  }
  if (item.change === "deleted") {
    return { kind: "deleted", text: t.migration.deletedBadge, tip: t.migration.deletedTip };
  }
  return null;
}

/** 行尾模型格的悬停：导入的会话不绑定模型，原模型只是记录。 */
export function modelTip(t: Messages): string {
  return t.migration.modelRecordedTip;
}

/** 一块里有不止一个来源时，单条会话行才写来源名（只有一个来源时组名旁已经写了）。 */
export function mixedSources(items: readonly ImportPlanItem[]): boolean {
  return new Set(items.map((item) => item.source)).size > 1;
}

/** 转换不了的跳过项（已导入的不算：它们是「不用导」，不是「导不了」）。 */
export function unconvertibleSkips(report: ImportScanReport): ImportSkipItem[] {
  return report.skipped.filter((skip) => skip.reason !== "already-imported");
}

export type SessionFactKind = "hidden" | "greeting" | "orphaned" | "already" | "cannot";

/** 列表下面那一行图标事实：一个数字 + 一个短语常驻，整句进悬停。 */
export interface SessionFact {
  kind: SessionFactKind;
  count: number;
  label: string;
  tip: string;
}

/** 模型名在悬停里最多列这么多个，其余写 … */
const FALLBACK_MODELS_SHOWN = 3;

/**
 * 事实条。顺序即显示顺序：先是影响这次导入的（被筛掉的、单列的子会话），
 * 后是列表之外的（已导入的、导不了的）。数是 0 的不出现。
 */
export function sessionFacts(
  report: ImportScanReport,
  grouped: GroupedSessions,
  now: number,
  t: Messages,
): SessionFact[] {
  const facts: SessionFact[] = [];
  if (grouped.hidden > 0) {
    facts.push({
      kind: "hidden",
      count: grouped.hidden,
      label: t.migration.factHidden,
      tip: t.migration.factHiddenTip,
    });
  }
  if (grouped.leftOut > 0) {
    facts.push({
      kind: "greeting",
      count: grouped.leftOut,
      label: t.migration.factGreeting,
      tip: t.migration.factGreetingTip,
    });
  }
  if (report.orphanedSubSessions > 0) {
    facts.push({
      kind: "orphaned",
      count: report.orphanedSubSessions,
      label: t.migration.factOrphaned,
      tip: t.migration.factOrphanedTip,
    });
  }
  const already = report.skipped.length - unconvertibleSkips(report).length;
  if (already > 0) {
    facts.push({
      kind: "already",
      count: already,
      label: t.migration.factAlready,
      tip:
        t.migration.factAlreadyTip +
        (report.lastImportAt === null ? "" : t.migration.lastImport(formatMoment(report.lastImportAt, now))),
    });
  }
  const cannot = unconvertibleSkips(report).length + report.withoutPiSession;
  if (cannot > 0) {
    facts.push({
      kind: "cannot",
      count: cannot,
      label: t.migration.factCannot,
      tip: t.migration.factCannotTip,
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// 底栏
// ---------------------------------------------------------------------------

/** 「3 sessions」「1 skill」；数量为 0 返回 null，给 joined 滤掉。单复数 / 量词在文案表里 */
export function counted(count: number, format: (count: number) => string): string | null {
  return count > 0 ? format(count) : null;
}

export function joined(parts: readonly (string | null)[], separator = " · "): string {
  return parts.filter((part): part is string => part !== null).join(separator);
}

/** 底栏主句：「Import 3 sessions · 5 skills · update 1 session」；只有追加时「Update 1 session」。 */
export function headline(sessions: number, updates: number, skills: number, mcp: number, t: Messages): string {
  const m = t.migration;
  const imports = joined([counted(sessions, m.sessions), counted(skills, m.skills), counted(mcp, m.mcpServers)]);
  const update = counted(updates, m.sessions);
  if (imports === "") return update === null ? m.nothingTicked : m.updateOnly(update);
  return update === null ? m.importOnly(imports) : m.importAndUpdate(imports, update);
}

/** 执行中的主句：「Importing 3 sessions, 5 skills…」 */
export function runningHeadline(sessions: number, skills: number, mcp: number, t: Messages): string {
  const m = t.migration;
  return m.importingList(
    joined([counted(sessions, m.sessions), counted(skills, m.skills), counted(mcp, m.mcpServers)], t.common.listSeparator),
  );
}

export type FootFactKind = "sub" | "workspaces" | "bytes" | "skills" | "mcp";

/** 底栏副行的一项：图标 + 短事实常驻，整句进悬停。 */
export interface FootFact {
  kind: FootFactKind;
  text: string;
  tip: string;
}

/** 导入前的副行：跟着来的子会话、要新建的工作区、要复制的体量、skill 的方式、MCP 停用。 */
export function footFacts(
  summary: ImportSummary,
  skills: number,
  skillMode: ImportSkillMode,
  mcp: number,
  t: Messages,
): FootFact[] {
  const m = t.migration;
  const facts: FootFact[] = [];
  if (summary.subSessions > 0) {
    facts.push({
      kind: "sub",
      text: `${summary.subSessions}`,
      tip: m.subSessionsTip(summary.subSessions),
    });
  }
  if (summary.newWorkspaces > 0) {
    facts.push({
      kind: "workspaces",
      text: counted(summary.newWorkspaces, m.newWorkspaces) ?? "",
      tip: m.newWorkspacesTip,
    });
  }
  if (summary.sessions + summary.updates > 0) {
    facts.push({
      kind: "bytes",
      text: formatBytes(summary.bytes),
      tip: m.bytesTip,
    });
  }
  if (skills > 0) {
    facts.push(
      skillMode === "copy"
        ? { kind: "skills", text: m.skillsCopied, tip: m.skillsCopiedTip }
        : { kind: "skills", text: m.skillsLinked, tip: m.skillsLinkedTip },
    );
  }
  if (mcp > 0) {
    facts.push({
      kind: "mcp",
      text: m.mcpOff,
      tip: m.mcpOffTip,
    });
  }
  return facts;
}

/**
 * 完成态主句：「Imported 34 sessions · 5 skills · 1 MCP server (off) · updated 1 session · 1 new workspace」。
 * 只有追加时「Updated 1 session」；什么都没落进来（全失败）时「Nothing imported」。
 */
export function doneHeadline(result: ImportRunReport, t: Messages): string {
  const m = t.migration;
  const imports = joined([
    counted(result.imported, m.sessions),
    counted(result.skillsImported, m.skills),
    counted(result.mcpImported, m.mcpImportedOff),
  ]);
  const update = counted(result.updated, m.sessions);
  const main =
    imports === ""
      ? update === null
        ? m.nothingImported
        : m.updatedOnly(update)
      : update === null
        ? m.importedOnly(imports)
        : m.importedAndUpdated(imports, update);
  return joined([main, counted(result.createdWorkspaces.length, m.newWorkspaces)]);
}

export type DoneFactKind = "sidebar" | "failed";

export interface DoneFact {
  kind: DoneFactKind;
  text: string;
  tip: string;
}

/**
 * 完成态副行：有会话落进来就指一下在哪（In the sidebar now）；失败的会话 / skill / MCP
 * 各一项，悬停写第一条原因与怎么办。
 */
export function doneFacts(result: ImportRunReport, t: Messages): DoneFact[] {
  const m = t.migration;
  const facts: DoneFact[] = [];
  if (result.imported + result.updated > 0) {
    facts.push({ kind: "sidebar", text: m.inSidebar, tip: m.inSidebarTip });
  }
  const first = result.failed[0];
  if (first !== undefined) {
    facts.push({
      kind: "failed",
      text: m.sessionsFailed(result.failed.length),
      tip: m.retryTip(first.error ?? m.unknownError),
    });
  }
  const skill = result.skillsFailed[0];
  if (skill !== undefined) {
    facts.push({
      kind: "failed",
      text: m.skillsFailed(result.skillsFailed.length),
      tip: `${skill.slug}: ${skill.error}`,
    });
  }
  const mcp = result.mcpFailed[0];
  if (mcp !== undefined) {
    facts.push({
      kind: "failed",
      text: m.mcpFailed(result.mcpFailed.length),
      tip: `${mcp.name}: ${mcp.error}`,
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// 「跳过随手一句」前面的三步清单（配置服务商 → 选家务活模型 → 检查）
// ---------------------------------------------------------------------------

/** 清单两步的完成态；第三步（检查本身）能不能勾由这两步推出。 */
export interface GreetingStepsState {
  /** ① 至少配了一个能用的服务商（有密钥且声明过模型——与模型菜单同一把尺） */
  provider: boolean;
  /** ② 选了家务活模型，且它指的服务商与模型都还在（provider 被删按没选处理） */
  chore: boolean;
}

/**
 * 清单状态**每次渲染按当下的服务商列表与设置现算**，不吃扫描报告里的旧值——
 * 用户配完回来必须立刻看到打勾（wafo 2026-09-28：我们设计的很体贴，用户感知不到
 * 还觉得懵逼——为什么这个小功能要麻烦我跳转两次）。
 */
export function greetingSteps(
  providers: readonly ProviderDto[],
  choreModel: ModelPair | undefined,
): GreetingStepsState {
  const usable = providers.filter((p) => hasCredentials(p.auth) && p.models.declared.length > 0);
  return {
    provider: usable.length > 0,
    chore:
      choreModel !== undefined &&
      usable.some(
        (p) => p.id === choreModel.providerId && p.models.declared.some((m) => m.id === choreModel.modelId),
      ),
  };
}
