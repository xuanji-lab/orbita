/**
 * 后台会话完成提醒的纯逻辑：谁刚跑完、该不该响、要不要标未读、一条会话此刻的运行态是什么。
 *
 * 场景（用户 2026-10-10）：在一条会话里起了长程任务，转去别的会话干活，任务跑完时
 * 界面上什么都不发生——只能隔一会儿回去看一眼。这里判定「刚跑完」与「用户此刻
 * 有没有在看它」，App 据此响提示音、把未读写进 meta、在辅助对话图标旁弹卡片。
 *
 * 2026-10-10 二轮（用户改需求）：侧栏行首的状态饼与右下角铃铛清单都从这里的
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
 * 一条会话此刻的运行态（状态饼 + 铃铛清单共用的推导，单一真源）：
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

/** 工作区汇总的顺序：等你 > 出错 > 在跑 > 跑完（越需要你动手越靠前） */
const AGG_ORDER = ["waiting", "failed", "running", "done"] as const;

/**
 * 工作区折叠时组头上的汇总（2026-10-30）：组里各会话的运行态按档计数，
 * 只列亮着的档，顺序固定为等你 > 出错 > 在跑 > 跑完。折叠后看不到行，
 * 这一串是「里面还有东西在干活 / 在等你」的唯一信号。
 */
export function aggregateRunStates(
  states: readonly SessionRunState[],
): { state: Exclude<SessionRunState, null>; count: number }[] {
  const counts = new Map<string, number>();
  for (const state of states) if (state !== null) counts.set(state, (counts.get(state) ?? 0) + 1);
  return AGG_ORDER.filter((state) => counts.has(state)).map((state) => ({
    state,
    count: counts.get(state) ?? 0,
  }));
}

/** 铃铛清单的档位：状态饼亮着的根会话按「等你 > 未读 > 在跑」分档 */
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
 * 运行态的可读名字（状态饼的 tooltip，也是铃铛清单行尾的句子）：侧栏行与铃铛
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
