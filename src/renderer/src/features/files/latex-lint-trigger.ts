/**
 * chktex 的触发节奏（**纯逻辑**，`node --test` 覆盖）。
 *
 * 一条规则：**保存成功才问，连续保存只问最后一次**。自动保存是 1.5 秒一轮的，
 * 打字打得快时两笔保存之间可能只隔几百毫秒；每笔都起一次 chktex（一个 Perl 进程）
 * 既慢又没意义——后一笔保存的文本已经包含了前一笔。
 *
 * 所以这里只有一个「重置计时器」的动作：`request()` 会取消上一次还没到点的计时。
 * 被取消的那一次**不是失败**，只是不再需要（它要检查的文本已经被新文本取代）。
 *
 * 失败一律吞掉：chktex 是可选组件，没装时主进程回 `available:false`，通道出错时
 * 也只是这一轮没有结果——问题抽屉不该因为风格检查坏了而弹出错误。
 */
export interface LintScheduler {
  /** 排一次检查（重置上一次未到点的计时）；`delayMs` 缺省用构造时的去抖 */
  request(delayMs?: number): void;
  /** 取消还没到点的那一次（换文件 / 卸载） */
  cancel(): void;
  /** 之后不再跑（组件卸载） */
  dispose(): void;
}

/** 自动保存落定 → chktex 之间的去抖：连续保存只跑最后一次 */
export const LINT_DEBOUNCE_MS = 300;

export function createLintScheduler(run: () => void | Promise<void>, debounceMs: number = LINT_DEBOUNCE_MS): LintScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancel = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  return {
    request(delayMs: number = debounceMs): void {
      if (disposed) return;
      cancel();
      timer = setTimeout(() => {
        timer = null;
        if (disposed) return;
        try {
          // 同步抛错也要吞：这是可选组件的后台动作，不该掀翻界面
          void Promise.resolve(run()).catch(() => {});
        } catch {
          // 同上
        }
      }, Math.max(0, delayMs));
    },
    cancel,
    dispose(): void {
      disposed = true;
      cancel();
    },
  };
}
