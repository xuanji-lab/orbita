import type { SessionMeta, TranscriptRecord } from "@shared/session";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载，@shared 别名
// 只在构建期由 electron-vite 解析（同 stats-format.ts:13 的先例）
import { rootSessions } from "../../../../shared/session.ts";
import { withoutQuotes } from "../../../../shared/quote.ts";
import type { SessionRunState } from "../notify/completion-notice.ts";
import { planTimeline } from "../context/plan-timeline.ts";
import { toolIndexOf } from "../context/task-progress.ts";
import { flattenRenderUnits, groupToolUnits, groupTurnsByTurn, toolCallSummary, type TurnProcessUnit } from "./tool-results.ts";
import { firstLine, processLive } from "./turn-process.ts";

/**
 * 首页记录的选行与「此刻在干什么」那一句（纯函数，ChatView 首页唯一消费者）。
 *
 * 规则：
 * - **候选**：已归档、从未发过消息（无标题）的会话不进——归档是用户明确说「别翻出来」；
 *   子会话也不进（子会话 PR4c，2.3）：`session.sessions` 是全量列表，首页与左栏一样只列根会话，
 *   子会话唯一的入口是母会话的右栏 Sub-sessions 面板。
 * - **只列要你注意的**：等你（含出错）与进行中。闲置的、跑完的会话不上首页（2026-11-22 删掉「最近」组：
 *   侧栏已经按最近活跃列了一遍会话，首页再列一遍是重复；跑完没看的靠侧栏的未读标记）。
 *
 * 前置条件：`sessions` 已按 `sortSessions` 排序（ChatView 吃的 `session.sessions` 由主进程 `list()`
 * 排好）。函数不再排一次——排法必须只有 `sortSessions` 一份，这里重排迟早漂移。
 * node --test 直接加载本文件，`rootSessions` 这个值导入因此走相对路径带 `.ts` 后缀。
 */

/**
 * 首页「记录」的两组上限：等你 / 进行中各留 4 行——多于此说明同时在跑的活已经超出一眼能读的量，再多只是堆。
 * 原来还有第三组「最近」（5 行，含跑完没看的），2026-11-22 用户裁决删掉。
 */
const HOME_LOG_LIMITS = { waiting: 4, running: 4 } as const;

/** 首页记录的两个组：等你（含出错——它也在等你处置）> 进行中 */
export type HomeLogGroupId = keyof typeof HOME_LOG_LIMITS;

/** 记录里的一行：只给会话 id 与标题，其余（状态 / 那一句 / 时间）由调用方按槽里的实况现算 */
export interface HomeLogRow {
  sessionId: string;
  title: string;
}

export interface HomeLogGroup {
  group: HomeLogGroupId;
  rows: HomeLogRow[];
}

/**
 * 首页记录的选行与分组。
 *
 * 候选排除子会话、归档、无标题。顺序沿用列表序（sortSessions：置顶优先 + 最近活跃）。
 * 分组按运行态：waiting / failed → 「等你」，running → 「进行中」；其余（没在跑、跑完没看）不进首页。
 * 没有行的组不返回——空组只会在边栏里留一个无所指的组名。
 */
export function selectHomeLog(
  sessions: readonly SessionMeta[],
  stateOf: (meta: SessionMeta) => SessionRunState,
): HomeLogGroup[] {
  const eligible = rootSessions(sessions).filter((m) => !m.archived && m.title !== "");
  const buckets: Record<HomeLogGroupId, HomeLogRow[]> = { waiting: [], running: [] };
  for (const meta of eligible) {
    const state = stateOf(meta);
    const group: HomeLogGroupId | null =
      state === "waiting" || state === "failed" ? "waiting" : state === "running" ? "running" : null;
    if (group === null || buckets[group].length >= HOME_LOG_LIMITS[group]) continue;
    buckets[group].push({ sessionId: meta.id, title: meta.title });
  }
  return (["waiting", "running"] as const)
    .filter((group) => buckets[group].length > 0)
    .map((group) => ({ group, rows: buckets[group] }));
}

/**
 * 一条提问里「用户看得见」的文字（2026-11-07 返工：首页记录行把「此刻在干什么」放在行中段最醒目的位置，
 * 老会话的 recentQueries[0] 直接露出了系统提示原文，如 `<!-- 你正在通过 Proma 飞书桥…`）。
 * 剥掉系统加的包装：成对标签块（<user_context>、<orbita-memory>、<referenced_task>…）、
 * 自闭合标签、HTML 注释（没闭合的注释吞到结尾——它之后全是系统文字）、引用块（<quoted_context>）。
 * 剥完压缩空白；空串由调用方换成「（没有文字）」，不把空行留成一个没有解释的空格。
 */
const WRAPPER_TAGS = [
  "user_context",
  "orbita-memory",
  "referenced_task",
  "attached-files",
  "mentioned_tools",
  "system-reminder",
  "orbita-quotes",
  "orbita-git-attribution",
  "channel",
] as const;
const WRAPPER_BLOCK = new RegExp(`<(${WRAPPER_TAGS.join("|")})\\b[^>]*>[\\s\\S]*?</\\1>`, "g");
const WRAPPER_SELF_CLOSING = new RegExp(`<(?:${WRAPPER_TAGS.join("|")})\\b[^>]*/>`, "g");

export function visibleAsk(text: string): string {
  return withoutQuotes(text)
    .replace(WRAPPER_BLOCK, "")
    .replace(WRAPPER_SELF_CLOSING, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!--[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
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
  /** 最近一次提问剥完系统包装后什么都没剩（整条是系统文字） */
  noText: string;
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
 * - 没在跑：最近一次提问（只取用户看得见的文字，剥掉系统包装，见 visibleAsk）——这条任务最后在说什么。要写「agent 最后一句话」得读它的整份
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
  if (input.lastAsk === null || input.lastAsk.trim() === "") return null;
  const ask = visibleAsk(input.lastAsk);
  return ask === "" ? text.noText : ask;
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
