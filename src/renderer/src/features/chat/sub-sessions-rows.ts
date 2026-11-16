/**
 * 右栏 Sub-sessions 面板列表层与父子会话通道卡的纯函数：一行 / 一卡的状态怎么算、
 * 全部行怎么排序。组件不测（仓库 renderer 组件无测试框架先例，channel-column.ts 同款
 * 做法）——逻辑抽出来落在这里测，`SubSessionsPanel.tsx` 只负责取数据、拼行、调这里的
 * 函数。
 *
 * 纯模块：不 import React、不 import `@shared/*` 的值（只用类型），可被
 * `node --test` 直接加载。
 */
import type { ChannelMessage, ChannelStatus } from "@shared/channel";
import type { Messages } from "../../messages-en.ts";
import type { TranscriptItem } from "@shared/transcript";
import { planTimeline } from "../context/plan-timeline.ts";
import { currentPlanStep, isQuiet, latestSentence, sanitizeWorkLine, workFacts, workLine } from "./work-line.ts";

/**
 * 一行的显示状态（字面对应设计裁决的颜色/图标分配）：
 *   running  = 子在跑（accent）
 *   waiting  = 通道状态 waiting，子问了、父还没回（warning，"waiting for you"）
 *   interrupted = 子会话被应用崩溃打断、停着等你点「继续」（@shared/kernel 的 awaitsContinue；warning，归「等你」）——
 *     不点它就一直停着，父会话也一直等它
 *   stopped  = 通道状态 stopped，**用户**终止了这个子会话（tertiary，"stopped"）——
 *     用户的裁决压过在跑这类瞬时态：停都停了，不该再引导用户去盯一个死轮
 *   done     = 通道 closed 于 done（success）
 *   failed   = 通道 closed 于 failed（danger）
 *   idle     = 都不是（tertiary）——子会话建了但通道还没有除 task 外的往来，也没在跑
 */
export type SubSessionRowStatus =
  | "running"
  | "waiting"
  | "interrupted"
  | "done"
  | "failed"
  | "stopped"
  | "idle";

/**
 * 一行状态怎么定：**waiting 优先于 stopped，优先于 running**——
 * waiting 与 stopped 同源（通道状态，互斥），摆在一起只是让检查顺序可读；stopped
 * 压过 running 是用户裁决的语义：终止了就别再拿「在跑」引导用户。
 * done/failed 只在不满足前者时才看（正常情况下 done/failed 的通道不会同时在跑，
 * 但状态机不为「不会发生」的组合留特判缺口，见 channelStatus 同款纪律）。
 */
export function subSessionRowStatus(input: {
  channelStatus: ChannelStatus | undefined;
  running: boolean;
  /** 被崩溃打断、等你点「继续」（缺席 = 否）；只在没在跑时为真，排在 running 之后只为读着顺 */
  interrupted?: boolean;
}): SubSessionRowStatus {
  if (input.channelStatus === "waiting") return "waiting";
  if (input.channelStatus === "stopped") return "stopped";
  if (input.running) return "running";
  if (input.interrupted === true) return "interrupted";
  if (input.channelStatus === "done") return "done";
  if (input.channelStatus === "failed") return "failed";
  return "idle";
}

/**
 * 排序优先级：数字越小越靠前——**等你（question / 被打断）最前，其次 running，其次 failed，
 * 其次 done**；stopped / idle 收尾（终局或还没说话，都不需要用户动手）。
 * running 原在 done 之后（2026-10-12 收件箱裁决）；2026-11-06 用户改：子会话一多（十几二十个），
 * 新派出、正在跑的被已完成的压到底部，每次都得往下翻——在跑的才是此刻在盯的，提到等你之后。注意与 subSessionRowStatus 的支配关系不是一回事：
 * 那一处说的是这一行自己标什么，这里说的是它排在哪里。failed 压过 done：失败
 * 常要人善后，完成只是知会。
 */
const STATUS_PRIORITY: Record<SubSessionRowStatus, number> = {
  waiting: 0,
  interrupted: 0,
  running: 1,
  failed: 2,
  done: 3,
  stopped: 4,
  idle: 4,
};

