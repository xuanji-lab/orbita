/**
 * 沙盒窗口里的键盘快捷键 → 浏览器动作。
 *
 * 为什么要自己接：应用没有自定义菜单，走的是 Electron 默认菜单，它的 Cmd+R 会刷新
 * **焦点窗口自己的 webContents**——在沙盒窗口里那是工具条页面，不是网页。所以在工具条与
 * 网页两个 webContents 的 `before-input-event` 上都先过这里，命中就 preventDefault
 * （同时挡住菜单快捷键），交给主进程执行。
 */
export type BrowserShortcut = "reload" | "back" | "forward" | "focus-address";

export interface KeyInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

export function browserShortcut(input: KeyInput, platform: NodeJS.Platform): BrowserShortcut | null {
  if (input.type !== "keyDown") return null;
  const primary = platform === "darwin" ? input.meta : input.control;
  const key = input.key.toLowerCase();
  if (key === "f5") return "reload";
  if (primary && !input.alt && key === "r") return "reload";
  if (primary && !input.alt && !input.shift && key === "l") return "focus-address";
  if (primary && !input.alt && key === "[") return "back";
  if (primary && !input.alt && key === "]") return "forward";
  // Windows / Linux 的传统写法：Alt + 左右方向键
  if (platform !== "darwin" && input.alt && !input.control && !input.meta) {
    if (key === "arrowleft") return "back";
    if (key === "arrowright") return "forward";
  }
  return null;
}
