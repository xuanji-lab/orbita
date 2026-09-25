/**
 * 父子会话面板（通道列，子会话 PR4b）的纯函数：哪些通道显示、消息 who 行的文案与
 * 语气、面板放在哪（内联一列还是右栏槽）。组件不测（仓库 renderer 组件无测试框架
 * 先例），逻辑抽出来落在这里测。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载——值导入必须走相对路径带
 * `.ts` 后缀（AGENTS.md 硬规则，先例 `stats-format.ts:13`）；只用类型的 `import type`
 * 走 `@shared/...` 别名即可。
 */
import type { ChannelMessage, ChannelSummary } from "@shared/channel";
import { clampChannelColumnWidth, clampRightPanelWidth } from "../../../../shared/settings.ts";
import type { Messages } from "../../messages-en.ts";
import type { RightPanelKind } from "../../shell/RightRail.tsx";

/** 通道列一行的显示规则：`defaultCollapsed` 没有用户手动切换过时的初始折叠态。 */
export interface ChannelColumnEntry {
  summary: ChannelSummary;
  /**
   * 默认折叠：只派出、还没说过话的通道折叠成一行头部（标题 + 状态），不占用
   * 垂直空间——用户展开后是空态 + Speak as parent composer，是「插嘴」的入口，
   * 不是自动占位。有往来的通道默认展开，正文才是用户真正要看的东西。
   */
  defaultCollapsed: boolean;
}

export interface ChannelColumnRule {
  entries: ChannelColumnEntry[];
  /**
   * 整列该不该自动出现（App 拿它做「没有显式选择时」的默认显隐输入）。**只有
   * 有往来的通道能触发**——用户裁决原话：「子会话和父会话的通信应该始于子会话
   * 对父会话有提问需求的时候」。只派出还没说话的子会话不该替用户弹出一整列，
   * 那只是「领了任务」，不是「需要你看」。
   */
  autoShow: boolean;
}

/**
 * 通道列显示哪些通道、每条的默认折叠态、整列该不该自动出现（用户 2026-09-23
 * 裁决，取代旧的「有 task 之外往来才出现」单一规则）：
 *   - 有往来（`hasExchange`）的通道：显示，默认展开。
 *   - 只派出、子还在跑但没说过话的通道：显示，但默认折叠成一行头部——用户可以
 *     手动展开代父插嘴，不自动占位、不自动触发整列出现。
 *
 * 按 `lastAt` 倒序：最近有动静的通道排在最上面。
 *
 * **否决**「hasExchange || status running」：`channelStatus` 对只有 task 的通道
 * 恒返回 "running"（`shared/channel.ts`），那样每条派出都会占位，与「只派出没说话
 * 的不占位」直接矛盾。
 */
export function visibleChannels(
  summaries: ReadonlyMap<string, ChannelSummary>,
  liveRunning: (childId: string) => boolean,
): ChannelColumnRule {
  const entries = [...summaries.values()]
    .filter((summary) => summary.hasExchange || liveRunning(summary.childId))
    .sort((a, b) => b.lastAt - a.lastAt)
    .map((summary) => ({ summary, defaultCollapsed: !summary.hasExchange }));
  return { entries, autoShow: entries.some((entry) => entry.summary.hasExchange) };
}

/**
 * 通道消息列表过滤掉 kind === "task"（用户 2026-09-23 裁决①：任务回到子会话
 * 自己的 session 里渲染成一张完整的任务卡，通道列不再重复显示它——通道从第一条
 * 非 task 消息开始，「通信始于子会话对父会话有提问需求的时候」）。
 */
export function nonTaskMessages(messages: readonly ChannelMessage[]): ChannelMessage[] {
  return messages.filter((message) => message.kind !== "task");
}

/** 子会话流里任务卡正文默认展示的行数——够看清任务在做什么，长任务不占满整个首屏。 */
export const TASK_CARD_PREVIEW_LINES = 12;

/**
 * 任务卡正文的展开 / 折叠取值（纯函数化，组件本身按仓库惯例不测）。`expanded`
 * 为 false 且正文超过预览行数时截断到前 `TASK_CARD_PREVIEW_LINES` 行；`hasMore`
 * 告诉调用方要不要渲染 "Show full task" / "Collapse" 切换按钮（超过预览行数时
 * 展开态也要显示，好让用户收回去）。
 */
