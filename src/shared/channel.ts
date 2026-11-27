/**
 * 父子会话的通道契约 —— IPC 四层的第 1 层（子会话 2026-09-23 裁决）。
 *
 * **通道是真源，两边是投影。**一对父子（parentId, childId）之间的全部往来存成一份
 * 独立的账本 `channels/<parentId>/<childId>.jsonl`（只追加）；父与子各自的 transcript 里
 * 只落一条指向通道消息的标记（`ChannelMarkRecord`，见 session.ts），复盘只看通道，
 * 不在两条流里对时间。模型侧另有一份：投递时通道消息作为内部消息喂进目标会话的
 * pi 本子——那是模型看到的，不是用户看到的。
 *
 * 通道装两边**明确发出**的消息，以及主进程确认一轮已经失败 / 中断后落的 system 终局。
 * 普通工具进度不自动遥测：progress 仍是子会话自己选择报的，不是每次工具调用记一笔。
 */

import { isReplyLang, type ReplyLang } from "./reply-language.ts";

export type ChannelSide = "parent" | "child";

/**
 * 消息类型。谁能发什么由 `allowedKinds` 定：
 *   parent → task（派出时的任务说明，通道的第一条）、reply（回信 / 追加指令）、
 *     stop（用户终止这个子会话——**只能由用户发起**，见 parseChannelMessage 的作者约束）
 *   child  → question（等父答）、progress（报进度）、done（完成回报）、failed（无法完成）
 *   child（仅系统作者）→ interrupted（轮异常中断；模型工具不能伪造这一类）
 */
export type ChannelMessageKind =
  | "task"
  | "reply"
  | "stop"
  | "question"
  | "progress"
  | "done"
  | "failed"
  | "interrupted";

export const CHANNEL_MESSAGE_KINDS: readonly ChannelMessageKind[] = [
  "task",
  "reply",
  "stop",
  "question",
  "progress",
  "done",
  "failed",
  "interrupted",
];

export function allowedKinds(from: ChannelSide): readonly ChannelMessageKind[] {
  return from === "parent" ? ["task", "reply", "stop"] : ["question", "progress", "done", "failed", "interrupted"];
}

/**
 * 投递方式（Q2 / Q2' 裁决，非对称）：
 *   子 → 父恒 followUp：进父的 renderer 队列，父空闲立即开一轮，父在跑等它这轮结束——
 *     父是用户在看的主线，不该被子打断。
 *   父 → 子默认 steer：子在跑时在下一个工具调用边界注入、不断轮（pi 原生 steer）；
 *     子空闲时退化为普通开轮。用户可改成 followUp。
 */
export type ChannelDelivery = "steer" | "followUp";

/** 系统收尾的机器原因；正文仍保留厂商原文，界面按这个字段给一句可读的分类。 */
export const CHANNEL_END_CAUSES = [
  "completed",
  "model",
  "quota",
  "refusal",
  "network",
  "app-exit",
  "process-exit",
  "aborted",
  "incomplete",
] as const;
export type ChannelEndCause = (typeof CHANNEL_END_CAUSES)[number];

export function isChannelEndCause(value: unknown): value is ChannelEndCause {
  return typeof value === "string" && (CHANNEL_END_CAUSES as readonly string[]).includes(value);
}

export interface ChannelMessage {
  id: string;
  from: ChannelSide;
  /**
   * model = 该侧的模型经工具发的；user = 用户在通道里代父发的（只在 parent 侧出现）；
   * system = 主进程确认一轮已经失败 / 中断后落的收尾（只在 child 侧出现）。
   * user 与 model 的区分只在通道 UI 上用最轻的方式表达（`· you`）。
   */
  author: "model" | "user" | "system";
  kind: ChannelMessageKind;
  text: string;
  delivery: ChannelDelivery;
  createdAt: number;
  /** 仅 system 的 done / failed / interrupted 可带：结束原因的机器分类。 */
  endCause?: ChannelEndCause;
  /**
   * 用户的语言（只有父→子的消息带）：派出 / 回信时由主会话那边按「用户亲手打的字」算好，
   * 随信封送进子会话。子会话收到的每条消息都是信封，没有任何用户亲手打的字，
   * 靠它才知道该用什么语言写可见文字与汇报（shared/reply-language.ts 的说明）。
   * 缺席 = 没算出来 / 旧账本：信封不带属性，子会话退回规则段的默认行为。
   */
  lang?: ReplyLang;
}

/** 一条通道的键：属于那一对父子。fork 父会话不拷贝通道（新会话没有那个子）。 */
export interface ChannelKey {
  parentId: string;
  childId: string;
}

