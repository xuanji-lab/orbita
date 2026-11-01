/**
 * Windows 通知身份（AUMID）。安装版必须与 electron-builder 的 appId 完全一致；
 * 开发版单独命名，避免 Electron.lnk 与安装版 orbita.lnk 抢同一个通知身份。
 */
export function appUserModelIdFor(packaged: boolean): string {
  return packaged ? "com.orbita.desktop" : "com.orbita.desktop.dev";
}
