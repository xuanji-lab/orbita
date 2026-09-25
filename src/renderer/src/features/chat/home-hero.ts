import type { ThemePreference } from "@shared/settings";

/**
 * 首页门面（slogan + 纸面两档的红笔批语）的纯逻辑，HomeHero.tsx 的可测内核。
 *
 * 门面按**主题**分，不按界面语言分：Light / Warm / Ink 是英文界面，slogan 却一直是中文
 * （品牌里唯一一句抒情的话）；只有 Typescript——小学作业的英文版——换成原型里的英文
 * slogan。所以这里吃解析后的主题，不吃 locale。
 */

/** 首页门面的三种样子：普通（品牌衬线一行）、小学作业（田字格 + 批语）、打字稿（英文 + 批语） */
export type HeroFace = "plain" | "copybook" | "typescript";

export const SLOGAN_ZH = "璇玑运转，诸事得序";
/** 璇玑载体谱原型「稿纸」一档英文版的 slogan（打字稿） */
export const SLOGAN_EN = "Set in motion, kept in order.";

export function heroFace(theme: Exclude<ThemePreference, "system"> | undefined): HeroFace {
  if (theme === "copybook") return "copybook";
  if (theme === "typescript") return "typescript";
  return "plain";
}

export function sloganOf(face: HeroFace): string {
  return face === "typescript" ? SLOGAN_EN : SLOGAN_ZH;
}

/** 田字格一格。标点在田字格里靠左下（手写进格子的规矩），所以要单独标出来 */
export interface SloganCell {
  char: string;
  punct: boolean;
}

/**
 * slogan 拆成一字一格。按码位拆（不按 UTF-16 单元），全角标点标为 punct。
 * 只给小学作业用；别的样子整句一行，不拆。
 */
export function sloganCells(text: string): SloganCell[] {
  return Array.from(text).map((char) => ({ char, punct: /\p{P}/u.test(char) }));
}
