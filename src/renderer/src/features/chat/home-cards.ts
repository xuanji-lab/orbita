import type { SessionMeta, TranscriptRecord } from "@shared/session";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载，@shared 别名
// 只在构建期由 electron-vite 解析（同 stats-format.ts:13 的先例）
import { rootSessions } from "../../../../shared/session.ts";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { planTimeline } from "../context/plan-timeline.ts";
import { toolIndexOf } from "../context/task-progress.ts";
import { flattenRenderUnits, groupToolUnits, groupTurnsByTurn, toolCallSummary, type TurnProcessUnit } from "./tool-results.ts";
import { firstLine, processLive } from "./turn-process.ts";

/**
 * 首页会话卡的选卡与行位规则（纯函数，ChatView 首页唯一消费者）。
 *
 * 规则：
 * - **候选与现状同一排除**：已归档、从未发过消息（无标题）的会话不进卡——归档是用户明确说「别翻出来」。
 * - **遗留事项不再让位**（2026-10-30 推翻 2026-09-22 的「有 open carryover 的会话优先占卡、行位换成遗留标题」）：
 *   用户说遗留没人用、太多、占首页卡，界面要「信息呈现得更高效，而不是更多」。遗留 / 以后再做只在
 *   那条任务的进度面板与侧栏的跨任务索引里，首页卡只讲「此刻在干什么」与最近提问。
 *
 * - **要你注意的先占卡**（2026-10-30，原型 `function home()`「只放需要你注意的三条：等你 >
 *   出错 > 在跑 > 最近」）：给了 `stateOf` 时，等你 / 出错 / 在跑的会话先按这个顺序占卡，
 *   其余照上面两轮补齐。卡上说的是「此刻在干什么」（homeCardLine），在跑的会话没上卡，
 *   这一句就说不出来。
 *
 * 前置条件：`sessions` 已按 `sortSessions` 排序（ChatView 吃的
 * `session.sessions` 由主进程 `list()` 排好）。函数不再排一次——排法必须
 * 只有 `sortSessions` 一份，这里重排迟早漂移。
 *
 * **子会话不进首页会话卡**（子会话 PR4c，2.3）：`session.sessions` 是全量列表
 * （含子会话），首页卡与左栏、辅助对话选择器一样只列根会话——子会话唯一的入口
 * 是母会话的右栏 Sub-sessions 面板。node --test 直接加载本文件，`rootSessions`
 * 这个值导入因此走相对路径带 `.ts` 后缀（`@shared` 别名只在构建期由
 * electron-vite 解析），其余仍是 type import。
 */

/** 普通卡的行位上限（现状三槽，recentQueries 本身就最多 3 条） */
export const HOME_CARD_QUERY_ROWS = 3;

/** 首页卡总数（现状恒三） */
const HOME_CARD_COUNT = 3;

/** 要你注意的先占卡，按这个顺序（与铃铛清单、折叠组头的汇总同序，跑完没看算「最近」） */
const ATTENTION_ORDER: readonly Exclude<SessionRunState, null>[] = ["waiting", "failed", "running"];

/** 卡内一行的数据：最近提问，纯文本 */
export interface HomeCardRow {
  text: string;
}

/** 首页一张会话卡的完整数据 */
export interface HomeCard {
  sessionId: string;
  title: string;
  /** 行位吃 recentQueries（最多 3 条） */
  rows: HomeCardRow[];
}

/**
 * 按上述规则选出首页的 3 张卡。
 */
export function selectHomeCards(
  sessions: readonly SessionMeta[],
  /** 会话运行态（runStateOf）；不给 = 不按运行态排（旧口径） */
  stateOf?: (meta: SessionMeta) => SessionRunState,
): HomeCard[] {
  // 候选与现状同一排除：子会话（子会话 PR4c 2.3）、归档、无标题。列表已按
  // sortSessions 排序，相对顺序即「置顶优先 + 最近活跃」，两个轮次直接按序扫
  const eligible = rootSessions(sessions).filter((m) => !m.archived && m.title !== "");

  const cards: HomeCard[] = [];
  const picked = new Set<string>();
  const take = (meta: SessionMeta): void => {
    cards.push(cardFor(meta));
    picked.add(meta.id);
  };
  // 第零轮：要你注意的（等你 > 出错 > 在跑），同档内保持列表序
  if (stateOf !== undefined) {
    for (const want of ATTENTION_ORDER) {
      for (const meta of eligible) {
        if (cards.length >= HOME_CARD_COUNT) break;
        if (!picked.has(meta.id) && stateOf(meta) === want) take(meta);
      }
    }
  }
  // 第一轮：剩余槽位按「最近活跃」补齐
  for (const meta of eligible) {
    if (cards.length >= HOME_CARD_COUNT) break;
    if (picked.has(meta.id)) continue;
    take(meta);
  }
  return cards;
}

