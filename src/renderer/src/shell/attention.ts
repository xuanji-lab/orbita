/**
 * 侧栏最上面钉住的「等你」（设计 11-sidebar-full C、11-attention，2026-11-17）：跨工作区每件在等用户的事一行——
 * 在问的、没做成等他看的。一屏只有这一处在叫人（橙点只在这里出现）；点一行跳过去，处理完那一行自己消失
 * （点一个只消一个，没有「全部清除」）。它替掉了右下角的铃铛与未读清单。
 *
 * 数据不另存：每一件就是侧栏行状态（Sidebar 的 rowState：runStateOf + 子会话通道状态）里 waiting / failed 的那些，
 * 一句话从通道里那件活自己说的话来（问题原话 / 没做成的原因），先过 work-line 的洗句子，不露命令、路径、代号。
 * 「等他验的」现在没有数据来源（没有「待验收」状态），不算进来。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { ChannelMessage } from "@shared/channel";
import type { SessionMeta } from "@shared/session";
import { latestSentence, sanitizeWorkLine } from "../../../shared/work-line.ts";
import type { SessionRunState } from "../features/notify/completion-notice.ts";

/** 「等你」最多露几行；超出的写「还有 N 件」 */
export const ATTENTION_SHOWN = 5;

export interface AttentionItem {
  meta: SessionMeta;
  /** waiting = 在问你 / 计划等你点头 / 被打断等你说继续；failed = 没做成、你还没看 */
  state: "waiting" | "failed";
  /** 所属工作区；null = 「任务」组里的 */
  workspaceId: string | null;
}

/**
 * 从侧栏各组的行里挑出等你的：在问的在前、没做成的在后，同档最近动过的在前。
 * groups = 各工作区「没了结的活」与「任务」组的根会话（侧栏本来就在算的那几份，不另查一遍）。
 */
export function attentionItems(
  groups: readonly { workspaceId: string | null; rows: readonly SessionMeta[] }[],
  stateOf: (meta: SessionMeta) => SessionRunState,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const group of groups) {
    for (const meta of group.rows) {
      const state = stateOf(meta);
      if (state === "waiting" || state === "failed") items.push({ meta, state, workspaceId: group.workspaceId });
    }
  }
  return items.sort(
    (a, b) => (a.state === b.state ? 0 : a.state === "waiting" ? -1 : 1) || b.meta.updatedAt - a.meta.updatedAt,
  );
}

export interface AttentionWords {
  /** 在问你、但问题原话洗不出干净的一句 */
  asks: string;
  /** 没做成：带原因 / 不带原因 */
  failedWith: (reason: string) => string;
  failed: string;
  /** 根会话的「等你」：计划等你点头 / 派出去的活被打断等你说继续 / 其它 */
  planAwaiting: string;
  interrupted: string;
  waiting: string;
}

/** 第一个非空行的第一句 */
function firstSentence(text: string): string {
  const line = text.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  return latestSentence(line);
}

/**
 * 「等什么」那一句。子会话：在问的取最后一条提问的第一句，没做成的取最后一条失败消息的第一句；
 * 洗不出来就只说是哪种事。根会话：按它为什么在等说（计划 / 被打断 / 其它）。
 */
export function attentionLine(
  item: AttentionItem,
  messages: readonly ChannelMessage[] | undefined,
  why: { planAwaiting: boolean; childInterrupted: boolean },
  words: AttentionWords,
): string {
  if (item.meta.parentId !== undefined) {
    const kind = item.state === "waiting" ? "question" : "failed";
    const last = [...(messages ?? [])].reverse().find((message) => message.kind === kind && message.from === "child");
    const said = last === undefined ? "" : sanitizeWorkLine(firstSentence(last.text));
    if (item.state === "waiting") return said === "" ? words.asks : said;
    return said === "" ? words.failed : words.failedWith(said);
  }
  if (item.state === "failed") return words.failed;
  if (why.planAwaiting) return words.planAwaiting;
  if (why.childInterrupted) return words.interrupted;
  return words.waiting;
}
