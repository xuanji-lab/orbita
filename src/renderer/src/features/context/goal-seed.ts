/**
 * 「带着目标开新会话」的种子消息（纯函数）。
 *
 * 用户 14:23 原话：「最后这个会话里剩下的 goal 不一定会在一个会话里面完成，然后你就可以从 goal（也属于进度的面板）
 * 这里选择带着 goal 开新的 session，goal 就会把目标、研究的目标，还有已经做了哪些 todo 带上，去开新的 session」。
 *
 * 形态沿用「转成任务」那条路（carryover-resume.ts 的 buildCarryoverSeed）：**发一条可见的结构化用户消息直接开工**，
 * 不走 internal——上下文从哪来的用户看得见，也点得开。新会话里 agent 读到这条消息，会照着把目标记成自己的目标
 * （update_goal，来源就是这条消息）。
 *
 * 带什么：目标原文；做完的 todo（每条一句）；没做完的 todo；开着的以后再做；改动账的要点（最近几条，
 * 从什么变成什么、为什么、谁提的）。每段有条数上限，免得种子比任务本身还长。
 *
 * 纯模块：可被 node --test 直接加载。
 */
import type { GoalLedger } from "../../../../shared/goal-ledger.ts";
import type { Messages } from "../../messages-en.ts";
import { planChangeText } from "./plan-text.ts";

/** 每段最多几条 */
export const SEED_MAX_LIST = 12;
/** 改动要点最多几条（最近的） */
export const SEED_MAX_CHANGES = 6;

export interface GoalSeedInput {
  /** 来源会话的标题；null = 来源已删除 */
  sourceTitle: string | null;
  ledger: GoalLedger;
  /** 来源会话里开着的「以后再做」（一句话 + 当时写的理由） */
  later: readonly { title: string; detail: string }[];
}

const pad = (n: number): string => String(n).padStart(2, "0");
const clock = (at: number): string => {
  const d = new Date(at);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 没有目标 = null（面板只在有目标时给这个动作，防御一道） */
export function buildGoalSeed(t: Messages, input: GoalSeedInput): string | null {
  const goal = input.ledger.goal;
  if (goal === null) return null;
  const lines: string[] = [t.goalSeed.lead(input.sourceTitle), "", `${t.goalSeed.goal}：${goal.text}`];
  const list = (title: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    lines.push("", `${title}：`, ...items.slice(0, SEED_MAX_LIST).map((item) => `- ${item}`));
  };
  list(t.goalSeed.done, input.ledger.todos.done);
  list(t.goalSeed.open, input.ledger.todos.open);
  list(
    t.goalSeed.later,
    input.later.map((item) => (item.detail === "" ? item.title : `${item.title}（${item.detail}）`)),
  );
  const changes = input.ledger.entries.slice(-SEED_MAX_CHANGES).map((entry) => {
    const what =
      entry.kind === "goal"
        ? entry.from === null
          ? t.goalSeed.goalSet(entry.to)
          : t.goalSeed.goalChanged(entry.from, entry.to)
        : entry.replaced !== null
          ? t.goalText.planReplaced(entry.replaced.length)
          : entry.changes.map((change) => planChangeText(t, change)).join("；");
    const source =
      entry.source.kind === "user" ? t.goalText.sourceUser(clock(entry.source.at), entry.source.head) : t.goalText.sourceSelf;
    return t.goalSeed.change(clock(entry.at), what, entry.why ?? "", source);
  });
  list(t.goalSeed.changes, changes);
  lines.push("", t.goalSeed.ask);
  return lines.join("\n");
}
