/**
 * 会话契约 —— IPC 四层的第 1 层。
 *
 * **界面上叫 task，代码里叫 session**（`docs/ubiquitous-language.md`）——
 * 两边不互相翻译，这里一律 session。
 *
 * 存储形状（理由见 `docs/plans/2026-08-25-会话存储与命名工作区.md`）：
 *   sessions/<id>.meta.json   本文件的 SessionMeta，可变，原子写
 *   sessions/<id>.jsonl       只追加，一行一个 SessionRecord
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { PERMISSION_MODES, type PermissionMode } from "./permission.ts";

/** 标题上限。超出截断加省略号——标题要在 288px 的侧栏里一行放得下。 */
export const SESSION_TITLE_MAX = 60;

/**
 * 压缩边界记录。上下文压缩不是一条消息，是「此前的一切已折叠成摘要」的界碑——
 * 单独一个 role，不塞进 pi 的 TranscriptItem，也不做通用 visibility 包装：
 * 今天唯一的内部记录就是它，等第二个消费者出现再泛化（加字段是加法）。
 */
export interface CompactedRecord {
  role: "compacted";
  id: string;
  /** 压缩生成的摘要全文（markdown） */
  summary: string;
  /** 压缩前上下文的 token 数，折叠行上给人看 */
  tokensBefore: number;
  timestamp: number;
}

/** 日志与视图里的一条记录：往来消息（pi 的 TranscriptItem）或压缩界碑（我们的）。 */
export type SessionRecord = TranscriptItem | CompactedRecord;

/**
 * 逐字段校验，坏值判 false。readLog 靠它分流：**坏掉的 compacted 行按坏行跳过**，
 * 绝不把半截界碑当消息渲染——用户会把摘要残渣当成 agent 说过的话。
 */
export function isCompactedRecord(raw: unknown): raw is CompactedRecord {
  if (typeof raw !== "object" || raw === null) return false;
  const value = raw as Record<string, unknown>;
  return (
    value["role"] === "compacted" &&
    typeof value["id"] === "string" &&
    typeof value["summary"] === "string" &&
    typeof value["tokensBefore"] === "number" &&
    typeof value["timestamp"] === "number"
  );
}

export interface SessionMeta {
  id: string;
  /** 首条用户消息的第一行。会话标题由 LLM 生成是后续的事（auto-titler） */
  title: string;
  /**
   * 这一单跑在哪儿。**创建时固定、不可改**——pi 的 session 在 `createAgentSession`
   * 时锁定 cwd，所以换目录只能换会话。
   */
  cwd: string;
  /**
   * 属于哪个工作区；**null = 不属于任何工作区**（侧栏 TASKS 节点下那些）。
   * 按**工作区 id** 而不是按 cwd 归属：用户挪个文件夹或改个名，会话不该成孤儿。
   */
  workspaceId: string | null;
  providerId: string;
  modelId: string;
  /** 最后一次用的权限档。存下来是为了重开这条会话时不会静默换档。 */
  mode: PermissionMode;
  /**
   * pi 自己那份 session 文件的路径；**null = 这条会话只能读不能续**。
   *
   * 续会话不是我们把历史重讲一遍，而是把 pi 自己的本子还给它
   * （`SessionManager.open`）——理由与被否决的方案见 guideline §四。
   * 本字段落地之前存的会话、或 pi 那份被删了的，都是 null。
   */
  piSessionFile: string | null;
  /** 置顶。列表里排在最前，与 updatedAt 无关 */
  pinned: boolean;
  /** 归档。从主列表里移走，收进侧栏底部的 Archived——**不是删除** */
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 打开一条会话拿到的东西：元数据 + 落盘的 transcript */
export interface SessionDetail {
  meta: SessionMeta;
  transcript: SessionRecord[];
}

/**
 * 从一段用户输入里取标题。**放在 shared 是为了主进程与渲染层用同一条规则**——
 * 主进程落盘时算一次，渲染层给还没落盘的当前会话算一次，两边必须一致，
 * 否则同一条会话在侧栏和标题栏会显示两个名字。
 */
export function deriveSessionTitle(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  if (line === "") return "";
  return line.length > SESSION_TITLE_MAX ? `${line.slice(0, SESSION_TITLE_MAX)}…` : line;
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (PERMISSION_MODES as readonly unknown[]).includes(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * 解析磁盘上的一份 meta。**坏了返回 null，调用方跳过这条**，而不是补一个默认值——
 * 一条 id 是编出来的会话比少列一条更糟：它会指向一个不存在的 transcript，
 * 用户点进去看到空白，还以为记录丢了。
 */
export function parseSessionMeta(raw: unknown): SessionMeta | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = str(value["id"]);
  const cwd = str(value["cwd"]);
  const providerId = str(value["providerId"]);
  const modelId = str(value["modelId"]);
  if (id === null || cwd === null || providerId === null || modelId === null) return null;

  const createdAt = typeof value["createdAt"] === "number" ? value["createdAt"] : null;
  if (createdAt === null) return null;

  return {
    id,
    // 标题可以为空（会话建了但一条消息都没发过），所以它不是必填
    title: typeof value["title"] === "string" ? value["title"] : "",
    cwd,
    providerId,
    modelId,
    // 缺 workspaceId 的是刀 B 之前存的会话：它们不属于任何工作区，落到 TASKS 下
    workspaceId: typeof value["workspaceId"] === "string" ? value["workspaceId"] : null,
    // 缺 piSessionFile 的会话只能读不能续——界面要如实说出来
    piSessionFile: typeof value["piSessionFile"] === "string" ? value["piSessionFile"] : null,
    // 两个开关都**默认关**：老会话不该因为加了字段就突然被置顶或藏起来
    pinned: value["pinned"] === true,
    archived: value["archived"] === true,
    // 档位不认识就退回最保守的那一档，而不是丢掉整条会话
    mode: isPermissionMode(value["mode"]) ? value["mode"] : "plan",
    createdAt,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : createdAt,
  };
}

/**
 * 会话列表的排序：**置顶的在前，其余按最近活动倒序**。
 *
 * 抽成函数是因为它有两个消费者（主进程的 `list()` 与渲染层重排后的列表），
 * 两处排法不一致会让同一条会话在刷新前后跳位置。
 */
export function sortSessions(sessions: readonly SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt - a.updatedAt;
  });
}

