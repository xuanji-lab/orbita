/**
 * 一段文字以哪种文字为主：中文（CJK）还是拉丁文。纯函数。
 *
 * 用处（wafo 2026-09-25）：Typescript 主题的正文是打字机等宽字（Courier Prime），中文落到另一套
 * 字体上。英文消息这样读很舒服；以中文为主的消息里，夹在中文当中的数字与英文是等宽打字机字、
 * 中文是比例字，两套字的节奏打架，读着难受。所以以中文为主的消息换一套中英同源的阅读字
 * （paper-themes.css 按 `data-script` 切），英文消息保留打字机字。小学作业主题的输入框也按它切字距
 * （shell/composer-script.ts）。
 *
 * 判法：一个汉字大约顶一个英文词（四五个字母），汉字数 × 3 ≥ 拉丁字母数就算以中文为主——
 * 中文句子里夹英文术语、路径、版本号都还是中文为主；英文长文里偶尔出现一两个汉字不算。
 */
export type DominantScript = "cjk" | "latin";

export function dominantScript(text: string): DominantScript {
  const cjk = text.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu)?.length ?? 0;
  if (cjk === 0) return "latin";
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return cjk * 3 >= latin ? "cjk" : "latin";
}
