/**
 * 后台会话完成提醒的纯逻辑：谁刚跑完、该不该响、要不要标未读、一条会话此刻的运行态是什么。
 *
 * 场景（用户 2026-10-10）：在一条会话里起了长程任务，转去别的会话干活，任务跑完时
 * 界面上什么都不发生——只能隔一会儿回去看一眼。这里判定「刚跑完」与「用户此刻
 * 有没有在看它」，App 据此响提示音、把未读写进 meta、在辅助对话图标旁弹卡片。
 *
 * 2026-10-10 二轮（用户改需求）：侧栏行首的三节竖条与右下角铃铛清单都从这里的
 * sessionRunState 读状态——**单一真源**，两个入口只是同一份状态的两个视图，
 * 不各算一份（各算一份迟早漂移成「侧栏说在跑、铃铛说没事」）。
 *
 * 不碰 React、不碰 Audio，node --test 直接测。
 */
import type { Messages } from "../../messages-en.ts";

/** 判定只需要槽的这两个字段——不依赖整个 SessionEntry，测试不用造全量槽 */
export interface PhaseSlot {
  phase: "idle" | "turn" | "compaction";
  queued: readonly unknown[];
}

/**
 * 上一拍在跑、这一拍落定的会话 id。
 *
 * **落定 = idle 且队列空**：idle 那拍队列里还有排队消息的话，引擎随即投递下一条，
 * 任务并没有完——这时响铃就是误报。React 把「idle → 投递下一条」合进同一次渲染时
 * 我们根本看不到中间那个 idle，同样正确。
 *
 * 上一拍不存在的槽（新建）不算：没有「在跑」的前态，就没有「跑完」。
 */
export function settledSessions(
  prev: ReadonlyMap<string, PhaseSlot>,
  next: ReadonlyMap<string, PhaseSlot>,
): string[] {
  const settled: string[] = [];
  for (const [id, entry] of next) {
    const before = prev.get(id);
    if (before === undefined || before.phase === "idle") continue;
    if (entry.phase === "idle" && entry.queued.length === 0) settled.push(id);
  }
  return settled;
}

/**
 * 完成卡上的一行：这条会话的名字、是否失败、这一轮最后写入的时刻（排序用）。
 *
 * 同拍多条落定时**一张卡列出全部**（用户裁决 2026-10-25：「多个任务完成，都要提醒
 * 才对」）。以前只弹一条——早期是取落定数组的最后一项（那个顺序来自 engine.states
 * 的 Map 迭代顺序，与谁真跑完无关，等于掷骰子），后来试过「失败优先取一条」，还是
 * 丢信息：同拍完成三个任务，用户只被告知一个。
 */
export interface CompletionNoticeEntry {
  id: string;
  /** 会话标题；空串由卡片按「新任务」占位显示 */
  title: string;
  failed: boolean;
  updatedAt: number;
}

/**
 * 完成卡的行序：**失败的在前**（出错的更该先看到），同类按 `updatedAt` 降序
 * （刚完成的在上）。不改原数组；单条原样返回、空输入返回空数组。
 *
 * `updatedAt` 打平时保留输入顺序（Array#sort 稳定）——同一批输入永远给同一个顺序。
 */
export function completionNoticeItems<T extends { failed: boolean; updatedAt: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(
    (a, b) => Number(b.failed) - Number(a.failed) || b.updatedAt - a.updatedAt,
  );
}

/**
 * 把新落定的一批 id 并进卡上已有的那批：卡还开着时后来的会话也列上去（用户 2026-10-25：
 * 「多个任务完成，都要提醒」）。没有新增时**原封不动返回原数组**（引用不变），
 * 否则每次 phase 事件都会让卡重渲染一次。
 *
 * 为什么要并而不是靠「同一次渲染里多条」：phase 事件是逐条 IPC 到的、又不进合帧器，
 * 两条会话前后脚跑完不会落在同一次 setState 里——按「同拍」算的话卡上几乎永远只有一条。
 */
export function mergeNoticeIds(current: readonly string[], incoming: readonly string[]): readonly string[] {
  const known = new Set(current);
  const added = incoming.filter((id) => !known.has(id));
  return added.length === 0 ? current : [...current, ...added];
}

export interface NoticePlan {
  /** 响提示音 */
  sound: boolean;
  /** 侧栏行标未读 + 弹卡片 */
  unread: boolean;
}

