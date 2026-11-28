/**
 * 「电脑使用这块文案现在用哪种语言」（主进程侧，2026-11-28）。
 *
 * 为什么是这份小文件、而不是每个模块各自注入一个语言 getter：会出现在界面上的文案分布在
 * 十几个模块里（capability / sandbox / isolation-session / bridge-client / cdp / qemu / runtime
 * / mxc / emergency / lease / dispatch / provider），其中大多数是**抛出 / 返回错误**的那一刻
 * 就要把话说完整——那里没有 async、也不该为一句文案多绕一个参数。所以：主进程记一个**当前
 * 界面语言**，由设置这一处写进来（启动读一次、设置每次写入时再写一次），其余模块同步读。
 *
 * 缺省是 `zh`（不是 `en`）：这个模块在**没接线**时（单测、只导入了某个模块的脚本）要维持
 * 改动前的中文原文，否则一堆已有单测会因为「文案突然变英文」而红，而那不是它们要测的东西。
 * 生产里 `main/index.ts` 在窗口起来之前就接线了，所以真实运行永远不是「缺省」。
 *
 * 语言取值只认两档，与 `effectiveLanguage` / `computerUseConsentTexts` 同一套兜底：
 * `zh` → 中文，其余（含 undefined / 脏数据）→ 英文。
 */
import type { ComputerUseUiTexts } from "../../shared/computer-use-texts.ts";
import { computerUseUiTexts } from "../../shared/computer-use-texts.ts";

/** 界面语言的两档（与 shared/computer-use-texts.ts 的 zh / en 一一对应） */
export type CuLanguage = "zh" | "en";

/** `zh` 原文（未接线时的缺省）与 `en`。不认得的取值一律落到 `en`，与界面缺省一致 */
let current: CuLanguage = "zh";

/**
 * 设置里读到 / 改过的 `language` 写进来。传 undefined（设置里没有这个字段）按英文。
 *
 * 只写不读——读的一律走 `cuLanguage()` / `cuTexts()`，这样「哪份文案」只有一个答案。
 */
export function setComputerUseUiLanguage(language: string | undefined): void {
  current = language === "zh" ? "zh" : "en";
}

/** 当前界面语言（`zh` / `en`） */
export function cuLanguage(): CuLanguage {
  return current;
}

/** 当前界面语言下的那一份文案。调用点每次现取：切了语言，下一条回执就跟上 */
export function cuTexts(): ComputerUseUiTexts {
  return computerUseUiTexts(current);
}

/** 单测用：把语言复位成缺省（`zh`），避免一条测试的接线漏到下一条 */
export function resetComputerUseUiLanguageForTests(): void {
  current = "zh";
}
