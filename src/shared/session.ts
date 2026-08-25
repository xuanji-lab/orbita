/**
 * 会话契约 —— IPC 四层的第 1 层。
 *
 * **界面上叫 task，代码里叫 session**（`docs/ubiquitous-language.md`）——
 * 两边不互相翻译，这里一律 session。
 *
 * 存储形状（理由见 `docs/plans/2026-08-25-会话存储与命名工作区.md`）：
 *   sessions/<id>.meta.json   本文件的 SessionMeta，可变，原子写
 *   sessions/<id>.jsonl       只追加，一行一个 TranscriptItem
 */
import type { TranscriptItem } from "@earendil-works/pi-protocol";
import { PERMISSION_MODES, type PermissionMode } from "./permission.ts";

/** 标题上限。超出截断加省略号——标题要在 288px 的侧栏里一行放得下。 */
export const SESSION_TITLE_MAX = 60;

export interface SessionMeta {
  id: string;
  /** 首条用户消息的第一行。会话标题由 LLM 生成是后续的事（auto-titler） */
  title: string;
  /**
   * 这一单跑在哪儿。**创建时固定、不可改**——pi 的 session 在 `createAgentSession`
   * 时锁定 cwd，所以换目录只能换会话。
   */
  cwd: string;
  providerId: string;
  modelId: string;
  /** 最后一次用的权限档。存下来是为了重开这条会话时不会静默换档。 */
  mode: PermissionMode;
  createdAt: number;
  updatedAt: number;
}

/** 打开一条会话拿到的东西：元数据 + 落盘的 transcript */
export interface SessionDetail {
  meta: SessionMeta;
  transcript: TranscriptItem[];
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
    // 档位不认识就退回最保守的那一档，而不是丢掉整条会话
    mode: isPermissionMode(value["mode"]) ? value["mode"] : "plan",
    createdAt,
    updatedAt: typeof value["updatedAt"] === "number" ? value["updatedAt"] : createdAt,
  };
}
