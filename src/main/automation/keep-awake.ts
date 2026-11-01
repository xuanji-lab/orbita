/**
 * 「有任务在跑时阻止系统睡眠」（实验功能 automation 的设置项 `automationKeepAwake`，默认关）。
 *
 * 只在**有自动化运行正在执行**期间拦住系统挂起，运行全部结束就放开；屏幕照样可以关。
 * 用的是 Electron 自己的 `powerSaveBlocker.start('prevent-app-suspension')`——应用自己的 API
 * （用户 2026-10-31 明确同意），不是 caffeinate / pmset，也不碰显示器与锁屏。
 *
 * 纯核 + 注入：blocker 与设置读取都是注入的，测试用假 blocker 验证「何时拦、何时放」，
 * 不真去影响系统睡眠。同步请求串行化：设置读取是异步的，两次连续的 sync 不能交错成「先放后拦」的错序。
 */
export interface PowerBlocker {
  start(type: "prevent-app-suspension"): number;
  stop(id: number): void;
}

export class KeepAwake {
  private readonly blocker: PowerBlocker;
  private readonly readEnabled: () => Promise<boolean>;
  /** 拦住 / 放开的那一刻回调（主进程往 dev 终端记一行：「为什么 Mac 没睡」要有处可查） */
  private readonly onChange: ((holding: boolean) => void) | undefined;
  private held: number | null = null;
  /** 最近一次告知的在跑运行数：排队中的 sync 读它，不读调用时的快照 */
  private running = 0;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(blocker: PowerBlocker, readEnabled: () => Promise<boolean>, onChange?: (holding: boolean) => void) {
    this.blocker = blocker;
    this.readEnabled = readEnabled;
    this.onChange = onChange;
  }

  /** 正在执行的运行数变了（或开关变了，重新按当前数对一次） */
  sync(runningCount?: number): Promise<void> {
    if (runningCount !== undefined) this.running = runningCount;
    const task = this.chain.then(async () => {
      const want = this.running > 0 && (await this.readEnabled());
      if (want && this.held === null) {
        this.held = this.blocker.start("prevent-app-suspension");
        this.onChange?.(true);
      } else if (!want && this.held !== null) {
        this.blocker.stop(this.held);
        this.held = null;
        this.onChange?.(false);
      }
    });
    this.chain = task.catch(() => undefined);
    return task;
  }

  /** 现在是不是拦着（测试与诊断用） */
  isHolding(): boolean {
    return this.held !== null;
  }

  /** 应用退出：无条件放开（不读设置） */
  release(): void {
    this.running = 0;
    if (this.held !== null) {
      this.blocker.stop(this.held);
      this.held = null;
      this.onChange?.(false);
    }
  }
}
