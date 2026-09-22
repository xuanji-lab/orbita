/**
 * 流式帧合帧器 —— 把高频小更新攒成固定节拍的整批应用。
 *
 * progress 帧的归约是纯函数、本身廉价，贵的是每次应用触发的 React 渲染；
 * agent 回答期间 delta 可密到十几毫秒一帧，渲染把主线程挤满，点击与打字
 * 只能排在流式渲染后面（2026-09-10 可感延迟的根源）。缓冲 + 定时整批
 * flush 把渲染频率封顶，主线程留出空档。
 *
 * 与具体事件类型解耦（泛型）：只负责「攒批 + 一次性交付」，攒了什么、
 * flush 时怎么应用是调用方的事。
 */
export interface ProgressCoalescer<T> {
  push(event: T): void;
  /**
   * 立刻交付攒着的帧。
   *
   * **排队中的帧不能被后来的事件赶超**：progress 进缓冲、其它事件即时应用，
   * 于是一轮末尾的 `item_finished` 还在缓冲里时，`phase: idle` 已经落地——
   * 读到的是「轮已结束但最后一条回答还是 streaming / 干脆不存在」的矛盾状态
   * （收尾扫描的解析就死在这里，2026-09-22）。应用非 progress 事件前先 flush，
   * 事件的应用顺序回到到达顺序。
   */
  flush(): void;
  /** 丢掉未 flush 的帧并停表。仅在「后面的更新不再有意义」时需要（卸载）。 */
  dispose(): void;
}

export function createProgressCoalescer<T>(
  apply: (batch: readonly T[]) => void,
  delayMs = 50,
): ProgressCoalescer<T> {
  let buffer: T[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    push(event: T): void {
      buffer.push(event);
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          const batch = buffer;
          buffer = [];
          if (batch.length > 0) apply(batch);
        }, delayMs);
      }
    },
    flush(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const batch = buffer;
      buffer = [];
      if (batch.length > 0) apply(batch);
    },
    dispose(): void {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      buffer = [];
    },
  };
}
