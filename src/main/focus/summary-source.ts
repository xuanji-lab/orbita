/**
 * 专注收工小结的素材归拢——主进程这一侧，纯函数（时间与记录都注入，可直接测）。
 *
 * 用户裁决的口径：素材 = **专注时段内有活动的所有会话**（不只所选工作区，含辅助
 * 对话与子会话）的流水——用户的话、助手的回答、工具调用（建 skill、配 MCP、做
 * 摘抄都在流水里）——加上所选工作区此刻的 U / M。读盘与 git 在 ipc.ts，这里只做
 * 挑选、截断与拼装；给模型的指令与回复解析在 agent 进程（src/agent/focus-summary.ts）。
 */
import type { FocusChangeEntry } from "../../shared/focus.ts";
import type { SessionMeta, SessionRecord } from "../../shared/session.ts";

/** 一次小结最多读多少条会话：最近的在前，再早的截掉（提示词装不下，也不该装） */
export const SUMMARY_MAX_SESSIONS = 12;
/** 每条会话最多保留多少行流水：一条长会话不该吃掉整份提示词 */
export const SUMMARY_MAX_LINES = 60;
/** 单行截断：用户话 200 / 助手话 300 / 工具入参 120 字 */

function clip(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= max ? single : `${single.slice(0, max)}……`;
}

function inWindow(timestamp: number, startedAt: number, until: number): boolean {
  return timestamp > startedAt && timestamp <= until;
}

/**
 * 挑时段内有活动的会话：`updatedAt > startedAt`（严格晚于专注开始——开始前的
 * 活动不属于这段专注）。最近的在前，最多 SUMMARY_MAX_SESSIONS 条。
 */
export function pickActiveSessions(
  metas: readonly SessionMeta[],
  startedAt: number,
): SessionMeta[] {
  return metas
    .filter((meta) => meta.updatedAt > startedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, SUMMARY_MAX_SESSIONS);
}

/** content 块里的 text 拼起来（user 消息用） */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join("\n");
}

/**
 * 一条会话的窗口内流水 → 行。只认三类记录：user（原文截短）、assistant（text 与
 * toolCall 块——建 skill / 配 MCP / 摘抄都是 toolCall）、file-turn（轮尾文件账：
 * 本轮写改了哪些文件）。compact / 通道标记 / 回退界碑不是给人看的流水，跳过。
 */
export function extractSessionLines(
  records: readonly SessionRecord[],
  startedAt: number,
  until: number,
): string[] {
  const lines: string[] = [];
  for (const record of records) {
    if (record.role === "user") {
      if (!inWindow(record.timestamp, startedAt, until)) continue;
      const text = clip(textOf(record.content), 200);
      if (text !== "") lines.push(`用户：${text}`);
      continue;
    }
    if (record.role === "assistant") {
      if (!inWindow(record.timestamp, startedAt, until)) continue;
      for (const block of record.content) {
        if (block.type === "text") {
          const text = clip(block.text, 300);
          if (text !== "") lines.push(`助手：${text}`);
        } else if (block.type === "toolCall") {
          const input = clip(JSON.stringify(block.input), 120);
          lines.push(`调用工具 ${block.toolName}${input === "" ? "" : `：${input}`}`);
        }
      }
      continue;
    }
    if (record.role === "file-turn") {
      if (!inWindow(record.timestamp, startedAt, until)) continue;
      const paths = record.changes.map((change) => change.path);
      const head = paths.slice(0, 8).map((path) => path.split("/").pop() ?? path).join("、");
      if (head !== "") {
        lines.push(`写改文件：${head}${paths.length > 8 ? ` 等 ${paths.length} 个` : ""}`);
      }
    }
  }
  return lines.slice(0, SUMMARY_MAX_LINES);
}

/** 素材里的一条会话 */
export interface SummarySessionMaterial {
  title: string;
  workspaceName: string | null;
  lines: readonly string[];
}

export interface SummaryMaterial {
  sessions: readonly SummarySessionMaterial[];
  workspaceName: string | null;
  branch: string | null;
  changeEntries: readonly FocusChangeEntry[];
  /** 会话流水与文件改动都为空 = 没有可总结的事（ipc 回 no-activity） */
  hasActivity: boolean;
}

/**
 * 归拢：会话（窗口内抽出的行非空才算数——改个标题那种「活动」出不了行）+
 * 工作区 U / M。workspaceNames 由调用方按 id 解好传进来（这里不碰 store）。
 */
export function buildSummaryMaterial(
  inputs: readonly { meta: SessionMeta; records: readonly SessionRecord[] }[],
  opts: {
    workspaceNames: ReadonlyMap<string, string>;
    workspaceName: string | null;
    branch: string | null;
    changeEntries: readonly FocusChangeEntry[];
    startedAt: number;
    until: number;
  },
): SummaryMaterial {
  const sessions: SummarySessionMaterial[] = [];
  for (const { meta, records } of inputs) {
    const lines = extractSessionLines(records, opts.startedAt, opts.until);
    if (lines.length === 0) continue;
    sessions.push({
      title: meta.title === "" ? "（未命名任务）" : meta.title,
      workspaceName: meta.workspaceId === null ? null : opts.workspaceNames.get(meta.workspaceId) ?? null,
      lines,
    });
  }
  return {
    sessions,
    workspaceName: opts.workspaceName,
    branch: opts.branch,
    changeEntries: opts.changeEntries,
    hasActivity: sessions.length > 0 || opts.changeEntries.length > 0,
  };
}

function clockOf(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * 素材 → 给模型的正文。段落：时段与工作区头、各会话流水、工作区改动清单。
 * 改动行带 U / M 与行数（模型点名用），路径取仓库相对路径的尾两段更容易对上号。
 */
export function buildSummaryPrompt(material: SummaryMaterial, startedAt: number, until: number): string {
  const minutes = Math.max(1, Math.round((until - startedAt) / 60_000));
  const head = [
    `专注时段：${clockOf(startedAt)} 到 ${clockOf(until)}（约 ${minutes} 分钟）。`,
    material.workspaceName === null
      ? "（所选工作区已不存在。）"
      : `所选工作区：${material.workspaceName}${material.branch === null ? "" : `（分支 ${material.branch}）`}。`,
    "",
  ];
  const sessionBlocks = material.sessions.map((session) => {
    const where = session.workspaceName === null ? "" : `（工作区 ${session.workspaceName}）`;
    return [`== 会话「${session.title}」${where}==`, ...session.lines, ""].join("\n");
  });
  const changeBlock =
    material.changeEntries.length === 0
      ? ["== 工作区改动 ==", "这段时间工作区没有未提交的改动。", ""]
      : [
          "== 工作区改动（尚未提交；U = 新文件，M = 修改）==",
          ...material.changeEntries.slice(0, 24).map((entry) => {
            const tail = entry.path.split("/").slice(-2).join("/");
            const stat = entry.binary
              ? "（二进制）"
              : `（+${entry.added}${entry.removed > 0 ? ` \u2212${entry.removed}` : ""}）`;
            return `${entry.kind} ${tail}${stat}`;
          }),
          ...(material.changeEntries.length > 24
            ? [`……共 ${material.changeEntries.length} 个改动文件。`]
            : []),
          "",
        ];
  return [...head, ...sessionBlocks, ...changeBlock, "请按系统指令整理这段专注时间的小结。"].join("\n");
}
