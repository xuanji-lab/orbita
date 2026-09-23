import type { Carryover, SessionMeta } from "@shared/session";
// 值导入必须走相对路径带 .ts 后缀：本文件被 node --test 直接加载，@shared 别名
// 只在构建期由 electron-vite 解析（同 stats-format.ts:13 的先例）
import { rootSessions } from "../../../../shared/session.ts";

/**
 * 首页会话卡的选卡与行位规则（纯函数，ChatView 首页唯一消费者）。
 *
 * 规则（2026-09-22 拍板）：
 * - **候选与现状同一排除**：已归档、从未发过消息（无标题）的会话不进卡，
 *   即使它身上挂着 open 遗留事项——归档是用户明确说「别翻出来」。
 * - **有 open carryover 的会话优先占卡**，多条之间按列表序（前置条件见下），
 *   即 updatedAt 新→旧；剩余槽位按现状「最近活跃」规则补齐，总数仍是 3。
 * - **行位替换**：待办卡的行位从 recentQueries 换成遗留事项标题，一卡最多
 *   4 行；超过截断，**不做「等 N 项」**（用户明示「到时候再说」）。
 *   没有遗留的会话保持现状，行位吃 recentQueries（最多 3 条）。
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

/** 待办卡的行位上限（用户拍板：超过直接截断，不显示「等 N 项」） */
export const HOME_CARD_CARRYOVER_ROWS = 4;

/** 普通卡的行位上限（现状三槽，recentQueries 本身就最多 3 条） */
export const HOME_CARD_QUERY_ROWS = 3;

/** 首页卡总数（现状恒三） */
const HOME_CARD_COUNT = 3;

/** 卡内一行的数据：kind 决定渲染（遗留行带图标，提问行纯文本） */
export interface HomeCardRow {
  kind: "carryover" | "query";
  text: string;
}

/** 首页一张会话卡的完整数据 */
export interface HomeCard {
  sessionId: string;
  title: string;
  /** 有 open carryover：行位显示遗留标题（恒 4 槽），否则显示 recentQueries（恒 3 槽） */
  todo: boolean;
  rows: HomeCardRow[];
}

/**
 * 按上述规则选出首页的 3 张卡。carryovers 是全量记录（engine 缓存），
 * 这里按 `sourceSessionId` 现算分组——会话卡不另建缓存，meta 不冗余计数。
 */
export function selectHomeCards(
  sessions: readonly SessionMeta[],
  carryovers: readonly Carryover[],
): HomeCard[] {
  // open 项按来源会话分组；组内保持 carryovers 存储序（创建序，与侧栏面板同序）
  const openBySession = new Map<string, Carryover[]>();
  for (const item of carryovers) {
    if (item.status !== "open") continue;
    const list = openBySession.get(item.sourceSessionId);
    if (list === undefined) openBySession.set(item.sourceSessionId, [item]);
    else list.push(item);
  }

  // 候选与现状同一排除：子会话（子会话 PR4c 2.3）、归档、无标题。列表已按
  // sortSessions 排序，相对顺序即「置顶优先 + 最近活跃」，两个轮次直接按序扫
  const eligible = rootSessions(sessions).filter((m) => !m.archived && m.title !== "");

  const cards: HomeCard[] = [];
  // 第一轮：有 open 遗留的会话优先占卡
  for (const meta of eligible) {
    if (cards.length >= HOME_CARD_COUNT) break;
    const open = openBySession.get(meta.id);
    if (open === undefined) continue;
    cards.push(cardFor(meta, open));
  }
  // 第二轮：剩余槽位按现状「最近活跃」补齐
  const picked = new Set(cards.map((card) => card.sessionId));
  for (const meta of eligible) {
    if (cards.length >= HOME_CARD_COUNT) break;
    if (picked.has(meta.id)) continue;
    cards.push(cardFor(meta, undefined));
  }
  return cards;
}

/** 一张卡的行位数据：待办卡吃遗留标题（截断到 4），普通卡吃 recentQueries（截断到 3） */
function cardFor(meta: SessionMeta, open: readonly Carryover[] | undefined): HomeCard {
  if (open === undefined) {
    return {
      sessionId: meta.id,
      title: meta.title,
      todo: false,
      rows: meta.recentQueries
        .slice(0, HOME_CARD_QUERY_ROWS)
        .map((text): HomeCardRow => ({ kind: "query", text })),
    };
  }
  return {
    sessionId: meta.id,
    title: meta.title,
    todo: true,
    rows: open
      .slice(0, HOME_CARD_CARRYOVER_ROWS)
      .map((item): HomeCardRow => ({ kind: "carryover", text: item.title })),
  };
}
