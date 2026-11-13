/**
 * 「文件管理器」与「废纸篓」在各平台的叫法。文案里的「在访达中显示」「移到废纸篓」
 * 是 macOS 口径，Windows 上叫资源管理器 / 回收站（2026-11-07 Windows 验收：技能详情页
 * 在 Windows 上照样显示「访达」「废纸篓」）。平台判定走 preload 暴露的 `api.platform`
 * （= `process.platform`），这里只把它归成三类，文案表按类取词。
 */
export type FileManagerKind = "finder" | "explorer" | "files";

export function fileManagerKind(platform: string): FileManagerKind {
  if (platform === "darwin") return "finder";
  if (platform === "win32") return "explorer";
  return "files";
}

/** 「在 X 中显示」按钮的字（文案表按语言各取一个） */
export function zhRevealLabel(kind: FileManagerKind): string {
  if (kind === "finder") return "在访达中显示";
  if (kind === "explorer") return "在资源管理器中显示";
  return "在文件管理器中显示";
}

export function enRevealLabel(kind: FileManagerKind): string {
  if (kind === "finder") return "Show in Finder";
  if (kind === "explorer") return "Show in Explorer";
  return "Show in File Manager";
}

/** 系统「垃圾桶」的名字：macOS 废纸篓，Windows 回收站，Linux 桌面也叫回收站 / Trash */
export function zhTrashName(kind: FileManagerKind): string {
  return kind === "finder" ? "废纸篓" : "回收站";
}

export function enTrashName(kind: FileManagerKind): string {
  return kind === "explorer" ? "Recycle Bin" : "Trash";
}
