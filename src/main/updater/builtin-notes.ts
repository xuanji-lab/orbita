/**
 * 当前版本的应用内更新说明 —— 应用内置的那一份。
 *
 * 出处是 package.json 的 `build.releaseInfo.releaseNotes`：打包时 electron-builder 把它写进
 * latest.yml（更新器与「历史版本」读的就是那份），同一份文本也随 main bundle 内联进应用
 * （electron-vite 打包 JSON import，与 releases-url.ts 同款做法）。于是**每个安装包自带
 * 「我这一版带来了什么」**：离线可用、不问 GitHub、版本号永远对得上——GitHub 只用于
 * 「历史版本」与外链（2026-10-18 用户裁决：本版说明就在 package.json 里，应用自己知道，
 * 不该依赖 GitHub）。
 *
 * 测试守着 package.json 必须写了说明（builtin-notes.test.ts）：没写的话设置页「当前版本」
 * 展开只剩一句「这一版没有更新说明」，发版前就该被拦下。
 */
import packageJson from "../../../package.json" with { type: "json" };
import type { UpdateNote } from "../../shared/updater.ts";
import { appNotesOf } from "./notes.ts";

/** 内置说明：解析口子与 latest.yml 同一个（appNotesOf，只认纯文本） */
export function builtinNotes(): readonly UpdateNote[] | null {
  return appNotesOf(packageJson.build.releaseInfo.releaseNotes);
}
