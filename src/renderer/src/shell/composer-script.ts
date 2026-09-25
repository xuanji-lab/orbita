import { dominantScript, type DominantScript } from "../features/chat/dominant-script.ts";

/**
 * 输入框此刻按哪种文字排——Composer 写到 textarea 的 `data-script` 上。纯函数。
 *
 * 用处（wafo 2026-09-25）：小学作业主题的输入框一字一格，每个字后面补 10px 字距，让汉字落在
 * 格子正中。中文里夹几个英文词还好；一整段英文就读不下去了——每个字母后面都空 10px，词间的
 * 空格和字母间距差不多宽，词形散了。所以以英文为主时取消字距（paper-themes.css）。
 *
 * - 判法沿用 dominantScript：中文里夹英文术语、路径、版本号仍算中文，照旧一字一格。
 * - 没有字母（空、纯数字 / 标点）算中文：这是中文主题的默认排法，占位文字也是中文、要按格排；
 *   dominantScript 把「没有汉字」一律算拉丁，这里不能直接用。
 * - 输入法组词期间沿用上一次的结果：拼音字母会先进 value，不冻住的话，每句中文开头的第一个
 *   词都会先按英文排一下、上屏后再跳回方格。
 */
export function composerScript(previous: DominantScript, text: string, composing: boolean): DominantScript {
  if (composing) return previous;
  if (!/\p{L}/u.test(text)) return "cjk";
  return dominantScript(text);
}
