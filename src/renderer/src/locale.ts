import { createContext, useContext } from "react";
import type { ThemePreference } from "@shared/settings";
import { en, type Messages } from "./messages-en.ts";
import { zh } from "./messages-zh.ts";

/** 界面语言。orbita 没有语言设置——语言由主题派生，见 `localeOfTheme` */
export type Locale = "zh" | "en";

/**
 * 解析后的主题 → 界面语言。**纯函数**。
 *
 * 只有 Copybook（小学作业）是中文：这一档本来就是中文版，Typescript 是它的
 * 英文对照；其余各档（含 system 落到的 light / black）照旧英文。不另加语言设置——
 * 多一个开关就多一种「绿格子配英文」的组合，而那正是用户说对不上格子的那一种。
 */
export function localeOfTheme(resolved: Exclude<ThemePreference, "system">): Locale {
  return resolved === "copybook" ? "zh" : "en";
}

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