/** 机器事实用 ISO 8601 UTC：无歧义、可测、与设计系统「mono for machine facts」一致。 */
function iso(timestamp: number): string {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * transcript → Markdown。**导出与「复制整条对话」共用它**——
 * 两处各写一份的话，导出的和复制的会长得不一样，而用户以为是同一个东西。
 *
 * 思考与工具调用**保留但标出来**：导出是给人看的存档，把过程抹掉就没法追溯了
 * （设计系统：用户需要的是「知道 agent 在干嘛」与可追溯）。
 */
export function transcriptToMarkdown(
  transcript: readonly SessionRecord[],
  meta?: SessionMeta,
): string {
  const parts: string[] = [];
  if (meta !== undefined) {
    parts.push(`# ${meta.title === "" ? "Untitled task" : meta.title}`);
    parts.push(
      [
        `- Folder: \`${meta.cwd}\``,
        `- Model: \`${meta.providerId} / ${meta.modelId}\``,
        `- Permission: \`${meta.mode}\``,
        `- Created: \`${iso(meta.createdAt)}\``,
        `- Updated: \`${iso(meta.updatedAt)}\``,
      ].join("\n"),
    );
    parts.push("---");
  }

  for (const item of transcript) {
    if (isCompactedRecord(item)) {
      // 界碑在导出里同样站得住：标记 + 摘要进引用块，读起来是「此前发生过」而不是对话
      parts.push(`**[已压缩]**（此前上下文约 ${item.tokensBefore.toLocaleString("en-US")} tokens）`);
      parts.push(
        item.summary
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
      continue;
    }
    const body: string[] = [];
    for (const block of item.content) {
      if (block.type === "text") body.push(block.text.trim());
      else if (block.type === "thinking") {
        // 用引用块：读起来是「旁白」，而不是它说出口的话
        body.push(
          block.thinking
            .trim()
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        );
      } else if (block.type === "toolCall") {
        body.push(`\`\`\`json\n${JSON.stringify({ tool: block.toolName, input: block.input }, null, 2)}\n\`\`\``);
      }
    }
    if (body.length === 0) continue;
    parts.push(`**${item.role === "user" ? "User" : "Assistant"}**`);
    parts.push(body.join("\n\n"));
  }

  return `${parts.join("\n\n")}\n`;
}
