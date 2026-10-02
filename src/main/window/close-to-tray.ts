/**
 * 关窗行为：Windows / Linux 上「关窗」= 收回托盘，而不是杀掉进程。
 *
 * 为什么自己接：本应用是转帧式窗口（`frame: false`，见 index.ts 的 MAC_WINDOW 分支），
 * 关闭键是我们自绘的，落到 `window.close()`，而 Electron 的默认语义是**销毁窗口**——
 * 最后一扇窗销毁 → `window-all-closed` → 非 darwin 上 `app.quit()`。于是「点个叉」
 * 等于「把正在跑的会话一起杀掉」。用户要的是：关窗之后会话继续跑，从托盘能找回来。
 *
 * darwin 不走这套：那边关窗本来就只是关窗、进程留着（点 Dock 回来），
 * 我们的闸门在那儿只会跟系统惯例打架。
 *
 * 本文件是**纯模块**（不 import electron），`node --test` 直接可加载。
 * 真正碰 Electron 的部分在 tray.ts；两处的分工是「谁做决定」与「谁碰 API」。
 */
import type { Language } from "../../shared/settings.ts";

export type CloseAction = "hide" | "close";

export interface CloseDecision {
  action: CloseAction;
  /** 这次隐藏要不要弹一次气泡提示（只在真隐藏、且从没提示过时为 true） */
  hint: boolean;
}

/**
 * 关窗闸门。两件事要记住：**这次是不是真的要退出**（`before-quit` / 系统注销会置位，
 * 那之后一律放行，否则应用关不掉），以及**提示给过没有**（气泡只给一次，别每次关窗都吵）。
 */
export class CloseGate {
  private quitting = false;
  private hinted = false;

  /** 真退出开始。`before-quit` 与 Windows 的 `session-end` 都要调 */
  beginQuit(): void {
    this.quitting = true;
  }

  decide(platform: NodeJS.Platform): CloseDecision {
    if (platform === "darwin" || this.quitting) return { action: "close", hint: false };
    const hint = !this.hinted;
    this.hinted = true;
    return { action: "hide", hint };
  }
}

/** 主窗口自己接的键。关窗只隐藏之后，「退出」必须有一条明确的键，否则只能去任务管理器杀 */
export type MainWindowShortcut = "quit";

export interface KeyInput {
  type: string;
  key: string;
  meta: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
}

export function mainWindowShortcut(input: KeyInput, platform: NodeJS.Platform): MainWindowShortcut | null {
  if (input.type !== "keyDown") return null;
  if (input.key.toLowerCase() !== "q") return null;
  if (input.alt || input.shift) return null;
  const modifier = platform === "darwin" ? input.meta : input.control;
  if (!modifier) return null;
  return "quit";
}

/** 托盘菜单与提示文案（跟界面语言走）。放这里而不是 messages-*.ts：那是渲染层的表，主进程读不到 */
export interface TrayLabels {
  show: string;
  quit: string;
  hintTitle: string;
  hintBody: string;
  tooltip: string;
}

export function trayLabels(language: Language): TrayLabels {
  if (language === "zh") {
    return {
      show: "显示主窗口",
      quit: "退出 orbita",
      hintTitle: "orbita 仍在后台运行",
      hintBody: "点托盘图标可以再打开；右键菜单里有「退出」。",
      tooltip: "orbita",
    };
  }
  return {
    show: "Show window",
    quit: "Quit orbita",
    hintTitle: "orbita is still running",
    hintBody: "Click the tray icon to reopen it; right-click to quit.",
    tooltip: "orbita",
  };
}