/**
 * 通道状态（纯派生，不落盘）：
 *   waiting = 最后一条是子的 question 且父还没 reply —— 用户此刻唯一需要动手的
 *   done / failed / interrupted = 子交回、失败，或主进程确认轮已中断，且父还没回信——
 *     通道 closed，可 reopen：用户在通道里 reopen 后代父回信（一条 reply）就翻回 running，
 *     不是永久终态（见 `channelStatus` 的 reopen 语义）
 *   stopped = **用户**终止了这个子会话（通道里一条 parent 侧的 stop）。比 closed
 *     更硬：父模型的 reply 不能重开它（重开等于父模型把用户的裁决绕了过去——
 *     越界），只有用户在通道里代父发言（author 为 user 的 reply）才翻回 running。
 *     发信侧的硬拦在 `applyChannelSend`（主进程），这里的派生只管如实反映账本
 *   running = 其余
 */
export type ChannelStatus = "running" | "waiting" | "done" | "failed" | "interrupted" | "stopped";

export type ChannelTerminalKind = "done" | "failed" | "interrupted";

export interface ChannelEndInfo {
  messageId: string;
  kind: ChannelTerminalKind;
  text: string;
  endCause?: ChannelEndCause;
}

/** 通道列表项：主进程按父会话现算，renderer 画通道列与右栏 Sub-sessions 面板的列表层 */
export interface ChannelSummary extends ChannelKey {
  childTitle: string;
  status: ChannelStatus;
  messageCount: number;
  /** 最后一条消息的时间；通道列按它倒序 */
  lastAt: number;
  /** done / failed / interrupted 时对应的终局消息，派出卡不用读整份账本也能显示原因。 */
  end?: ChannelEndInfo;
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
  const author = value["author"] === "user" ? "user" : value["author"] === "system" ? "system" : "model";
  if (author === "user" && from !== "parent") return null;
  if (author === "system") {
    // 系统收尾只能落在子侧；模型 / 用户都不能借手改账本伪装主进程。
    if (from !== "child" || !["done", "failed", "interrupted"].includes(kind)) return null;
  } else {
    if (!allowedKinds(from).includes(kind)) return null;
    if (kind === "interrupted") return null;
  }
  // stop 只能是用户发起的（channel:stop IPC）——model / system 作者的 stop 只能来自手改文件，
  // 静默接受它等于允许账本伪造「用户终止过」。
  if (kind === "stop" && author !== "user") return null;
  const delivery = value["delivery"] === "steer" ? "steer" : "followUp";
  const endCause = isChannelEndCause(value["endCause"]) ? value["endCause"] : undefined;
  if (endCause !== undefined && author !== "system") return null;
  // lang 只有父→子的消息有意义；不认识的值（手改文件 / 将来的新语言）当缺席，不拒整行
  const lang = from === "parent" && isReplyLang(value["lang"]) ? value["lang"] : undefined;
  return {
    id,
    from,
    author,
    kind,
    text,
    delivery,
    createdAt,
    ...(endCause === undefined ? {} : { endCause }),
    ...(lang === undefined ? {} : { lang }),
  };
}

