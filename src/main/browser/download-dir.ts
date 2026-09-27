/**
 * 「你的」tab 的下载目录生效值：设置里指定的（设置 › 浏览器），缺席 = 系统下载文件夹。
 * 下载落盘（sandbox.ts）与每轮告诉 agent（agent/ipc.ts 的 TurnDirectories）都问这里，
 * 两处不会对「下载去哪了」各说各的。
 */
import { app } from "electron";
import type { SettingsStore } from "../settings/store.ts";

export async function browserDownloadDir(settings: SettingsStore): Promise<string> {
  return (await settings.read()).browserDownloadDir ?? app.getPath("downloads");
}
