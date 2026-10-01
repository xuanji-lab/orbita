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
 *   parent → task（派出时的任务说明，通道的第一条）、reply（回信 / 追加指令）、
 *     stop（用户终止这个子会话——**只能由用户发起**，见 parseChannelMessage 的作者约束）
 *   child  → question（等父答）、progress（报进度）、done（完成回报）、failed（无法完成）
 */
export type ChannelMessageKind =
  | "task"
  | "reply"
  | "stop"
  | "question"
  | "progress"
  | "done"
  | "failed";

export const CHANNEL_MESSAGE_KINDS: readonly ChannelMessageKind[] = [
  "task",
  "reply",
  "stop",
  "question",
  "progress",
  "done",
  "failed",
];

export function allowedKinds(from: ChannelSide): readonly ChannelMessageKind[] {
  return from === "parent" ? ["task", "reply", "stop"] : ["question", "progress", "done", "failed"];
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
 *   done / failed = 子发过 done / failed 之后**父还没回过信**——通道 closed，
 *     可 reopen：用户在通道里 reopen 后代父回信（一条 reply）就翻回 running，
 *     不是永久终态（见 `channelStatus` 的 reopen 语义）
 *   stopped = **用户**终止了这个子会话（通道里一条 parent 侧的 stop）。比 closed
 *     更硬：父模型的 reply 不能重开它（重开等于父模型把用户的裁决绕了过去——
 *     越界），只有用户在通道里代父发言（author 为 user 的 reply）才翻回 running。
 *     发信侧的硬拦在 `applyChannelSend`（主进程），这里的派生只管如实反映账本
 *   running = 其余
 */
export type ChannelStatus = "running" | "waiting" | "done" | "failed" | "stopped";

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
  // stop 只能是用户发起的（channel:stop IPC）——model 作者的 stop 只能来自手改文件，
  // 静默接受它等于允许账本伪造「用户终止过」。
  if (kind === "stop" && author !== "user") return null;
  const delivery = value["delivery"] === "steer" ? "steer" : "followUp";
  return { id, from, author, kind, text, delivery, createdAt };
}

/** 按时间正序（同一毫秒按账本顺序，sort 稳定）。通道是对话，不是活跃倒序。 */
export function sortChannelMessages(messages: readonly ChannelMessage[]): ChannelMessage[] {
  return [...messages].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 从消息序列派生状态。done / failed 是「closed，可 reopen」——不是永久终态：
 * 用户 reopen 后代父回信是一条 `reply`，之后的推导照常继续（question → waiting、
 * 再来一条 done → done）。**只有 `reply` 能重开**：done / failed 之后子自己又发的
 * progress / question（没有经过父的 reopen）不重开——通道列该继续显示 closed，
 * 不能因为子多嘴一句就悄悄又变回「等你处理」。
 *
 * stopped 单独一档（用户裁决）：**只有 author 为 user 的父侧 reply 能重开**——
 * 父模型的 reply 不行（否则父模型一回信就把用户的终止绕了过去），子后续的
 * progress / question / done / failed 也不行（通道已经关了，发信侧在
 * `applyChannelSend` 硬拦，这里只管派生不为「不会发生」的组合留缺口）。
 */
export function channelStatus(messages: readonly ChannelMessage[]): ChannelStatus {
  let status: ChannelStatus = "running";
  for (const message of sortChannelMessages(messages)) {
    // stopped 期间只认用户代父的 reply（reopen）；其余一切消息都不改变状态。
    if (status === "stopped") {
      if (message.kind === "reply" && message.from === "parent" && message.author === "user") {
        status = "running";
      }
      continue;
    }
    // 用户终止（done / failed 之后同样适用：用户停掉一个已 closed 的通道，
    // 意图正是封死父模型 reopen 的口子）。
    if (message.kind === "stop") {
      status = "stopped";
      continue;
    }
    // reply 恒重开：不管此刻是不是 closed，父回信了就翻回 running。
    if (message.kind === "reply") {
      status = "running";
      continue;
    }
    // closed 期间，非 reply 的消息（子的 progress / question，理论上不该在没有
    // reopen 的情况下出现）不改变状态——done / failed 只认 reply 一种解法。
    if (status === "done" || status === "failed") continue;
    if (message.kind === "done") status = "done";
    else if (message.kind === "failed") status = "failed";
    else if (message.kind === "question") status = "waiting";
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

/**
 * 投递信封（子会话 2026-09-23 设计修订）：**信封自描述 + recorder 无状态识别**，
 * 取代「SubmitAgentInput.channel + recorder 用 Set 标记下一条 user 消息」——
 * 被否决方案的问题：steer 送达失败或 submit 失败时 Set 里的标记残留，会吞掉
 * 之后一条真正的用户消息；标记写在「落账时刻」而不是「模型看到时刻」，父在跑时
 * 标记会落进上一轮中间。
 *
 * 信封首行带 `from / kind / peer / message` 属性，恰好落在模型真正看到它的
 * 位置——recorder 看到一条 user 的 `item_started`、首个 text 块能被
 * `parseChannelPrompt` 解析，就知道这不是一句用户说的话，改落一条
 * `ChannelMarkRecord`（见 session.ts）。
 */
function cleanEnvelopeTitle(title: string): string {
  const cleaned = title.replace(/"/g, "'").replace(/\r?\n/g, " ").trim();
  return cleaned === "" ? "Untitled" : cleaned;
}

/**
 * 把一条通道消息包成投给模型看的信封。`peer` 是**接收方眼里的「对面」**：
 * 投给子时 peer 是父，投给父时 peer 是子——不是消息的 `from`（消息发送方）。
 */
export function composeChannelPrompt(
  message: ChannelMessage,
  peer: { id: string; title: string },
): string {
  const title = cleanEnvelopeTitle(peer.title);
  const notice =
    message.from === "parent"
      ? "This message came from your parent session through the sub-session channel. Report back with report_to_parent (kind: question / progress / done / failed); text in your normal reply is not delivered to the parent."
      : `This message came from your sub-session "${title}" (id ${peer.id}) through its channel. To answer, call reply_subsession with that id; text in your normal reply is not delivered to the sub-session, so do not pretend to answer it here.`;
  return [
    `<channel from="${message.from}" kind="${message.kind}" peer="${peer.id}" message="${message.id}" title="${title}">`,
    message.text,
    "</channel>",
    notice,
  ].join("\n");
}

/** 信封首行的属性顺序固定（from / kind / peer / message），锚定在字符串开头——只认首行。 */
const CHANNEL_PROMPT_HEADER =
  /^<channel from="(parent|child)" kind="([a-z]+)" peer="([^"]+)" message="([^"]+)"/;

/**
 * 解出信封的首行属性。**只看首行**——正文（message.text）或首行之外的地方
 * 出现类似信封的文本都不算。kind 必须是 `isChannelMessageKind` 认识的值，
 * 且与 `from` 方向匹配（`allowedKinds`），否则 null——这两条只可能来自手改
 * 文件或工具描述被无视，不该被静默接受。
 */
export function parseChannelPrompt(
  text: string,
): { from: ChannelSide; kind: ChannelMessageKind; peerId: string; messageId: string } | null {
  const firstLine = text.split("\n")[0] ?? "";
  const match = CHANNEL_PROMPT_HEADER.exec(firstLine);
  if (match === null) return null;
  const [, from, kind, peerId, messageId] = match;
  if (from === undefined || peerId === undefined || messageId === undefined) return null;
  if (!isChannelMessageKind(kind)) return null;
  if (!allowedKinds(from as ChannelSide).includes(kind)) return null;
  return { from: from as ChannelSide, kind, peerId, messageId };
}