export function taskCardBody(text: string, expanded: boolean): { body: string; hasMore: boolean } {
  const lines = text.split("\n");
  const hasMore = lines.length > TASK_CARD_PREVIEW_LINES;
  const body = !expanded && hasMore ? lines.slice(0, TASK_CARD_PREVIEW_LINES).join("\n") : text;
  return { body, hasMore };
}

/**
 * 主槽的硬底线（子会话 PR4c fix，CDP 实测发现的挤压 bug）：`App.tsx` 的 narrow
 * 注释与 `RightPanel.tsx` 的 `clampRightPanelWidth`/`usePaneTotalWidth` 都认这条
 * 线——chat 主区不该被挤到 480px 以下。
 */
export const MIN_CHAT_WIDTH_FOR_INLINE = 480;

/**
 * 「够宽」：chat | 父子会话面板 | 右栏 三栏都放得下（用户 2026-09-25 裁决）。
 *
 * - **够宽**：父子会话面板是 chat 与右栏之间独立的一列，**只有它**能把页面变成
 *   二分屏甚至三分屏；右栏其余入口（Files / Skills / MCP / 辅助对话 / 子会话）照旧
 *   共用一个槽、互相替换。
 * - **不够宽**：父子会话面板不再悬浮（覆盖层压在别的面板上、底下的字漏上来，
 *   2026-09-25 实测），和其它入口一样**住进右栏槽**：点它替换槽里的东西、继承槽宽。
 *
 * **只看窗口，不看此刻开了什么**：右栏的宽度取设置值（按 pane 夹过的），关着也算——
 * 模式因此只随窗口宽、左栏宽、两个宽度设置变化，点开 / 关掉某个面板不会让它翻转，
 * 不会出现「点开父子会话面板进了槽、槽里只剩它于是又够宽、又挪回内联」的自激。
 * 全局窄窗（<960px）一律不够宽；pane 还没量到（<=0）保守当不够宽，不擅自挤主槽。
 */
export function channelPanelWide(input: {
  narrow: boolean;
  /** `.pane` 的实际渲染宽（不受它自己的子级影响，见 `usePaneAndRightPanelWidth`） */
  paneWidth: number;
  /** 右栏宽度**设置**（App 持有的那份，未夹） */
  rightPanelWidth: number;
  /** 父子会话面板内联列的宽度**设置**（未夹） */
  channelWidth: number;
}): boolean {
  if (input.narrow || !(input.paneWidth > 0)) return false;
  const panel = clampRightPanelWidth(input.rightPanelWidth, input.paneWidth);
  const column = clampChannelColumnWidth(input.channelWidth, input.paneWidth - panel);
  return input.paneWidth - panel - column >= MIN_CHAT_WIDTH_FOR_INLINE;
}

/**
 * 内联列拖宽的上限：再宽三栏就放不下，`channelPanelWide` 会翻成「不够宽」——
 * 拖着拖着手里的列消失进槽里。与 `channelPanelWide` 同一套算法、同一个右栏宽，
 * 拖到这个值时那边算出来的 chat 恰好 480。
 */
export function channelInlineMaxWidth(input: { paneWidth: number; rightPanelWidth: number }): number {
  const panel = clampRightPanelWidth(input.rightPanelWidth, input.paneWidth);
  return input.paneWidth - panel - MIN_CHAT_WIDTH_FOR_INLINE;
}

/**
 * 父子会话面板与右栏槽的一次状态改动：`rightPanel` = 槽里放什么（缺席 = 不动），
 * `shown` = 用户对这条母会话内联列显隐的显式选择（缺席 = 不动）。
 */
export interface ChannelPanelChange {
  rightPanel?: RightPanelKind | null;
  shown?: boolean;
}

/**
 * 宽 / 窄模式切换时的调和（纯函数；null = 不用动）：
 *
 * - 够宽时槽里是父子会话面板（窄时放进去的）→ 挪回内联，槽空出来。这一条是电平
 *   触发的——任何时刻够宽都不该让它占槽。
 * - 够宽 → 不够宽，且内联列正显示：槽空着 → 它进槽、继承槽宽；槽里有别的 →
 *   **那个留下**，父子会话面板收起（用户 2026-09-25：你正在右栏里看的东西不会因为
 *   拖了下窗口就被换掉）。`shown` 不动，拖回够宽时它自己回到三栏里的位置。
 *   这一条只在切换那一拍生效：之后用户关掉槽里的面板，不该冒出父子会话面板。
 */
