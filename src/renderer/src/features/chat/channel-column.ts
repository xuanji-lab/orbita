/**
 * 通道列（子会话 PR4b）的纯函数：哪些通道显示、消息 who 行的文案与语气。
 * 组件不测（仓库 renderer 组件无测试框架先例），逻辑抽出来落在这里测。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载——值导入必须走相对路径带
 * `.ts` 后缀（AGENTS.md 硬规则，先例 `stats-format.ts:13`）；本文件目前不需要
 * shared 的任何值，只用类型，`import type` 走 `@shared/...` 别名即可。
 */
import type { ChannelMessage, ChannelSummary } from "@shared/channel";

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
 * 线——chat 主区不该被挤到 480px 以下。但通道列（300px，PR4b）当时没算进这套预算：
 * 窗口 1200px、右栏与通道列同时开着时，主槽被压到 ~200px。
 */
export const MIN_CHAT_WIDTH_FOR_INLINE = 480;

export type ChannelColumnLayout = "inline" | "overlay";

/**
 * 通道列该内联展示还是转成覆盖层（子会话 PR4c fix）。
 *
 * 全局窄窗（`narrow`，<960px）：维持 PR4b 已有行为，直接 overlay——那时右栏本身
 * 也已经转成覆盖层，不占 flex 空间，不存在「挤主槽」的问题，不需要走下面的量算。
 *
 * 非窄窗：**用户刚打开的右栏优先，通道列让位**——右栏是用户这一刻主动点开的东西，
 * 通道列是背景信息；`paneWidth − rightPanelWidth − columnWidth ≥ 480` 才内联，
 * 否则转覆盖层（同 narrow 下的既有行为：不自动出现，右图标条入口 / 点标记时以
 * 右侧锚定覆盖层出现，Esc 或再点入口收起）。
 *
 * `paneWidth` 必须是**不受通道列自己当前占不占空间影响**的那个数——调用方量的是
 * `.pane` 本身（`.layer` 里的一个 flex 项，宽度由祖先决定，不被子级反向影响），
 * 不是「chat 主区实际渲染宽 + 右栏」那种会随通道列当前状态自指变化的量法。
 * `rightPanelWidth` 同理传「此刻实际渲染宽」（右栏关着或右栏自己也在窄窗覆盖层
 * 模式时，这个数天然是 0，调用方不需要另外判断「右栏开没开」）。
 * `paneWidth <= 0`（还没量到）时保守走 overlay，不擅自把主槽挤窄。
 */
export function channelColumnLayout(input: {
  narrow: boolean;
  paneWidth: number;
  rightPanelWidth: number;
  columnWidth: number;
}): ChannelColumnLayout {
  if (input.narrow) return "overlay";
  if (input.paneWidth <= 0) return "overlay";
  const chatWidthIfInline = input.paneWidth - input.rightPanelWidth - input.columnWidth;
  return chatWidthIfInline >= MIN_CHAT_WIDTH_FOR_INLINE ? "inline" : "overlay";
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
export function channelWhoLabel(message: ChannelMessage): ChannelWhoLabel {
  const you = message.author === "user";
  if (message.kind === "reply") {
    const steer = message.delivery === "steer";
    return { text: steer ? "reply · steer" : "reply · turn end", tone: steer ? "reply" : "neutral", you };
  }
  if (message.kind === "question") return { text: "question", tone: "question", you };
  if (message.kind === "done") return { text: "done", tone: "done", you };
  if (message.kind === "failed") return { text: "failed", tone: "failed", you };
  return { text: message.kind, tone: "neutral", you };
}
