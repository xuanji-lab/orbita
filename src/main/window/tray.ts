/**
 * 托盘图标与它的菜单——关窗之后唯一能把窗口找回来的地方（Windows / Linux）。
 *
 * 决策全在 close-to-tray.ts（纯模块、有测试），这里只做两件事：建托盘、
 * 把「窗口的 close 事件」接到那个决策上。**没有托盘就不藏窗口**：藏了却找不回来
 * 比直接退出更糟，所以图标缺失时这里直接不安装，关窗保持原语义（退出）。
 */
import { Menu, Tray, app, nativeImage } from "electron";
import type { BrowserWindow, NativeImage } from "electron";
import { join } from "node:path";
import type { Language } from "../../shared/settings.ts";
import { CloseGate, mainWindowShortcut, trayLabels } from "./close-to-tray.ts";

/** 托盘图放在 build/ 里，打包时由 electron-builder 的 extraResources 复制到 resources/ */
export function loadTrayIcon(): NativeImage | null {
  const path = app.isPackaged
    ? join(process.resourcesPath, "tray.png")
    : join(app.getAppPath(), "build", "tray.png");
  const image = nativeImage.createFromPath(path);
  return image.isEmpty() ? null : image;
}

export interface TrayOptions {
  window: BrowserWindow;
  icon: NativeImage;
  language: Language;
  /** 隐藏的那一刻重读语言：用户中途换了界面语言，托盘菜单跟着走（不为这件事另开推送通道） */
  readLanguage: () => Promise<Language>;
}

export interface AppTray {
  /** 真退出开始：之后窗口的 close 一律放行 */
  beginQuit(): void;
  /** 必须销毁，否则进程退不掉（Electron 的经典坑） */
  destroy(): void;
  refresh(language: Language): void;
  hint(): void;
}

export function installCloseToTray(options: TrayOptions): AppTray {
  const gate = new CloseGate();
  const { window } = options;
  const tray = new Tray(options.icon);
  let labels = trayLabels(options.language);

  const showWindow = (): void => {
    if (window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  };

  const rebuildMenu = (): void => {
    tray.setToolTip(labels.tooltip);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: labels.show, click: showWindow },
        { type: "separator" },
        { label: labels.quit, click: () => app.quit() },
      ]),
    );
  };

  tray.on("click", showWindow);
  tray.on("double-click", showWindow);
  rebuildMenu();

  const hint = (): void => {
    // displayBalloon 只有 Windows 有；别的平台不提示也不影响用（托盘图标本身就在）
    if (process.platform !== "win32") return;
    tray.displayBalloon({ title: labels.hintTitle, content: labels.hintBody, icon: options.icon });
  };

  window.on("close", (event) => {
    const decision = gate.decide(process.platform);
    if (decision.action === "close") return;
    event.preventDefault();
    window.hide();
    if (decision.hint) hint();
    void options
      .readLanguage()
      .then((language) => {
        labels = trayLabels(language);
        rebuildMenu();
      })
      .catch(() => undefined);
  });

  // Ctrl+Q（darwin 是 Cmd+Q）：关窗只隐藏，退出必须另有一条明确的键
  window.webContents.on("before-input-event", (event, input) => {
    if (mainWindowShortcut(input, process.platform) !== "quit") return;
    event.preventDefault();
    app.quit();
  });

  return {
    beginQuit: () => gate.beginQuit(),
    destroy: () => tray.destroy(),
    refresh: (language) => {
      labels = trayLabels(language);
      rebuildMenu();
    },
    hint,
  };
}