/** 一张卡的行位数据：recentQueries 截断到 3 */
function cardFor(meta: SessionMeta): HomeCard {
  return {
    sessionId: meta.id,
    title: meta.title,
    rows: meta.recentQueries.slice(0, HOME_CARD_QUERY_ROWS).map((text): HomeCardRow => ({ text })),
  };
}

/** 卡上那一句要用到的文案（ChatView 从 t.homeCard / t.chat 拼好传进来；纯函数不碰语言表） */
export interface HomeCardLineText {
  thinking: string;
  /** 计划里在做的那一步 + 此刻的一句 */
  doing: (step: string, now: string) => string;
  /** 挂着的审批：要做什么（动词 + 对象） */
  approve: (what: string) => string;
  childWaiting: string;
  failed: string;
  done: string;
  /** 工具调用的动词（与过程行的计数词同一套：t.chat.rollupTool(rollupToolKey(...))） */
  verb: (toolName: string, input: unknown) => string;
  /** 工具调用的一句话（缺省 toolCallSummary）；读技能时写技能名而不是路径 */
  summary?: (toolName: string, input: unknown) => string | null;
}

export interface HomeCardLineInput {
  state: SessionRunState;
  /** 这条会话槽里的记录（selectTranscript 的结果）；槽没载过 = null */
  records: readonly TranscriptRecord[] | null;
  /** 挂着的第一个工具审批；没有 = null */
  approval: { toolName: string; input: unknown } | null;
  turnError: string | null;
  /** 最近一次提问（meta.recentQueries[0]） */
  lastAsk: string | null;
}

/**
 * 首页卡上「此刻在干什么」的那一句（2026-10-30，原型 `function home()`）。全从槽里现算，不另存：
 *
 * - 在跑：这一轮的当前章节（agent 刚说的话，没说话取最近一段思考）；没有章节就是正在跑的那个
 *   工具（动词 + 对象），都没有是「在想」。有计划且有一步在做时，前面带上那一步：
 *   「跑一遍检查：路径不对，换成 src」——计划说做到哪了，章节说此刻在干嘛。
 * - 等你：挂着的那个审批要做什么；自己没有审批（是子会话在等）就说子会话在等你批准。
 * - 出错：这一轮的错误原文第一行；槽没载过（重启后只剩未读标记）说「出错停下了」。
 * - 跑完没看：最后一段正文的第一行（结果）；槽没载过说「跑完了」。
 * - 没在跑：最近一次提问——这条任务最后在说什么。要写「agent 最后一句话」得读它的整份
 *   记录（主进程全量读 + 折叠，百 MB 级会话也有）或在 meta 里另存一份，两样都不做。
 *
 * 返回 null = 什么都说不出来（老会话没有 recentQueries），卡上那一行留空。
 */
export function homeCardLine(input: HomeCardLineInput, text: HomeCardLineText): string | null {
  const records = input.records;
  if (input.state === "waiting") {
    if (input.approval === null) return text.childWaiting;
    const summary = toolCallSummary(input.approval.toolName, input.approval.input);
    const verb = text.verb(input.approval.toolName, input.approval.input);
    return text.approve(summary === null ? verb : `${verb} ${summary}`);
  }
  if (input.state === "failed") {
    return (input.turnError === null ? null : firstLine(input.turnError)) ?? text.failed;
  }
  if (input.state === "running") {
    if (records === null) return text.thinking;
    const now = runningLine(lastTurn(records), text);
    const step = planTimeline(records)?.current.items.find((item) => item.status === "in_progress")?.text ?? null;
    return step === null || step === now ? now : text.doing(step, now);
  }
  if (input.state === "done") {
    if (records === null) return text.done;
    const answer = flattenRenderUnits(lastTurn(records)).filter((unit) => unit.kind === "text").at(-1);
    return (answer?.kind === "text" ? firstLine(answer.text) : null) ?? text.done;
  }
  return input.lastAsk === null || input.lastAsk.trim() === "" ? null : input.lastAsk;
}

/** 在跑那一轮的一句：当前章节 > 正在跑的工具 > 在想 */
function runningLine(turn: readonly TranscriptRecord[], text: HomeCardLineText): string {
  const results = toolIndexOf(turn);
  const view = groupTurnsByTurn(groupToolUnits(flattenRenderUnits(turn)), true, results);
  const unit = view.filter((entry): entry is TurnProcessUnit => entry.kind === "turnProcess").at(-1);
  if (unit === undefined) return text.thinking;
  const live = processLive(unit, results, () => null);
  if (live.chapter !== null) return live.chapter.title;
  if (live.now.kind === "tool") {
    const { toolName, input } = live.now.call;
    const summary = text.summary === undefined ? toolCallSummary(toolName, input) : text.summary(toolName, input);
    const verb = text.verb(toolName, input);
    return summary === null ? verb : `${verb} ${summary}`;
  }
  return text.thinking;
}

/** 最后一轮：最后一条用户消息起（含）；槽里还没有用户消息（只收到了事件）就是全部 */
function lastTurn(records: readonly TranscriptRecord[]): readonly TranscriptRecord[] {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]?.role === "user") return records.slice(i);
  }
  return records;
}
