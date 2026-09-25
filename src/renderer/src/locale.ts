import { createContext, useContext } from "react";
import type { Language } from "@shared/settings";
import { en, type Messages } from "./messages-en.ts";
import { zh } from "./messages-zh.ts";

/**
 * 界面语言。**规则在 shared 的 `effectiveLanguage`**：稿纸一档单语（小学作业恒中文、
 * 打字稿恒英文），其余主题跟语言设置走。主进程的署名语言也走同一条，这里不另写一份。
 */
export type Locale = Language;

/** `<html lang>` 的取值：CJK 字形选择（同一码位的中 / 日字形）与换行规则靠它 */
export function htmlLang(locale: Locale): string {
  return locale === "zh" ? "zh-CN" : "en";
}

export function messagesOf(locale: Locale): Messages {
  return locale === "zh" ? zh : en;
}

/** App 按解析后的主题提供；缺省英文（测试 / 树外渲染） */
export const LocaleContext = createContext<Locale>("en");

/** 当前语言的文案表。组件里用它；纯函数不读全局，由调用方把表传进去 */
export function useT(): Messages {
  return messagesOf(useContext(LocaleContext));
}