export function reconcileChannelPanel(input: {
  wide: boolean;
  /** 上一拍的模式 */
  wasWide: boolean;
  /** 上一拍内联列是不是正显示着 */
  inlineWasOpen: boolean;
  rightPanel: RightPanelKind | null;
}): ChannelPanelChange | null {
  if (input.wide && input.rightPanel === "channels") return { rightPanel: null, shown: true };
  if (!input.wide && input.wasWide && input.inlineWasOpen && input.rightPanel === null) {
    return { rightPanel: "channels" };
  }
  return null;
}

/**
 * 右图标条上父子会话面板入口的点击。够宽：开关内联列（与槽无关）；不够宽：同其它
 * 入口的互斥语义——不在槽里就替换进去，已在槽里就收起。收起记成显式 `shown: false`：
 * 用户关掉的，拖回够宽时不该自己冒出来。
 */
export function toggleChannelPanel(input: {
  wide: boolean;
  inlineOpen: boolean;
  rightPanel: RightPanelKind | null;
}): ChannelPanelChange {
  if (input.wide) return { shown: !input.inlineOpen };
  return input.rightPanel === "channels" ? { rightPanel: null, shown: false } : { rightPanel: "channels" };
}

/** 点标记定位到某条通道（「打开并看这里」，不是开关）：够宽开内联列，不够宽换进槽。 */
export function revealChannelPanel(wide: boolean): ChannelPanelChange {
  return wide ? { shown: true } : { rightPanel: "channels" };
}

/**
 * 母会话刚派出子会话时自动弹出什么（用户 2026-09-25 裁决：派出后要让人**感知到
 * 子会话在干活**）。调用方只在主槽正看着这条母会话时问。
 *
 * - `openSubSession`：右栏槽打开这条子会话的工作记录（Sub-sessions 面板的会话层）。
 *   只在槽空着、或本来就显示着子会话面板时（一轮里连派几条，停在最新那条）；
 *   槽里是 Files / Skills / MCP / 辅助对话 / 父子会话面板 → 不换，用户正看着它。
 * - `showChannel`：够宽时父子会话面板一起出来，与工作记录并排成三分屏；不够宽时
 *   不出——它只能进槽，会和工作记录抢同一个位置。
 *
 * 这是设计系统「右侧从不自己弹开抢注意力」的有意例外：派出是用户让母会话去做的事，
 * 弹出的是这个请求的结果；上面的「不换正在看的面板」守住了「不抢」那一半。
 */
export function delegateAutoOpen(input: { wide: boolean; rightPanel: RightPanelKind | null }): {
  openSubSession: boolean;
  showChannel: boolean;
} {
  return {
    openSubSession: input.rightPanel === null || input.rightPanel === "subsessions",
    showChannel: input.wide,
  };
}

/** who 行的语气：颜色是第二信号，与 tool-results.ts 的 ChannelMarkTone 同一套判定习惯。 */
export type ChannelWhoTone = "neutral" | "question" | "reply" | "done" | "failed";

export interface ChannelWhoLabel {
  /** kind 文案（reply 带 delivery 后缀），不含 "· you" */
  text: string;
  tone: ChannelWhoTone;
  /** 用户代父发言：who 行追加 " · you"（primary 色，单独渲染，不跟 tone 换色） */
  you: boolean;
}

/**
 * 通道卡消息区 who 行的文案与语气（纯函数）。kind 原样是文案；reply 按 delivery
 * 追加 "· steer" / "· turn end"；只有 question / reply·steer / done / failed 四种
 * 换色（question 暖黄、reply·steer 强调色、done 绿、failed 红）——task / progress /
 * reply·turn end 保持中性 tertiary，没有列进需要用户特别留意的那一档。
 */
export function channelWhoLabel(message: ChannelMessage, t: Messages): ChannelWhoLabel {
  const you = message.author === "user";
  const c = t.channel;
  if (message.kind === "reply") {
    const steer = message.delivery === "steer";
    return { text: steer ? c.whoReplySteer : c.whoReplyTurnEnd, tone: steer ? "reply" : "neutral", you };
  }
  if (message.kind === "question") return { text: c.kinds.question, tone: "question", you };
  if (message.kind === "done") return { text: c.kinds.done, tone: "done", you };
  if (message.kind === "failed") return { text: c.kinds.failed, tone: "failed", you };
  return { text: c.kinds[message.kind], tone: "neutral", you };
}
