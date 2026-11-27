/**
 * 启动收尾通知的补播队列（2026-11-27，Windows 冷启动 3.5 s → 7.9 s 的修复）。
 *
 * #565 在建主窗口之前 `await reconcileAll()`：先建会话 meta 索引、再逐个读 1000+ 个子会话的
 * 通道账本，首屏被迫等这整段小文件 I/O（8945hs 实测 reconcileAll 7.4 s = meta 索引 4.6 s +
 * 子通道扫描 2.9 s）。收尾本身不必挡首屏：它只把「上次退出时还在跑」的通道补一条终局消息。
 * 现在改成首屏之后后台跑，于是通知可能早于、也可能晚于父会话第一次 channel:list：
 * - 收尾先完成：通知留在这里，父会话第一次 list 时补播（原有语义）；
 * - 父会话先 list：记下它已在听，收尾完成时对它的通知直接广播，不再等下一次 list。
 * 每条通知只播一次。纯模块，不 import electron。
 */
import type { ChannelClosureNotice } from "./reconcile.ts";

export class StartupClosureQueue {
  private pending: ChannelClosureNotice[] | null = null;
  private readonly listened = new Set<string>();
  private readonly emit: (notices: readonly ChannelClosureNotice[]) => void;

  constructor(emit: (notices: readonly ChannelClosureNotice[]) => void) {
    this.emit = emit;
  }

  /** 后台收尾跑完：已在听的父会话立刻播，其余留着等它们第一次 list */
  resolve(notices: readonly ChannelClosureNotice[]): void {
    const now = notices.filter((notice) => this.listened.has(notice.parentId));
    this.pending = notices.filter((notice) => !this.listened.has(notice.parentId));
    if (now.length > 0) this.emit(now);
  }

  /** 父会话第一次（或又一次）channel:list：收尾已完成就补播它的，没完成就记下它在听 */
  listed(parentId: string): void {
    this.listened.add(parentId);
    if (this.pending === null) return;
    const due = this.pending.filter((notice) => notice.parentId === parentId);
    if (due.length === 0) return;
    this.pending = this.pending.filter((notice) => notice.parentId !== parentId);
    this.emit(due);
  }
}
