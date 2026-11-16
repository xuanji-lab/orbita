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
 * 行首记号（2026-11-17 减色，用户：「红蓝绿黄灯可以保留，在左侧栏是很直观的，但在子会话的 panel 里有点烦人」）：
 * 只有要你出手的（在问你、被打断等你点继续、没做成）是橙点；在做 = 灰点；做完 = 灰勾；终止的 / 还没开口的不标。
 * 侧栏的四色饼不动——这里不再用 StatusPie。
 */
export type SubSessionMark = "ask" | "work" | "done" | null;

export function subSessionMark(status: SubSessionRowStatus): SubSessionMark {
  switch (status) {
    case "waiting":
    case "interrupted":
    case "failed":
      return "ask";
    case "running":
      return "work";
    case "done":
      return "done";
    default:
      return null;
  }
}

/**
 * 默认只列要你看的和在做的；做完的与停着的折成末尾一行「做完 N 件 · 停着 M 件」（点开才列）。没做成的留着，直到主会话处理过。
 * 入参已按 sortSubSessionRows 排好，两段各自保持原顺序。
 */
export function splitDoneRows<T extends { status: SubSessionRowStatus }>(
  rows: readonly T[],
): { open: T[]; done: T[]; parked: T[] } {
  const open: T[] = [];
  const done: T[] = [];
  // 停着的：没在跑、也没交回 / 提问 / 失败（这一轮跑完没报、或被用户终止）。不混在「在做」里，和做完的一起折起来
  const parked: T[] = [];
  for (const row of rows) {
    if (row.status === "done") done.push(row);
    else if (row.status === "idle" || row.status === "stopped") parked.push(row);
    else open.push(row);
  }
  return { open, done, parked };
}

/**
 * 头上那句：「1 件等你 · 1 件没做成 · 3 件在做」（灰字，不上色——行前的橙点已经够了）。「等你」与父会话顶上胶囊同一个数
 * （在问你 + 被打断），没做成单说，免得两处数字对不上。
 */
export function subSessionHeadline(
  rows: readonly { status: SubSessionRowStatus }[],
  words: {
    interrupted: (count: number) => string;
    waiting: (count: number) => string;
    failed: (count: number) => string;
    working: (count: number) => string;
  },
): string {
  const waiting = rows.filter((row) => row.status === "waiting" || row.status === "interrupted").length;
  const interrupted = rows.filter((row) => row.status === "interrupted").length;
  const failed = rows.filter((row) => row.status === "failed").length;
  const working = rows.filter((row) => row.status === "running").length;
  return [
    waitingSummary(waiting, interrupted, words),
    ...(failed > 0 ? [words.failed(failed)] : []),
    ...(working > 0 ? [words.working(working)] : []),
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * 子会话名字开头的英文代号前缀（「ss-b-storybench 叙事类比数据集」）显示时剥掉——只当保险：代号应在派活时
 * 用中文起名解决（路线图 2026-11-16）。只剥「小写字母开头、带连字符或下划线的一个词 + 空白或冒号」，而且后面
 * 得有中文；「UrbanGPT 复现」「S1-S3 验收」「Windows 新旧对比」「foo-bar baz」都原样留着。
 */
export function displaySubSessionTitle(title: string): string {
  const match = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)+[\s:：·]+/.exec(title);
  if (match === null) return title;
  const rest = title.slice(match[0].length).trim();
  return /[\u3400-\u9fff]/.test(rest) ? rest : title;
}

/**
 * 进度面板「派出去的活」列哪几件：在做的、要你出手的（在问你、被打断、没做成）；做完的交回来就不在这里了，
 * 终止的、还没开口的也不列。排序沿用收件箱（要你出手的在前）。
 */
export function dispatchedRows<T extends { status: SubSessionRowStatus }>(rows: readonly T[]): T[] {
  return rows.filter((row) => row.status === "running" || subSessionMark(row.status) === "ask");
}

/** 一件活用了多久（派出去到现在）：「不到 1 分钟」「21 分钟」「1 小时」「1 小时 5 分钟」 */
export function jobElapsed(
  ms: number,
  words: { lessThanMinute: string; minutes: (n: number) => string; hours: (n: number) => string; hoursMinutes: (h: number, m: number) => string },
): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return words.lessThanMinute;
  if (minutes < 60) return words.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 || hours >= 10 ? words.hours(hours) : words.hoursMinutes(hours, rest);
}

/**
 * 通道里能说明「它怎么样了」的那一句（2026-11-17 改）：只取子会话自己说的话——问：…/ 进度：…/ 完成：…/ 没做成：…，
 * 取第一个非空行的第一句、先过 work-line 的 sanitizeWorkLine（不露命令、网址、路径、英文代号）。
 * 父会话的回信（reply）、还没开口、洗空了的进度都不算——「收到了回复」「还没说话」「报了一次进度」说的是通道状态，
 * 不是它在干什么（主会话 11-17 看图挑出来的），这些情况返回空串，由调用方决定退回什么。
 * 提问、完成、没做成洗空了照旧说是哪种（「在问你」「完成」「没做成」本身就是结论）。
 *
 * `messages` 为该子通道时间正序的全文（useParentChannels）；通道拉不到（undefined）与空列表同待遇。
 */
export function latestChannelLine(
  messages: readonly ChannelMessage[] | undefined,
  _status: SubSessionRowStatus,
  t: Messages,
): string {
  const spoken = [...(messages ?? [])].reverse().find((message) => message.from === "child");
  if (spoken === undefined) return "";
  // 第一句：回报的结论 / 问题写在最前（子会话的说明要求先写结论）
  const said = sanitizeWorkLine(firstSentenceOf(spoken.text));
  switch (spoken.kind) {
    case "question":
      return said === "" ? t.channel.latestQuestionBare : t.channel.latestQuestion(said);
    case "progress":
      return said === "" ? "" : t.channel.latestProgress(said);
    case "done":
      return said === "" ? t.channel.latestDone : t.channel.latestDoneWith(said);
    case "failed":
      return said === "" ? t.channel.latestFailed : t.channel.latestFailedWith(said);
    default:
      return "";
  }
}

/**
 * 子会话面板一行的第二行（每件活一句话）。
 * - 在跑 / 停着没交回（idle、stopped）：按 work-line 的来源顺序从这条子会话的转录里取（它刚说的话 → 计划里在做的那步 →
 *   书记员 → 不带参数的动作，动作只给在跑的）；取不到再看通道里它最后说的那句（进度：…）；都没有就空串——宁可只留名字一行，
 *   也不写「还没说话」。在跑且 N 分钟没动静时后面带上几分钟。
 * - 在问你 / 没做成 / 做完 / 被打断：通道里它最后说的那句（结论）。
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
  const quietish = input.status === "running" || input.status === "idle" || input.status === "stopped";
  if (!quietish) return latestChannelLine(input.messages, input.status, t);
  const running = input.status === "running";
  const facts = workFacts(input.items, running);
  const plan = planTimeline(input.items)?.current.items ?? null;
  const line = workLine(
    { said: facts.said, planStep: currentPlanStep(plan), clerk: null, activity: running && input.items.length > 0 ? facts.activity : null },
    { activity: t.channel.activity, waiting: t.channel.waitingStep },
  );
  const text = line?.text ?? latestChannelLine(input.messages, input.status, t);
  if (!running || text === "" || !isQuiet(input.now, true, input.lastActivityAt)) return text;
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
