/**
 * 窗口域 IPC 通道 —— 四层契约的第 1 层。
 *
 * 存在的唯一理由：Windows/Linux 转帧式窗口（`frame: false`）之后，最小化 / 最大化 /
 * 关闭三键由渲染层的标题栏自绘，点击要发回主进程操作 `BrowserWindow`。
 * macOS 的红绿灯是系统的，不走这里。
 */
export const windowChannels = {
  windowMinimize: "window:minimize",
  /** 最大化 / 还原二合一：按钮只有一个，按当前状态切换 */
  windowToggleMaximize: "window:toggle-maximize",
  windowClose: "window:close",
} as const;

export type WindowChannel = (typeof windowChannels)[keyof typeof windowChannels];
