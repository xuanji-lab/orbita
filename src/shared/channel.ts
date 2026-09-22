/**
 * 父子会话的通道契约 —— IPC 四层的第 1 层（子会话 2026-09-23 裁决）。
 *
 * **通道是真源，两边是投影。**一对父子（parentId, childId）之间的全部往来存成一份
 * 独立的账本 `channels/<parentId>/<childId>.jsonl`（只追加）；父与子各自的 transcript 里
 * 只落一条指向通道消息的标记（`ChannelMarkRecord`，见 session.ts），复盘只看通道，
 * 不在两条流里对时间。模型侧另有一份：投递时通道消息作为内部消息喂进目标会话的
 * pi 本子——那是模型看到的，不是用户看到的。
 *
 * 通道只装两边**明确发出**的消息（模型调工具、用户在通道里代父发言），没有自动遥测：
 * progress 是子会话自己选择报的，不是系统每次工具调用记一笔。
 */

export type ChannelSide = "parent" | "child";

/**
 * 消息类型。谁能发什么由 `allowedKinds` 定：
 *   parent → task（派出时的任务说明，通道的第一条）、reply（回信 / 追加指令）
 *   child  → question（等父答）、progress（报进度）、done（完成回报）、failed（无法完成）
 */
export type ChannelMessageKind = "task" | "reply" | "question" | "progress" | "done" | "failed";

export const CHANNEL_MESSAGE_KINDS: readonly ChannelMessageKind[] = [
  "task",
  "reply",
  "question",
  "progress",
  "done",
  "failed",
];

export function allowedKinds(from: ChannelSide): readonly ChannelMessageKind[] {
  return from === "parent" ? ["task", "reply"] : ["question", "progress", "done", "failed"];
}

/**
 * 投递方式（Q2 / Q2' 裁决，非对称）：
 *   子 → 父恒 followUp：进父的 renderer 队列，父空闲立即开一轮，父在跑等它这轮结束——
 *     父是用户在看的主线，不该被子打断。
 *   父 → 子默认 steer：子在跑时在下一个工具调用边界注入、不断轮（pi 原生 steer）；
 *     子空闲时退化为普通开轮。用户可改成 followUp。
 */
export type ChannelDelivery = "steer" | "followUp";

export interface ChannelMessage {
  id: string;
  from: ChannelSide;
  /**
   * model = 该侧的模型经工具发的；user = 用户在通道里代父发的（只在 parent 侧出现）。
   * 两者都以父的名义进子的队列，作者不同只在通道 UI 上用最轻的方式区分（`· you`）。
   */
  author: "model" | "user";
  kind: ChannelMessageKind;
  text: string;
  delivery: ChannelDelivery;
  createdAt: number;
}

/** 一条通道的键：属于那一对父子。fork 父会话不拷贝通道（新会话没有那个子）。 */
export interface ChannelKey {
  parentId: string;
  childId: string;
}

/**
 * 通道状态（纯派生，不落盘）：
 *   waiting = 最后一条是子的 question 且父还没 reply —— 用户此刻唯一需要动手的
 *   done / failed = 子发过 done / failed
 *   running = 其余
 */
export type ChannelStatus = "running" | "waiting" | "done" | "failed";

/** 通道列表项：主进程按父会话现算，renderer 画通道列与右栏 Sub-sessions 面板的列表层 */
export interface ChannelSummary extends ChannelKey {
  childTitle: string;
  status: ChannelStatus;
  messageCount: number;
  /** 最后一条消息的时间；通道列按它倒序 */
  lastAt: number;
  /**
   * task 之外有没有往来。通道列只显示 true 的：只派出没说话的不占位
   * （派出这件事父流里的派出卡已经说了）。
   */
  hasExchange: boolean;
}

export function isChannelSide(value: unknown): value is ChannelSide {
  return value === "parent" || value === "child";
}

export function isChannelMessageKind(value: unknown): value is ChannelMessageKind {
  return typeof value === "string" && (CHANNEL_MESSAGE_KINDS as readonly string[]).includes(value);
}

/**
 * 解析账本里的一行。坏行返回 null、调用方跳过——与 parseSessionMeta 同一条纪律：
 * 一条编出来的通道消息会让模型以为父说过某句话。
 * kind 与 from 不匹配（比如 child 发 task）也算坏行：它只能来自手改文件。
 */
export function parseChannelMessage(raw: unknown): ChannelMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  const id = typeof value["id"] === "string" && value["id"] !== "" ? value["id"] : null;
  const from = isChannelSide(value["from"]) ? value["from"] : null;
  const kind = isChannelMessageKind(value["kind"]) ? value["kind"] : null;
  const text = typeof value["text"] === "string" ? value["text"] : null;
  const createdAt = typeof value["createdAt"] === "number" ? value["createdAt"] : null;
  if (id === null || from === null || kind === null || text === null || createdAt === null) return null;
  if (!allowedKinds(from).includes(kind)) return null;
  const author = value["author"] === "user" ? "user" : "model";
  if (author === "user" && from !== "parent") return null;
  const delivery = value["delivery"] === "steer" ? "steer" : "followUp";
  return { id, from, author, kind, text, delivery, createdAt };
}

/** 按时间正序（同一毫秒按账本顺序，sort 稳定）。通道是对话，不是活跃倒序。 */
export function sortChannelMessages(messages: readonly ChannelMessage[]): ChannelMessage[] {
  return [...messages].sort((a, b) => a.createdAt - b.createdAt);
}

/** 从消息序列派生状态。done / failed 是终态；之后再来消息也不翻回 running。 */
export function channelStatus(messages: readonly ChannelMessage[]): ChannelStatus {
  let status: ChannelStatus = "running";
  for (const message of sortChannelMessages(messages)) {
    if (message.kind === "done") return "done";
    if (message.kind === "failed") return "failed";
    if (message.kind === "question") status = "waiting";
    else if (message.kind === "reply") status = "running";
  }
  return status;
}

/** task 之外有没有往来 */
export function hasExchange(messages: readonly ChannelMessage[]): boolean {
  return messages.some((message) => message.kind !== "task");
}

export function summarizeChannel(
  key: ChannelKey,
  childTitle: string,
  messages: readonly ChannelMessage[],
): ChannelSummary {
  const sorted = sortChannelMessages(messages);
  const last = sorted[sorted.length - 1];
  return {
    ...key,
    childTitle,
    status: channelStatus(sorted),
    messageCount: sorted.length,
    lastAt: last === undefined ? 0 : last.createdAt,
    hasExchange: hasExchange(sorted),
  };
}
