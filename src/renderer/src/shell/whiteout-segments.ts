/**
 * 输入框里哪几段英文垫修正液——Composer 镜像层的纯逻辑。
 *
 * 用处（wafo 2026-09-25）：小学作业主题的输入框是绿方格，一字一格。英文字母是半角，对不上格，
 * 疏排着压在竖格线上；给每段英文垫一条白底，像拿修正液涂过再写上去，格线露在白底上下。
 * textarea 里的字没法单独设底色，所以 Composer 在 textarea 下面垫一层同样排版的镜像，
 * 字是透明的，只把这里标出来的段画成白底（paper-themes.css 的 .composer-whiteout）。
 *
 * - 一段 = 连续的非 CJK 字符，不跨行；两头的空白不涂。段里要有字母或数字才涂——夹在中文里的
 *   「——」、“”这类标点不是英文。
 * - 输入法组词中的那一段不涂：拼音字母会先进 value，不排除的话每打一个中文词都会先闪一块白。
 * - 太长的输入（粘一大段日志）不分段：每次按键都要重排上千个 span，换来的只是装饰。
 */
export interface WhiteoutSegment {
  text: string;
  whiteout: boolean;
}

/** 组词中的范围，[start, end) 按 UTF-16 下标，与 textarea 的 selectionStart 同一套 */
export interface CompositionRange {
  start: number;
  end: number;
}

/** 超过这个长度整段不涂（见文件头） */
export const WHITEOUT_MAX_LENGTH = 20_000;

const NON_CJK_RUN = /[^\n\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]+/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function whiteoutSegments(text: string, composition?: CompositionRange): WhiteoutSegment[] {
  if (text === "") return [];
  if (text.length > WHITEOUT_MAX_LENGTH) return [{ text, whiteout: false }];
  // 先逐个下标标出要涂的位置，再按连续段切开
  const mask = new Uint8Array(text.length);
  for (const match of text.matchAll(NON_CJK_RUN)) {
    const run = match[0];
    const start = match.index + (run.length - run.trimStart().length);
    const end = match.index + run.trimEnd().length;
    if (start < end && LETTER_OR_DIGIT.test(text.slice(start, end))) mask.fill(1, start, end);
  }
  if (composition !== undefined) mask.fill(0, composition.start, composition.end);

  const segments: WhiteoutSegment[] = [];
  const push = (part: string, whiteout: boolean): void => {
    if (part === "") return;
    const last = segments.at(-1);
    if (last !== undefined && last.whiteout === whiteout) last.text += part;
    else segments.push({ text: part, whiteout });
  };
  let from = 0;
  for (let i = 1; i <= text.length; i += 1) {
    if (i < text.length && mask[i] === mask[from]) continue;
    const part = text.slice(from, i);
    if (mask[from] === 0) {
      push(part, false);
    } else {
      // 组词排除之后剩下的一截可能带着空白、或者只剩标点：空白不涂，没有字母数字的不涂
      const body = part.trim();
      const lead = part.length - part.trimStart().length;
      const whiteout = body !== "" && LETTER_OR_DIGIT.test(body);
      push(part.slice(0, lead), false);
      push(body, whiteout);
      push(part.slice(lead + body.length), false);
    }
    from = i;
  }
  return segments;
}
