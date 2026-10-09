/**
 * 后台会话完成提醒的纯逻辑：谁刚跑完、该不该响、要不要标未读。
 *
 * 场景（用户 2026-10-10）：在一条会话里起了长程任务，转去别的会话干活，任务跑完时
 * 界面上什么都不发生——只能隔一会儿回去看一眼。这里判定「刚跑完」与「用户此刻
 * 有没有在看它」，App 据此响提示音、给侧栏行标未读、在辅助对话图标旁弹卡片。
 *
 * 不碰 React、不碰 Audio，node --test 直接测。
 */

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

/** 加一批未读。没有新增时返回原引用（调用方据此跳过 setState）。 */
export function addUnread(unread: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (ids.every((id) => unread.has(id))) return unread;
  const next = new Set(unread);
  for (const id of ids) next.add(id);
  return next;
}

/** 看过即清。一个都没清掉时返回原引用。 */
export function clearUnread(unread: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (!ids.some((id) => unread.has(id))) return unread;
  const next = new Set(unread);
  for (const id of ids) next.delete(id);
  return next;
}
