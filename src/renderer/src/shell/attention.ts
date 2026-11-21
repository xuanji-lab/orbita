/**
 * 跨工作区每件在等用户的事（2026-11-17 起；2026-11-21 侧栏顶上不再列）：在问的、没做成等他看的
 * （主智能体派的活报了 failed 那一刻记一笔「没做成、没看」，见 App；你看过、或主智能体已处理就退场）。
 * 现在只用来给新冒出的那一件响一次提示音（Sidebar）；具体哪件、等什么写在主智能体进度面板最前的「等你」（job-brief.ts）。
 *
 * 数据不另存：每一件就是侧栏行状态（Sidebar 的 rowState：runStateOf + 子会话通道状态）里 waiting / failed 的那些，
 * 「等他验的」现在没有数据来源（没有「待验收」状态），不算进来。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
import type { SessionMeta } from "@shared/session";
import type { SessionRunState } from "../features/notify/completion-notice.ts";

/** 启动后多久之内冒出来的等你不响：那是读盘把已有的读出来（会话列表、各主智能体的通道状态陆续到），不是新事 */
export const ATTENTION_WARMUP_MS = 8000;

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
  /**
   * 没做成的那件已经被处理了（主智能体回了话 / 暂停 / 放弃 / 重派）：不再在「等你」里，但它自己那一行的饼照旧红到你看过。
   * 缺席 = 都没处理。
   */
  handled: (meta: SessionMeta) => boolean = () => false,
): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const group of groups) {
    for (const meta of group.rows) {
      const state = stateOf(meta);
      if (state === "failed" && handled(meta)) continue;
      if (state === "waiting" || state === "failed") items.push({ meta, state, workspaceId: group.workspaceId });
    }
  }
  return items.sort(
    (a, b) => (a.state === b.state ? 0 : a.state === "waiting" ? -1 : 1) || b.meta.updatedAt - a.meta.updatedAt,
  );
}

/** 新冒出来的等你（提示音只为它们响一次）：这一拍有、以前从没响过的 id */
export function freshAttention(current: readonly string[], rung: ReadonlySet<string>): string[] {
  return current.filter((id) => !rung.has(id));
}
