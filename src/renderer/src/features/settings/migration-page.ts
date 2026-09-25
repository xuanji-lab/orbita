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
import {
  SOURCE_LABEL,
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
export function countLine(counts: SourceCounts): string {
  return joined([
    counted(counts.sessions, "session", "sessions"),
    counted(counts.skills, "skill", "skills"),
    counted(counts.mcp, "MCP", "MCP"),
  ]);
}

/**
 * 路径清单的隐私声明。事实要全：扫描除了读清单里的路径，还会 stat / realpath 每条会话
 * 记录的项目文件夹——判断它是否还在、是否与 orbita 已有工作区同址，决定这条会话的去向；
 * 只看在不在，不读里面的东西。
 */
export const PATHS_NOTE =
  "Scan reads only these paths. It also checks whether each session's project folder still exists, to decide where the session goes.";

// ---------------------------------------------------------------------------
// Sessions：行内徽标与事实条
// ---------------------------------------------------------------------------

/** 单条会话行上「相对 orbita 的状态」徽标；没导过的没有。 */
export interface ChangeBadge {
  kind: "updated" | "diverged" | "deleted";
  text: string;
  tip: string;
}

export function changeBadge(item: ImportPlanItem): ChangeBadge | null {
  const source = SOURCE_LABEL[item.source];
  if (item.change === "updated") {
    return {
      kind: "updated",
      text: `+${item.newMessages}`,
      tip: `${item.newMessages} new ${item.newMessages === 1 ? "message" : "messages"} in ${source} since the last import · they go into the same session here`,
    };
  }
  if (item.change === "diverged") {
    return {
      kind: "diverged",
      text: `+${item.newMessages} · copy`,
      tip: `Also continued in orbita · the ${source} side comes in as a separate copy next to it · not ticked by default`,
    };
  }
  if (item.change === "deleted") {
    return { kind: "deleted", text: "Deleted here", tip: "You deleted it in orbita · not ticked by default" };
  }
  return null;
}

/** 行尾模型格的悬停：原模型没配时说清会用哪个打开、原模型记在哪。 */
export function modelTip(item: ImportPlanItem): string {
  if (item.modelMatched) return "Continues on this model";
  return `${item.importedModel ?? "The original model"} isn't set up here · opens on ${item.modelId} and keeps a record of the original`;
}

/** 一块里有不止一个来源时，单条会话行才写来源名（只有一个来源时组名旁已经写了）。 */
export function mixedSources(items: readonly ImportPlanItem[]): boolean {
  return new Set(items.map((item) => item.source)).size > 1;
}

/** 已导入、又有新消息那一块的去向格悬停（它没有去向菜单：落点由既有的那条会话定）。 */
export const SAME_SESSION_TIP = "New messages go into the same session here · a copy lands next to the original";

/** 转换不了的跳过项（已导入的不算：它们是「不用导」，不是「导不了」）。 */
export function unconvertibleSkips(report: ImportScanReport): ImportSkipItem[] {
  return report.skipped.filter((skip) => skip.reason !== "already-imported");
}

export type SessionFactKind = "hidden" | "greeting" | "fallback" | "orphaned" | "already" | "cannot";

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
 * 事实条。顺序即显示顺序：先是影响这次导入的（被筛掉的、要换模型打开的、单列的子会话），
 * 后是列表之外的（已导入的、导不了的）。数是 0 的不出现。
 */
export function sessionFacts(
  report: ImportScanReport,
  grouped: GroupedSessions,
  fallback: ImportSummary["fallback"] | null,
  now: number,
): SessionFact[] {
  const facts: SessionFact[] = [];
  if (grouped.hidden > 0) {
    facts.push({
      kind: "hidden",
      count: grouped.hidden,
      label: "hidden",
      tip: "Hidden by the filters · only listed sessions are imported",
    });
  }
  if (grouped.leftOut > 0) {
    facts.push({
      kind: "greeting",
      count: grouped.leftOut,
      label: "only said hi",
      tip: 'Only a greeting or a test like "hi" or "test", never continued · left out of this import',
    });
  }
  if (fallback !== null && fallback.count > 0) {
    const models = fallback.models.slice(0, FALLBACK_MODELS_SHOWN);
    const named =
      models.length === 0 ? "" : ` (${models.join(", ")}${fallback.models.length > models.length ? ", …" : ""})`;
    facts.push({
      kind: "fallback",
      count: fallback.count,
      label: `open on ${fallback.fallbackModel ?? "the default model"}`,
      tip: `${fallback.count} of the ticked sessions ran models you haven't set up here${named} · they open on ${fallback.fallbackModel ?? "the default model"} and keep a record of the original`,
    });
  }
  if (report.orphanedSubSessions > 0) {
    facts.push({
      kind: "orphaned",
      count: report.orphanedSubSessions,
      label: "listed on their own",
      tip: "Sub-sessions whose parent can't be imported · they come in as sessions of their own",
    });
  }
  const already = report.skipped.length - unconvertibleSkips(report).length;
  if (already > 0) {
    facts.push({
      kind: "already",
      count: already,
      label: "already imported",
      tip: `Already imported and unchanged since · not listed${report.lastImportAt === null ? "" : ` · last import ${formatMoment(report.lastImportAt, now)}`}`,
    });
  }
  const cannot = unconvertibleSkips(report).length + report.withoutPiSession;
  if (cannot > 0) {
    facts.push({
      kind: "cannot",
      count: cannot,
      label: "can't import",
      tip: "An older format with no transcript, or a file that's missing or unreadable",
    });
  }
  return facts;
}

// ---------------------------------------------------------------------------
// 底栏
// ---------------------------------------------------------------------------

/** 「3 sessions」「1 skill」；数量为 0 返回 null，给 joined 滤掉 */
export function counted(count: number, one: string, many: string): string | null {
  return count > 0 ? `${count} ${count === 1 ? one : many}` : null;
}

export function joined(parts: readonly (string | null)[], separator = " · "): string {
  return parts.filter((part): part is string => part !== null).join(separator);
}

/** 底栏主句：「Import 3 sessions · 5 skills · update 1 session」；只有追加时「Update 1 session」。 */
export function headline(sessions: number, updates: number, skills: number, mcp: number): string {
  const imports = joined([
    counted(sessions, "session", "sessions"),
    counted(skills, "skill", "skills"),
    counted(mcp, "MCP server", "MCP servers"),
  ]);
  const update = counted(updates, "session", "sessions");
  if (imports === "") return update === null ? "Nothing ticked" : `Update ${update}`;
  return update === null ? `Import ${imports}` : `Import ${imports} · update ${update}`;
}

/** 执行中的主句：「Importing 3 sessions, 5 skills…」 */
export function runningHeadline(sessions: number, skills: number, mcp: number): string {
  return `Importing ${joined(
    [counted(sessions, "session", "sessions"), counted(skills, "skill", "skills"), counted(mcp, "MCP server", "MCP servers")],
    ", ",
  )}…`;
}

export type FootFactKind = "sub" | "workspaces" | "bytes" | "skills" | "mcp";

/** 底栏副行的一项：图标 + 短事实常驻，整句进悬停。 */
export interface FootFact {
  kind: FootFactKind;
  text: string;
  tip: string;
}

/** 导入前的副行：跟着来的子会话、要新建的工作区、要复制的体量、skill 的方式、MCP 停用。 */
export function footFacts(summary: ImportSummary, skills: number, skillMode: ImportSkillMode, mcp: number): FootFact[] {
  const facts: FootFact[] = [];
  if (summary.subSessions > 0) {
    facts.push({
      kind: "sub",
      text: `${summary.subSessions}`,
      tip:
        summary.subSessions === 1
          ? "1 sub-session comes with its parent"
          : `${summary.subSessions} sub-sessions come with their parents`,
    });
  }
  if (summary.newWorkspaces > 0) {
    facts.push({
      kind: "workspaces",
      text: counted(summary.newWorkspaces, "new workspace", "new workspaces") ?? "",
      tip: "Folders that aren't a workspace here yet become new workspaces",
    });
  }
  if (summary.sessions + summary.updates > 0) {
    facts.push({
      kind: "bytes",
      text: formatBytes(summary.bytes),
      tip: "About this much is copied into orbita · the source files stay untouched",
    });
  }
  if (skills > 0) {
    facts.push(
      skillMode === "copy"
        ? {
            kind: "skills",
            text: "skills copied",
            tip: "Copied into orbita · they keep working if the other app is removed · later edits there don't carry over",
          }
        : {
            kind: "skills",
            text: "skills linked",
            tip: "Linked to the other app's folder · edits there show up here · removing the app breaks them",
          },
    );
  }
  if (mcp > 0) {
    facts.push({
      kind: "mcp",
      text: "MCP off",
      tip: "MCP servers are added switched off · turn each on in MCP servers when you need it",
    });
  }
  return facts;
}

/**
 * 完成态主句：「Imported 34 sessions · 5 skills · 1 MCP server (off) · updated 1 session · 1 new workspace」。
 * 只有追加时「Updated 1 session」；什么都没落进来（全失败）时「Nothing imported」。
 */
export function doneHeadline(result: ImportRunReport): string {
  const imports = joined([
    counted(result.imported, "session", "sessions"),
    counted(result.skillsImported, "skill", "skills"),
    result.mcpImported > 0 ? `${counted(result.mcpImported, "MCP server", "MCP servers") ?? ""} (off)` : null,
  ]);
  const update = counted(result.updated, "session", "sessions");
  const main =
    imports === ""
      ? update === null
        ? "Nothing imported"
        : `Updated ${update}`
      : `Imported ${imports}${update === null ? "" : ` · updated ${update}`}`;
  return joined([main, counted(result.createdWorkspaces.length, "new workspace", "new workspaces")]);
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
export function doneFacts(result: ImportRunReport): DoneFact[] {
  const facts: DoneFact[] = [];
  if (result.imported + result.updated > 0) {
    facts.push({
      kind: "sidebar",
      text: "In the sidebar now",
      tip: "Imported sessions are in the sidebar · anything still listed wasn't ticked",
    });
  }
  const first = result.failed[0];
  if (first !== undefined) {
    facts.push({
      kind: "failed",
      text: `${result.failed.length} ${result.failed.length === 1 ? "session" : "sessions"} failed`,
      tip: `${first.error ?? "Unknown error"} · import again to retry`,
    });
  }
  const skill = result.skillsFailed[0];
  if (skill !== undefined) {
    facts.push({
      kind: "failed",
      text: `${result.skillsFailed.length} ${result.skillsFailed.length === 1 ? "skill" : "skills"} didn't come over`,
      tip: `${skill.slug}: ${skill.error}`,
    });
  }
  const mcp = result.mcpFailed[0];
  if (mcp !== undefined) {
    facts.push({
      kind: "failed",
      text: `${result.mcpFailed.length} MCP ${result.mcpFailed.length === 1 ? "server" : "servers"} didn't come over`,
      tip: `${mcp.name}: ${mcp.error}`,
    });
  }
  return facts;
}
