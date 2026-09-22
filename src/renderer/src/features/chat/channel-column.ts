/**
 * 通道列（子会话 PR4b）的纯函数：哪些通道显示、消息 who 行的文案与语气。
 * 组件不测（仓库 renderer 组件无测试框架先例），逻辑抽出来落在这里测。
 *
 * 纯模块：不 import React，可被 `node --test` 直接加载——值导入必须走相对路径带
 * `.ts` 后缀（AGENTS.md 硬规则，先例 `stats-format.ts:13`）；本文件目前不需要
 * shared 的任何值，只用类型，`import type` 走 `@shared/...` 别名即可。
 */
import type { ChannelMessage, ChannelSummary } from "@shared/channel";

/**
 * 通道列显示哪些通道（交接裁决）：有 task 之外的往来才出现——只派出没说话的不占位
 * （父流里的派出卡已经说了这件事）；有活跃子会话时自动出现——子在跑时它的通道就
 * 该在，用户可以看它领了什么任务、可以插话，跑完没说过话的不占位。
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
): ChannelSummary[] {
  return [...summaries.values()]
    .filter((summary) => summary.hasExchange || liveRunning(summary.childId))
    .sort((a, b) => b.lastAt - a.lastAt);
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
