/**
 * 设置的 IPC —— 四层契约的第 2 层。
 *
 * 除了读写文件，这里还担一件**只有主进程做得到**的事：把主题同步给 `nativeTheme`。
 * 不同步的话，用户在应用里选了暗色，窗口的 vibrancy 材质、原生目录选择器
 * 仍然按系统外观走——暗色 UI 底下压着一层亮材质，一眼就露馅。
 */
import { app, ipcMain, nativeTheme, shell } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { AppSettings, SettingsPatch } from "../../shared/settings.ts";
import { resolveNativeThemeSource } from "./native-theme.ts";
import type { SettingsStore } from "./store.ts";

export function applyNativeTheme(settings: AppSettings): void {
  nativeTheme.themeSource = resolveNativeThemeSource(settings.theme);
}

export function registerSettingsIpc(store: SettingsStore): void {
  ipcMain.handle(ipcChannels.settingsGet, () => store.read());

  ipcMain.handle(
    ipcChannels.settingsSet,
    async (_event, patch: SettingsPatch): Promise<AppSettings> => {
      const next = await store.write(patch);
      applyNativeTheme(next);
      return next;
    },
  );

  /**
   * 数据目录的绝对路径。消费者是设置 General 页的 Data directory 行——
   * 本地优先的应用，数据住哪要能一行说清。
   */
  ipcMain.handle(ipcChannels.settingsDataDir, (): string => app.getPath("userData"));

  /**
   * 在 Finder 里打开数据目录本身（同 skill/ipc.ts 的 skillReveal 一个写法与
   * 注释风格）。`shell.openPath` 失败时回一个非空字符串而不是抛错——这里要
   * throw 出去让 renderer 知道，不能吞。
   */
  ipcMain.handle(ipcChannels.settingsRevealDataDir, async (): Promise<void> => {
    const failure = await shell.openPath(app.getPath("userData"));
    // 这条消息会原样显示在设置页（英文界面），所以用英文
    if (failure !== "") throw new Error(`Couldn't open the data directory: ${failure}`);
  });
}
