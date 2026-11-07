/**
 * 新手引导的翻页逻辑（纯函数，渲染组件只管画）。
 *
 * 整本引导是「章 → 页」两层，翻页按摊平后的线性序号走：上一页 / 下一页跨章连续，
 * 左侧目录点章名跳到那一章的第一页（章首页）。序号越界一律夹回首尾——第一页没有
 * 「上一页」，最后一页的「下一页」是「看完了」（由调用方关掉引导）。
 */
import type { AppSettings, ThemePreference } from "@shared/settings";
import type { ChapterId, GuideChapter, GuidePart } from "./onboarding-pages.ts";

/** 摊平后的一页：第几章、章内第几页 */
export interface GuidePosition {
  chapter: number;
  page: number;
}

export function flattenGuide(chapters: readonly GuideChapter[]): GuidePosition[] {
  return chapters.flatMap((chapter, ci) => chapter.pages.map((_, pi) => ({ chapter: ci, page: pi })));
}

/** 前后翻：越界夹回首尾 */
export function stepGuide(index: number, delta: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(total - 1, Math.max(0, index + delta));
}

/** 跳到某一章的第一页；章号不存在时原地不动 */
export function chapterStart(flat: readonly GuidePosition[], chapter: number, current: number): number {
  const found = flat.findIndex((position) => position.chapter === chapter);
  return found === -1 ? current : found;
}

export function isLastPage(index: number, total: number): boolean {
  return index >= total - 1;
}

/**
 * 进度条：当前章的步骤页一页一段（章首页不占段，同设计稿「第 11 章 · 自动化 · 开篇」时三段全灰）。
 * done = 已经翻过的段数，current = 正在看的段（章首页时为 -1）。
 */
export function chapterProgress(chapters: readonly GuideChapter[], position: GuidePosition): { segments: number; current: number } {
  const pages = chapters[position.chapter]?.pages ?? [];
  const opener = pages[0]?.kind === "opener" ? 1 : 0;
  return { segments: pages.length - opener, current: position.page - opener };
}

/**
 * 要不要在窗口起来时自动全屏弹出引导：设置真的读回来了（还没读回时手里是默认值，
 * 会把看过的人也当成第一次）、且从没看过 / 跳过过。
 */
export function shouldAutoOpenOnboarding(settingsLoaded: boolean, settings: Pick<AppSettings, "onboardingSeen">): boolean {
  return settingsLoaded && settings.onboardingSeen !== true;
}

/** 截图用哪一套：两档暗色用玄的那套，其余（浅色、纸面两档）用浅色那套 */
export function shotTheme(theme: Exclude<ThemePreference, "system">): "light" | "dark" {
  return theme === "black" || theme === "graphite" ? "dark" : "light";
}

/**
 * 正文里的 `**粗体**` 切成段：偶数段是普通字、奇数段加粗。文案表只用这一种标记，
 * 不引 Markdown 渲染器（一页两三句话，用不着）。
 */
export function boldRuns(text: string): { text: string; bold: boolean }[] {
  return text
    .split("**")
    .map((part, index) => ({ text: part, bold: index % 2 === 1 }))
    .filter((run) => run.text !== "");
}

/** 章号：目录与章首页的大号补成两位，附录没有章号（「··」） */
export function chapterNumber(chapters: readonly GuideChapter[], chapter: number): string {
  return chapters[chapter]?.part === "appendix" ? "··" : String(chapter + 1).padStart(2, "0");
}

/**
 * 设置页「新手引导」页签点某一章：全屏引导打开到那一章的章首页，返回摊平后的页序号
 * （OnboardingView 的 startAt）。从那一页起 ← 仍能翻回上一章；章 id 不存在时从头开始。
 */
export function startIndexOfChapter(chapters: readonly GuideChapter[], id: ChapterId): number {
  const chapter = chapters.findIndex((each) => each.id === id);
  return chapter === -1 ? 0 : chapterStart(flattenGuide(chapters), chapter, 0);
}

/** 章节目录按「入门篇 / 进阶篇 / 附录」分组（组内保持章序），每章带上章号：设置页签与引导左侧目录同一份 */
export function guideParts(chapters: readonly GuideChapter[]): { part: GuidePart; chapters: { id: ChapterId; no: string }[] }[] {
  return (["basics", "tools", "appendix"] as const).map((part) => ({
    part,
    chapters: chapters.flatMap((chapter, index) => (chapter.part === part ? [{ id: chapter.id, no: chapterNumber(chapters, index) }] : [])),
  }));
}