/**
 * 一条会话跑完时该做什么。
 *
 * - 正看着且窗口在前台：什么都不做——人就在跟前，结果正在眼前滚出来。
 * - 正看着但窗口不在前台（切去别的应用了）：只响，不标未读——切回来就在屏上。
 * - 没在看：响 + 标未读 + 弹卡片。
 *
 * 提示音另受设置开关管（`soundOn`）；未读与卡片不受它管——静音的人同样需要知道。
 */
export function planNotice(input: { watched: boolean; windowActive: boolean; soundOn: boolean }): NoticePlan {
  if (input.watched) return { sound: input.soundOn && !input.windowActive, unread: false };
  return { sound: input.soundOn, unread: true };
}

/**
 * 一条会话此刻的运行态（三节竖条 + 铃铛清单共用的推导，单一真源）：
 *
 * - `"running"`：在跑（1/3 蓝）——自己或任一直接子会话的 phase 不是 idle。
 *   子会话在跑算母会话在跑：侧栏只列根会话，母会话的行就是那个任务的唯一入口；
 *   行首状态槽的 git-fork 再说「是孩子在跑」这一句。
 * - `"waiting"`：在等你回复（2/3 橙）——自己或任一直接子会话挂着工具审批。
 *   子会话的审批亮在母会话那一行（同上：入口在母）。今天接的是审批，以后的
 *   「问用户问题」也走这一档。
 * - `"done"`：跑完、还没看（3/3 绿）——meta 上的未读标记（落盘，重启后还在）。
 * - `"failed"`：跑挂了、还没看（3/3 红）——未读标记带 failed。同样算未读。
 * - `null`：读完即不亮。
 *
 * 优先级 waiting > running > unread：审批挂着时 phase 还是 turn，若 running 压过
 * waiting，橙永远不亮——「在等你」是比「在跑」更具体的事实，压过它。在跑压过
 * 未读：又开了一轮就不再是「跑完」；落定后未读要么被覆盖成新值要么被清。
 */
export type SessionRunState = "running" | "waiting" | "done" | "failed" | null;

/** 推导只需要槽的这两个字段——不依赖整个 SessionEntry，测试不用造全量槽 */
export interface RunSlot {
  phase: "idle" | "turn" | "compaction";
  /** 挂着的工具审批数（0 = 没有） */
  approvals: number;
}

export function sessionRunState(input: {
  /** 会话自己的槽；没建过槽的（刚建 / 纯浏览）当 idle 空槽 */
  slot: RunSlot | undefined;
  /** 直接子会话的槽（只取一层，与 childSessions 同口径） */
  children: readonly RunSlot[];
  /** meta 上的未读标记；null / 缺席即已读 */
  unread: { at: number; failed: boolean } | null;
}): SessionRunState {
  const slots = [input.slot, ...input.children];
  if (slots.some((slot) => slot !== undefined && slot.approvals > 0)) return "waiting";
  if (slots.some((slot) => slot !== undefined && slot.phase !== "idle")) return "running";
  if (input.unread === null) return null;
  return input.unread.failed ? "failed" : "done";
}

/** 铃铛清单的档位：竖条亮着的根会话按「等你 > 未读 > 在跑」分档 */
export type NoticeTier = "waiting" | "unread" | "running";

/** 运行态 → 清单档位。null（不亮）不进清单。 */
export function noticeTierOf(state: SessionRunState): NoticeTier | null {
  if (state === "waiting") return "waiting";
  if (state === "done" || state === "failed") return "unread";
  if (state === "running") return "running";
  return null;
}

const TIER_ORDER: Readonly<Record<NoticeTier, number>> = { waiting: 0, unread: 1, running: 2 };

/**
 * 铃铛清单的排序：等你 > 未读 > 在跑，同档新的在前（at = 未读那一刻；在跑 /
 * 等你的用 updatedAt 凑同一种「最近活动」语义）。不改原数组。
 */
export function orderNoticeEntries<T extends { tier: NoticeTier; at: number }>(
  entries: readonly T[],
): T[] {
  return [...entries].sort(
    (a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier] || b.at - a.at,
  );
}

/**
 * 运行态的可读名字（竖条的 tooltip，也是铃铛清单行尾的句子）：侧栏行与铃铛
 * 清单同一套词——同一个状态在两个入口该叫同一个名字，否则像两个东西。
 */
export function runStateLabel(
  state: Exclude<SessionRunState, null>,
  t: Messages,
): string {
  if (state === "running") return t.rowStatus.running;
  if (state === "waiting") return t.rowStatus.waiting;
  if (state === "failed") return t.rowStatus.unreadFailed;
  return t.rowStatus.unread;
}
