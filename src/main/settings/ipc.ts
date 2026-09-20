/**
 * 设置的 IPC —— 四层契约的第 2 层。
 *
 * 除了读写文件，这里还担一件**只有主进程做得到**的事：把主题同步给 `nativeTheme`。
 * 不同步的话，用户在应用里选了暗色，窗口的 vibrancy 材质、原生目录选择器
 * 仍然按系统外观走——暗色 UI 底下压着一层亮材质，一眼就露馅。
 */
import { ipcMain, nativeTheme } from "electron";
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
}
