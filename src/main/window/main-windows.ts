/**
 * 主窗口集合。
 *
 * 受管浏览器的沙盒窗口立项之前，「所有窗口」就是「主窗口」，三处代码默认了这件事：
 *   1. 事件广播发给 `getAllWindows()`（agent/ipc.ts、channel/ipc.ts）——会发进沙盒窗口的工具条；
 *   2. macOS `activate` 按 `getAllWindows().length === 0` 决定要不要重开主窗口——沙盒窗口
 *      隐藏着也算一个窗口，关掉主窗口后点 Dock 就再也回不来；
 *   3. 最后一个主窗口关闭时要一并收掉沙盒窗口，否则 Windows / Linux 上隐藏的沙盒窗口
 *      让 `window-all-closed` 永远不触发，应用关不掉。
 * 三处都改问这里。
 *
 * 类只依赖最小接口，node --test 可直接加载；electron 只以 type 引入（运行时被剥掉）。
 */
import type { BrowserWindow } from "electron";

export interface TrackableWindow {
  isDestroyed(): boolean;
  once(event: "closed", listener: () => void): unknown;
}

export class MainWindows<W extends TrackableWindow> {
  private readonly windows = new Set<W>();
  private lastClosed: () => void = () => undefined;

  /** 最后一个主窗口关闭的那一刻调用（收掉沙盒窗口在这里接）。后设的覆盖先设的 */
  onLastClosed(listener: () => void): void {
    this.lastClosed = listener;
  }

  track(window: W): void {
    this.windows.add(window);
    window.once("closed", () => {
      this.windows.delete(window);
      if (this.list().length === 0) this.lastClosed();
    });
  }

  /** 活着的主窗口。已销毁但 closed 事件还没到的也排除掉 */
  list(): W[] {
    return [...this.windows].filter((window) => !window.isDestroyed());
  }
}

/** 全应用唯一的主窗口集合：index.ts 建窗时 track，广播与 activate 从这里取 */
export const mainWindows = new MainWindows<BrowserWindow>();