/** 按时间正序（同一毫秒按账本顺序，sort 稳定）。通道是对话，不是活跃倒序。 */
export function sortChannelMessages(messages: readonly ChannelMessage[]): ChannelMessage[] {
  return [...messages].sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * 从消息序列派生状态。done / failed / interrupted 是「closed，可 reopen」——不是永久终态：
 * 用户 reopen 后代父回信是一条 `reply`，之后的推导照常继续（question → waiting、
 * 再来一条 done → done）。**只有 `reply` 能重开**：终局之后子自己又发的
 * progress / question（没有经过父的 reopen）不重开——通道列该继续显示 closed，
 * 不能因为子多嘴一句就悄悄又变回「等你处理」。
 *
 * stopped 单独一档（用户裁决）：**只有 author 为 user 的父侧 reply 能重开**——
 * 父模型的 reply 不行（否则父模型一回信就把用户的终止绕了过去），子后续的
 * progress / question / done / failed / interrupted 也不行（通道已经关了，发信侧在
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
    // 用户终止（done / failed / interrupted 之后同样适用：用户停掉一个已 closed 的通道，
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
    // reopen 的情况下出现）不改变状态——done / failed / interrupted 只认 reply 一种解法。
    if (status === "done" || status === "failed" || status === "interrupted") continue;
    if (message.kind === "done" || message.kind === "failed" || message.kind === "interrupted") {
      status = message.kind;
    } else if (message.kind === "question") status = "waiting";
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
  const status = channelStatus(sorted);
  const endMessage =
    status === "done" || status === "failed" || status === "interrupted"
      ? [...sorted].reverse().find((message) => message.from === "child" && message.kind === status)
      : undefined;
  return {
    ...key,
    childTitle,
    status,
    messageCount: sorted.length,
    lastAt: last === undefined ? 0 : last.createdAt,
    hasExchange: hasExchange(sorted),
    ...(endMessage === undefined
      ? {}
      : {
          end: {
            messageId: endMessage.id,
            kind: endMessage.kind as ChannelTerminalKind,
            text: endMessage.text,
            ...(endMessage.endCause === undefined ? {} : { endCause: endMessage.endCause }),
          },
        }),
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

/** 信封结束后的说明行：解析批量信封时也用它定位**外层** `</channel>`。 */
function channelPromptNotice(from: ChannelSide, peer: { id: string; title: string }): string {
  return from === "parent"
    ? "This message came from your parent session through the sub-session channel. Report back with report_to_parent (kind: question / progress / done / failed); text in your normal reply is not delivered to the parent."
    : `This message came from your sub-session "${peer.title}" (id ${peer.id}) through its channel. To answer, call reply_subsession with that id; text in your normal reply is not delivered to the sub-session, so do not pretend to answer it here.`;
}

/**
 * 把一条通道消息包成投给模型看的信封。`peer` 是**接收方眼里的「对面」**：
 * 投给子时 peer 是父，投给父时 peer 是子——不是消息的 `from`（消息发送方）。
 * workbench 有值时放在正文前：首条任务即使之后被压缩，后续 reply / 回报也会重新带路径。
 */
export function composeChannelPrompt(
  message: ChannelMessage,
  peer: { id: string; title: string; workbench?: string },
): string {
  const title = cleanEnvelopeTitle(peer.title);
  const workbench =
    peer.workbench === undefined
      ? []
      : [`${message.from === "parent" ? "Parent session" : "Sub-session"} workbench: ${peer.workbench}`];
  const notice = channelPromptNotice(message.from, { id: peer.id, title });
  // lang 属性放在首行末尾：parseChannelPrompt 的前缀锚点不受影响，旧信封没有它照常解析
  const lang = message.lang === undefined ? "" : ` lang="${message.lang}"`;
  return [
    `<channel from="${message.from}" kind="${message.kind}" peer="${peer.id}" message="${message.id}" title="${title}"${lang}>`,
    ...workbench,
    message.text,
    "</channel>",
    notice,
  ].join("\n");
}

/**
 * 用户在收件箱里「代父会话回复」过的话——父模型自己的上下文里没有（代父发言不进父的
 * pi 本子，见 main/channel/requests.ts 的 applySpeak），父模型下次收到这个子会话的
 * 回报时会以为子会话在自说自话（2026-10-12 实测：父模型指控子会话「自己编了答案」）。
 *
 * 取「这条子→父消息之前、上一条子→父消息之后」用户代父发出的 reply，按时间顺序。
 * 纯函数，renderer 投递子→父消息时调用，把结果拼进信封后的说明里。
 */
export function userRepliesSincePreviousReport(
  messages: readonly ChannelMessage[],
  reportId: string,
): ChannelMessage[] {
  const sorted = sortChannelMessages(messages);
  const at = sorted.findIndex((message) => message.id === reportId);
  if (at === -1) return [];
  const out: ChannelMessage[] = [];
  for (let i = at - 1; i >= 0; i -= 1) {
    const message = sorted[i];
    if (message === undefined || message.from === "child") break;
    if (message.author === "user" && message.kind === "reply") out.unshift(message);
  }
  return out;
}

/** 拼在子→父信封后面的一段：用户代你回复过这个子会话的话（模型读得懂，界面不显示） */
export function userRepliesNote(replies: readonly ChannelMessage[]): string {
  if (replies.length === 0) return "";
  return [
    "Before this report, the user answered this sub-session directly on your behalf (you did not send these; they are not in your context):",
    ...replies.map((reply) => `- "${reply.text}"`),
    "Treat them as the user's decisions, not as something the sub-session made up.",
  ].join("\n");
}

/**
 * 合并信封：几个子会话的回报凑成**一条**用户消息投给父模型（「现在讨论」/ 积压合并）。
 * 每条回报仍是 `composeChannelPrompt` 的原样信封，模型看到的格式不变；
 * 用户代父回复过的话（`userRepliesNote`）紧跟在它所属那条信封后面。
 * 信封之间空一行——`parseChannelBatch` 靠「空行 + 信封首行」切段。
 * 只有一条时与单条投递逐字相同（不多不少），旧路径不受影响。
 */
export function composeChannelBatchPrompt(
  entries: readonly { message: ChannelMessage; peer: { id: string; title: string; workbench?: string }; note?: string }[],
): string {
  return entries
    .map(({ message, peer, note }) => {
      const envelope = composeChannelPrompt(message, peer);
      return note === undefined || note === "" ? envelope : `${envelope}\n${note}`;
    })
    .join("\n\n");
}

/**
 * 合并信封里每条信封的首行属性，按出现顺序。
 *
 * **不按正文里的 `\n\n<channel` 切**：那会把子会话汇报 Orbita 通道实现时贴出的伪信封
 * 当成新标记。这里沿 compose 产生的真实结构走：外层首行 → 与 peer/title 对应的
 * `</channel> + 说明行` → 空行 → 下一条外层首行。正文里即使嵌了一整段假信封，
 * 它的说明行指向另一个 peer，不会被当成外层边界。
 */
export function parseChannelBatch(
  text: string,
): NonNullable<ReturnType<typeof parseChannelPrompt>>[] {
  const out: NonNullable<ReturnType<typeof parseChannelPrompt>>[] = [];
  let rest = text;
  while (rest !== "") {
    const parsed = parseChannelPrompt(rest);
    if (parsed === null) return out.length === 0 ? [] : out;
    out.push(parsed);
    const firstLine = rest.split("\n")[0] ?? "";
    const title = / title="([^"]*)">$/.exec(firstLine)?.[1] ?? "Untitled";
    const notice = channelPromptNotice(parsed.from, { id: parsed.peerId, title });
    const boundary = `\n</channel>\n${notice}`;
    const at = rest.indexOf(boundary);
    // 单条旧信封保持 parseChannelPrompt 的兼容；没有下一条可认时到此为止
    if (at === -1) return out;
    const after = at + boundary.length;
    if (rest.slice(after, after + 2) === "\n\n") {
      rest = rest.slice(after + 2);
      continue;
    }
    // 代父回复 note 跟在外层说明之后、下一条信封之前（composeChannelBatchPrompt 的结构）。
    // 它不属于子会话正文；只跨过这一段，仍不回退到全文搜 `<channel`。
    const separator = rest.indexOf("\n\n", after);
    if (separator === -1 || !rest.startsWith("<channel ", separator + 2)) return out;
    rest = rest.slice(separator + 2);
  }
  return out;
}

