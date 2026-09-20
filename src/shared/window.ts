/**
 * 窗口域 IPC 通道 —— 四层契约的第 1 层。
 *
 * 存在的唯一理由：Windows/Linux 转帧式窗口（`frame: false`）之后，最小化 / 最大化 /
 * 关闭三键由渲染层的标题栏自绘，点击要发回主进程操作 `BrowserWindow`。
 * macOS 的红绿灯是系统的，不走这里。
 *
 * 例外是 `windowTitleDoubleClick`：macOS 上也用。隐性标题栏（`titleBarStyle: "hidden"`）
 * 的拖拽区靠系统的 `performWindowDragWithEvent:` 接管 mouseDown，第二下点击经常被
 * 当成一次新的拖拽开始而不是双击，于是「双击标题栏缩放」时灵时不灵（wafo 2026-09-21：
 * 拖拽次次都认，双击超级频繁失灵）。渲染层收 DOM 的 dblclick 自己发回来，主进程按
 * 系统偏好（AppleActionOnDoubleClick）决定是缩放、最小化还是什么都不做。
 */
export const windowChannels = {
  windowMinimize: "window:minimize",
  /** 最大化 / 还原二合一：按钮只有一个，按当前状态切换 */
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
  /** 标题栏（拖拽区）被双击：主进程按平台与系统偏好决定动作 */
  windowTitleDoubleClick: "window:title-double-click",
} as const;

export type WindowChannel = (typeof windowChannels)[keyof typeof windowChannels];
