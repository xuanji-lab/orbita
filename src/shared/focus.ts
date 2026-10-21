/**
 * 专注模式契约 —— IPC 四层的第 1 层。
 *
 * 专注模式回答两件事：**这个工作区此刻改了什么**（左栏文件树的 U / M 标记，
 * 来源 = git 只读命令，与审查面板同一套 git-source），以及**时间到了怎么叫人**
 * （系统通知由主进程发——renderer 的 sandbox 里没有 Electron Notification；
 * 提示音不走这里，在 renderer 放，与完成提醒同一声）。
 *
 * 专注状态本身**不跨进程**：计时活在 renderer 内存里（用户裁决：关掉应用重开
 * = 已结束），主进程不记专注，重启后自然归零。
 */

/** 工作区改动的单条。U = 未跟踪的新文件（含暂存过的新增），M = 已修改 */
export type FocusChangeKind = "U" | "M";

export interface FocusChangeEntry {
  /** 仓库相对路径（正斜杠，git 输出原样） */
  path: string;
  kind: FocusChangeKind;
  /** 行级统计（同审查面板 numstat 口径）；binary 没有行级统计 */
  added: number;
  removed: number;
  binary: boolean;
}

/** `focus:changes` 的回执。空态与错误分开说（同 review:list 的口径：没有改动 ≠ 出不了结果） */
export type FocusChanges =
  | { kind: "ok"; branch: string | null; entries: FocusChangeEntry[] }
  | { kind: "empty"; reason: FocusChangesEmptyReason }
  | { kind: "error"; message: string };

export type FocusChangesEmptyReason =
  /** 这个工作区目录不是 git 仓库（U / M 只是 git 的语言，非 git 目录不标，如实说明） */
  | "not-repo"
  /** 机器上没有 git */
  | "no-git";

/** `focus:notify-done` 的请求：专注时间到，主进程发一条系统通知（点按聚焦窗口） */
export interface FocusNotifyRequest {
  title: string;
  body: string;
}