/** 信封首行的属性顺序固定（from / kind / peer / message），锚定在字符串开头——只认首行。 */
const CHANNEL_PROMPT_HEADER =
  /^<channel from="(parent|child)" kind="([a-z]+)" peer="([^"]+)" message="([^"]+)"/;

/** 首行末尾的 lang 属性；title 里的引号已被 cleanEnvelopeTitle 换掉，不会伪造出这一段 */
const CHANNEL_PROMPT_LANG = / lang="([a-z]+)">$/;

/**
 * 解出信封的首行属性。**只看首行**——正文（message.text）或首行之外的地方
 * 出现类似信封的文本都不算。kind 必须是 `isChannelMessageKind` 认识的值，
 * 且与 `from` 方向匹配（`allowedKinds`），否则 null——这两条只可能来自手改
 * 文件或工具描述被无视，不该被静默接受。
 */
export function parseChannelPrompt(
  text: string,
): { from: ChannelSide; kind: ChannelMessageKind; peerId: string; messageId: string; lang?: ReplyLang } | null {
  const firstLine = text.split("\n")[0] ?? "";
  const match = CHANNEL_PROMPT_HEADER.exec(firstLine);
  if (match === null) return null;
  const [, from, kind, peerId, messageId] = match;
  if (from === undefined || peerId === undefined || messageId === undefined) return null;
  if (!isChannelMessageKind(kind)) return null;
  if (!allowedKinds(from as ChannelSide).includes(kind)) return null;
  const langMatch = CHANNEL_PROMPT_LANG.exec(firstLine);
  const lang = langMatch?.[1];
  return {
    from: from as ChannelSide,
    kind,
    peerId,
    messageId,
    ...(isReplyLang(lang) ? { lang } : {}),
  };
}

/**
 * delegate 的可选参数 planStep（状态卡把子会话挂到计划的哪一步）：模型写 **update_plan 里那一步的文字**。
 * 不用步骤 id——id 是系统按文字对齐算出来的（shared/plan-diff.ts），模型手里没有；文字是它自己写的。
 * 参数随工具调用的 input 落在转录里（不经主进程、不进 details），agent 执行时与 renderer 读取时
 * 用同一份解析：非字符串 / 空白 = 没写（null），折叠换行，超长截断（只用来对文字，不需要整段）。
 */
export const DELEGATE_PLAN_STEP_MAX_CHARS = 200;

export function parseDelegatePlanStep(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const raw = (input as Record<string, unknown>)["planStep"];
  if (typeof raw !== "string") return null;
  const text = raw.replace(/\s+/g, " ").trim();
  if (text === "") return null;
  return text.length > DELEGATE_PLAN_STEP_MAX_CHARS ? text.slice(0, DELEGATE_PLAN_STEP_MAX_CHARS) : text;
}