/**
 * 列表层的行排序（收件箱）：**等你（question / 被打断）最前，其次 running，其次
 * failed，其次 done**；同组之内**新的在前**（lastAt 倒序——通道里最后一条消息
 * 的时间，没有账本的按会话创建时间）。收件箱是待办清单：越新的越可能是你现在
 * 要处理的，老的沉下去。
 */
export function sortSubSessionRows<T extends { status: SubSessionRowStatus; lastAt: number }>(
  rows: readonly T[],
): T[] {
  return [...rows].sort(
    (a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status] || b.lastAt - a.lastAt,
  );
}

/**
 * 行首状态饼的档位（shell/StatusPie.tsx 的 `.status-pie`，与侧栏 / 铃铛清单同一个）：
 * running = 1/3 蓝、waiting / interrupted = 2/3 橙、done = 3/3 绿、failed = 3/3 红；
 * stopped / idle 不亮——「没什么要你做的」是整个东西退场，不是留一根灰杠。
 * stopped 是用户的裁决不是故障，与 idle 同槽。
 */
export function subSessionBarFill(status: SubSessionRowStatus): "running" | "waiting" | "done" | "failed" | undefined {
  switch (status) {
    case "running":
      return "running";
    case "waiting":
    case "interrupted":
      return "waiting";
    case "done":
      return "done";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

/**
 * 收件箱行的「最新一句」（2026-10-12 用户裁决：只需要看到沟通，不需要看到子会话在干嘛）：通道里**最新一条非 task
 * 消息**的一句话——问：…/ 进度：…/ 完成：…/ 失败：…/ 回复：…（最新的是父侧回信时）。2026-11-17 起取第一个非空行的
 * 第一句、先过 work-line 的 sanitizeWorkLine：**不露出命令、网址、路径、英文代号**（以前「进度：」后面
 * 原样是子会话写的第一行，常是命令或路径；完成 / 失败只写两个字），洗空了就只说是哪种消息。
 * 还没有非 task 消息时按状态说「在跑 · 还没说话」（idle / stopped 只说「还没说话」——它没在跑）。
 *
 * `messages` 为该子通道时间正序的全文（useParentChannels）；通道拉不到（undefined）与空列表同待遇。
 */
export function latestChannelLine(
  messages: readonly ChannelMessage[] | undefined,
  status: SubSessionRowStatus,
  t: Messages,
): string {
  const spoken = [...(messages ?? [])].reverse().find((message) => message.kind !== "task");
  if (spoken === undefined) {
    return status === "running" || status === "waiting"
      ? t.channel.notSpokenRunning
      : t.channel.notSpoken;
  }
  // 第一句：回报的结论 / 问题写在最前（子会话的说明要求先写结论）
  const said = sanitizeWorkLine(firstSentenceOf(spoken.text));
  switch (spoken.kind) {
    case "question":
      return said === "" ? t.channel.latestQuestionBare : t.channel.latestQuestion(said);
    case "progress":
      return said === "" ? t.channel.latestProgressBare : t.channel.latestProgress(said);
    case "done":
      return said === "" ? t.channel.latestDone : t.channel.latestDoneWith(said);
    case "failed":
      return said === "" ? t.channel.latestFailed : t.channel.latestFailedWith(said);
    case "reply":
      return said === "" ? t.channel.latestReplyBare : t.channel.latestReply(said);
    default:
      // stop：账本里可能有（旧数据），行上不渲染裁决细节——状态条已经说了 stopped
      return t.channel.notSpoken;
  }
}

/**
 * 子会话面板一行的第二行（每件活一句话）。在跑的：按 work-line 的来源顺序（刚说的话 → 计划在做的那步 → 书记员 →
 * 不带参数的动作）从这条子会话的转录里取，取不到才退回通道里最新一句；「没动静」（在跑、N 分钟没有任何 progress）时
 * 后面带上几分钟。没在跑的：通道里最新一句（完成 / 失败 / 在问你的结论）。
 *
 * `items` = 这条子会话在 renderer 槽里的转录（窗口晚于它开起来时可能是空的，那时只能退回通道）。
 */
export function subSessionLine(
  input: {
    status: SubSessionRowStatus;
    messages: readonly ChannelMessage[] | undefined;
    items: readonly TranscriptItem[];
    now: number;
    lastActivityAt: number | null;
  },
  t: Messages,
): string {
  if (input.status !== "running") return latestChannelLine(input.messages, input.status, t);
  const facts = workFacts(input.items, true);
  const plan = planTimeline(input.items)?.current.items ?? null;
  const line = workLine(
    { said: facts.said, planStep: currentPlanStep(plan), clerk: null, activity: input.items.length === 0 ? null : facts.activity },
    { activity: t.channel.activity, waiting: t.channel.waitingStep },
  );
  const text = line?.text ?? latestChannelLine(input.messages, input.status, t);
  if (!isQuiet(input.now, true, input.lastActivityAt)) return text;
  return t.channel.quietFor(text, Math.floor((input.now - (input.lastActivityAt ?? input.now)) / 60_000));
}

/** 第一个非空行的第一句（收件箱行里只放得下一句话） */
function firstSentenceOf(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return latestSentence(line);
}

/**
 * 「等你」那几个子会话怎么说（父会话顶部胶囊与右栏子会话列表标题同一套，2026-11-16 验收：一处写「被打断」一处写「在等你」，
 * 读的人会以为是两件事）：有被打断的，先写被打断的个数；其余等你的（问你）照各处原来的说法写个数；都没有 = 空串。
 */
export function waitingSummary(
  waiting: number,
  interrupted: number,
  words: { interrupted: (count: number) => string; waiting: (count: number) => string },
): string {
  const parts: string[] = [];
  if (interrupted > 0) parts.push(words.interrupted(interrupted));
  if (waiting - interrupted > 0) parts.push(words.waiting(waiting - interrupted));
  return parts.join(" · ");
}

/**
 * 父会话转录里派出卡的状态：通道摘要的终态（done / failed / waiting / stopped）优先；否则看子会话在 renderer
 * 会话槽里的 phase——不为 idle 就是还在跑；都不是时，被崩溃打断、等你点继续的说「被打断」（不说「空闲」——
 * 它停着是因为应用崩了，父会话还在等它）。
 */
export function delegateCardStatus(
  channelStatus: ChannelStatus | undefined,
  running: boolean,
  interrupted: boolean,
): "running" | "waiting" | "interrupted" | "done" | "failed" | "stopped" | "idle" {
  if (channelStatus === "done" || channelStatus === "failed" || channelStatus === "waiting" || channelStatus === "stopped") return channelStatus;
  if (running) return "running";
  return interrupted ? "interrupted" : "idle";
}

/**
 * `subSessionStatusOf` 从引擎读的两个槽的**最小结构面**——结构化而不是直接引用
 * `SessionEngine` 整型：本模块保持纯模块纪律（不 import useChatSession），
 * 测试拿字面量假对象就能喂，真实引擎天然满足这个形状。
 */
export interface SubSessionEngineSlots {
  /** 会话 phase：非 idle = 这条会话此刻真的在跑 */
  phaseOf: (id: string) => string;
  /** 被崩溃打断、等你点「继续」（引擎的 interruptedOf；缺席 = 不认这个来源） */
  interruptedOf?: (id: string) => boolean;
}

/**
 * 一行 / 一张通道卡的显示状态怎么取：通道摘要的 status + 引擎的 phase，
 * 拼成 `subSessionRowStatus` 的输入。Sub-sessions 面板的行与父子会话面板的通道卡
 * **共用这一份 glue**，两处画出来的状态永远同源。
 *
 * 2026-10 bug 的直接教训：通道卡曾只看 channelStatus，而它的 "running" 语义是
 * 「通道开着」（子会话还没报 done/failed/question），跟子会话在不在跑无关——子会话
 * 这一轮跑完但没调 report_to_parent 时，面板已按 phase 画 idle，通道卡还在画
 * accent 呼吸的「运行中」。phase 必须参与推导，且只能从这一处参与。
 */
export function subSessionStatusOf(
  childId: string,
  channelStatus: ChannelStatus | undefined,
  engine: SubSessionEngineSlots,
): SubSessionRowStatus {
  return subSessionRowStatus({
    channelStatus,
    running: engine.phaseOf(childId) !== "idle",
    interrupted: engine.interruptedOf?.(childId) ?? false,
  });
}
