/**
 * 无状态轮的占坑-收尾骨架 —— 从 runtime.ts 抽出只为可测（runtime 本体被
 * parentPort 守卫钉死在 utility 进程里，node --test 加载即退出；同款先例见
 * model-registration.ts 的文件头注释）。
 *
 * 三个不变量（B2 无状态化的核心正确性主张，测试盖住）：
 *
 * 1. **先占坑再异步 open**：open 是几百毫秒的异步，期间会让渡事件循环——不先
 *    占坑的话，同一会话的 interrupt 会在 open 期间到达、看不到坑、再开一本同样
 *    的 pi JSONL，两个 AgentSession 写同一份本子（记录写坏，修不回来）。
 *
 * 2. **open 期间到达的 abort 记账**，open 一完成立刻兑现——「发送后几百毫秒内
 *    点停止」不该因为开机竞态被吞掉。
 *
 * 3. **收尾序**：退订 → dispose（未被外部直杀时）→ 出表 → settled 回调。
 *    settled（runtime 用它发 phase idle）一定晚于出表——renderer 收到 idle 时
 *    本轮已完全收尾，排队投递不会撞 already running。
 *    **退订与 dispose 各自兜异常**：它们是 pi 对象上的清理动作，抛错是它们的自由；
 *    不兜的话出表与 settled 都不会执行，这条会话就**永久报废**——界面永远转着
 *    Responding、停止按钮找得到坑却停不下任何东西、下一次发送直接撞 already running。
 *    清理失败只该丢掉清理本身，不该丢掉「这一轮结束了」这个事实。
 */

/** 一轮要管的三个对象面：abort / dispose 是 pi session 的，unsubscribe 是退订闭包。 */
export interface CycleParts {
  abort(): void;
  dispose(): void;
  unsubscribe(): void;
}

/** running 表里的一条：open 完成前 opened 为 null（占坑期）。 */
export interface CycleSlot<P extends CycleParts> {
  abortRequested: boolean;
  /** dispose 命令已直接杀过对象：收尾跳过二次 dispose（退订与出表仍做） */
  disposed: boolean;
  /**
   * 被 interrupt / compact 抢跑：收尾**不发 settled**——下一轮紧接着开，
   * 中间没有「空闲」可投递。旧轮的 settled（phase idle）若在这里逃逸，
   * renderer 会立刻投递队首，撞上新轮的 already running，排队项丢失
   * （2026-09-11 B 验收复现）。普通 abort（stop）不设它——用户按停止
   * 就是要它空闲、让队列接着投递。
   */
  preempted: boolean;
  opened: P | null;
  /** 整轮生命周期（open → 跑 → 清理）。抢跑（interrupt / compact）前 await 它 */
  lifecycle: Promise<void>;
}

export function startCycle<P extends CycleParts>(
  running: Map<string, CycleSlot<P>>,
  id: string,
  open: () => Promise<P>,
  run: (opened: P) => Promise<unknown>,
  onSettled: () => void,
): Promise<void> {
  if (running.has(id)) {
    throw new Error(`session ${id} is already running`);
  }
  const slot: CycleSlot<P> = {
    abortRequested: false,
    disposed: false,
    preempted: false,
    opened: null,
    lifecycle: Promise.resolve(),
  };
  running.set(id, slot);
  slot.lifecycle = (async () => {
    try {
      const opened = await open();
      slot.opened = opened;
      if (slot.abortRequested) opened.abort();
      await run(opened);
    } finally {
      try {
        slot.opened?.unsubscribe();
      } catch (cause) {
        console.error(`[turn-cycle] 退订失败（不影响收尾）session=${id}`, cause);
      }
      try {
        if (!slot.disposed && slot.opened !== null) slot.opened.dispose();
      } catch (cause) {
        console.error(`[turn-cycle] dispose 失败（不影响收尾）session=${id}`, cause);
      }
      // 这两行无条件执行：轮结束这个事实不能被清理动作的失败吞掉
      running.delete(id);
      if (!slot.preempted) onSettled();
    }
  })();
  return slot.lifecycle;
}

/**
 * 停当前轮：对象还没 open 出来就只记账（open 完成时 startCycle 兑现）。没在跑静默。
 * `{ preempt: true }` = 抢跑（interrupt / compact）：旧轮收尾不发 settled——
 * 下一轮紧接着开，中间没有「空闲」；普通 stop 不带它。
 */
export function abortCycle<P extends CycleParts>(
  running: Map<string, CycleSlot<P>>,
  id: string,
  options?: { preempt?: boolean },
): void {
  const slot = running.get(id);
  if (slot === undefined) return;
  slot.abortRequested = true;
  if (options?.preempt === true) slot.preempted = true;
  slot.opened?.abort();
}

/**
 * 删除会话的直杀：pi 的 dispose 自己会 abort 全部在飞工作，正在跑的轮被删也成立。
 * 标记 disposed 后收尾跳过二次 dispose；返回 lifecycle 供等待完全收尾。
 * 没在跑返回已结的 promise（没什么可释放的）。
 */
export function killCycle<P extends CycleParts>(
  running: Map<string, CycleSlot<P>>,
  id: string,
): Promise<void> {
  const slot = running.get(id);
  if (slot === undefined) return Promise.resolve();
  slot.opened?.dispose();
  slot.disposed = true;
  return slot.lifecycle;
}
