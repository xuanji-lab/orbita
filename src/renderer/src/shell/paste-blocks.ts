/**
 * 句中粘贴块——大段粘贴在输入框里的胶囊语义（方案 C，2026-10-09 用户裁决）。
 *
 * 一段大粘贴在草稿里有两个形态：
 * - **收起**：正文里的一颗胶囊，文本是 token（如 `[粘贴 1 · 42 行]`）。token 就是
 *   textarea 里的真实文字——镜像层把它包成 chip（与 `/skill:` 同一机制），全文存在
 *   粘贴块里（`ComposerPasteBlock.text`），永不截断；
 * - **展开**：token 换回全文，与正文同字体、可直接编辑，镜像层只给这段区间铺浅底色，
 *   区间头上浮一枚「N 行 · 收起」小标签，点标签收起回胶囊。
 *
 * 全文**不落草稿字符串**（收起时），所以 token ↔ 块的对应关系靠 seq：同一草稿内
 * 唯一的序号，token 里带着它。块的生命周期比 token 柔和——删掉 chip、Ctrl+Z
 * 撤销展开都会让 token 消失又回来，块**不跟着立刻删**（撤销要能完整还原），
 * 只在发送 / 清草稿时结算：没有 token 也没有区间的块不进消息。
 *
 * 纯函数：不 import React，`node --test` 直接加载。token 的显示格式在 messages
 * 两语表的 `composer.pasteToken`；这里的解析两种语言都认（切换语言后旧 token
 * 仍可解析）。区间伸缩的边界约定见 `repositionRange`。
 */
import { pastedBlockOf, pastedTextSize } from "../../../shared/prompt-attachments.ts";

/** 草稿里的一段粘贴块（全文的存放处；收起 / 展开两个形态都指它） */
export interface ComposerPasteBlock {
  id: string;
  /** token 序号：同一草稿内唯一，token 靠它找到块。只增不复用（撤销还原不怕撞） */
  seq: number;
  /** 收起态的全文。展开后以区间里的现文为准（收起时写回），此字段作废 */
  text: string;
  /** 收起态的行数（token 显示用）。展开后从区间现文算 */
  lines: number;
  /** 展开区间 [start, end)，UTF-16 下标与 textarea 的 selectionStart 同一套；
   *  null = 收起（或展开内容被删空）。空区间一律折回 null——空块没有可画的区间 */
  range: { start: number; end: number } | null;
}

/**
 * token 的两种语言形态。与 messages 的 `composer.pasteToken` **逐字相同**——
 * 生成走文案表（i18n 一处真源），这里只认形状；两语都认是为了语言切换后
 * 旧 token 仍然可解析（粘贴块跨语言设置切换存活）。
 */
const PASTE_TOKEN =
  /\[(?:粘贴|Pasted)\s+(\d+)\s*·\s*(\d+)(?:\s*行|\s*lines)?\s*\]/g;

/** 原文里的一个粘贴 token：位置 + seq + 行数（行数只是显示，查找只认 seq） */
export interface PasteToken {
  start: number;
  end: number;
  seq: number;
  lines: number;
}

/** 扫出全文里所有形状合法的粘贴 token（不校验有没有块认领——那是调用方的事） */
export function parsePasteTokens(text: string): PasteToken[] {
  const out: PasteToken[] = [];
  const pattern = new RegExp(PASTE_TOKEN.source, "g");
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(text)) !== null) {
    out.push({
      start: hit.index,
      end: hit.index + hit[0].length,
      seq: Number(hit[1]),
      lines: Number(hit[2]),
    });
  }
  return out;
}

/** Backspace 整删判定：光标正贴在 token 尾上时返回它（与 chipRangeBefore 同一形状） */
export function pasteTokenBefore(text: string, caret: number): PasteToken | null {
  return parsePasteTokens(text).find((token) => token.end === caret) ?? null;
}

/** Delete 整删判定：光标正贴在 token 头上时返回它 */
export function pasteTokenAfter(text: string, caret: number): PasteToken | null {
  return parsePasteTokens(text).find((token) => token.start === caret) ?? null;
}

/** 在 caret 处插入 token（粘贴那一刻的落点：鼠标光标在哪，粘贴就在哪） */
export function insertPasteToken(text: string, caret: number, token: string): string {
  const at = Math.max(0, Math.min(caret, text.length));
  return text.slice(0, at) + token + text.slice(at);
}

/**
 * 展开：token 位置换回全文。返回新文本与全文所在区间（新区间就落在原 token 的
 * 位置上）。调用方负责同步块状态（range ← 返回值）。
 */
export function expandPasteToken(
  text: string,
  token: PasteToken,
  fullText: string,
): { text: string; range: { start: number; end: number } } {
  return {
    text: text.slice(0, token.start) + fullText + text.slice(token.end),
    range: { start: token.start, end: token.start + fullText.length },
  };
}

/**
 * 收起：区间换回 token（区间里的现文可能已被编辑过，调用方先取走存回块）。
 * 光标语义由调用方处理（execCommand 之后天然落在 token 尾）。
 */
export function collapsePasteRange(
  text: string,
  range: { start: number; end: number },
  token: string,
): string {
  return text.slice(0, range.start) + token + text.slice(range.end);
}

/**
 * 单次编辑的差分：旧文本与新文本的公共前后缀，框出被改写的那一段。
 * textarea 的每次 input（打字 / 删除 / 粘贴 / 听写）都是一处改动，React 只给
 * 新旧两个字符串——前后缀夹逼就是唯一的信息来源。
 */
function diffSpan(oldText: string, newText: string): { prefix: number; oldEnd: number; insertLength: number } {
  const limit = Math.min(oldText.length, newText.length);
  let prefix = 0;
  while (prefix < limit && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  return { prefix, oldEnd: oldText.length - suffix, insertLength: newText.length - prefix - suffix };
}

/**
 * 区间随一次编辑伸缩。约定（每条都被用例钉住）：
 * - 编辑在区间前 / 后：整体平移（delta）；
 * - 在区间**内部**打字 / 删词：区间跟着伸 / 缩（这段是粘贴进来的，接着写算它的）；
 * - 纯插入**正贴区间头**：算区间外的（在粘贴段前面写字，不是续写它）；
 *   正贴区间**尾**：算区间内的（贴着末尾续写是接着粘贴段写）；
 * - 区间的头 / 尾被跨选删除吃掉：夹到编辑点；整段被删空 → 返回 null（调用方把
 *   块折回收起态——没有 token、没有区间的块就此沉默，发送时结算掉）。
 */
export function repositionRange(
  oldText: string,
  newText: string,
  range: { start: number; end: number },
): { start: number; end: number } | null {
  const { prefix, oldEnd, insertLength } = diffSpan(oldText, newText);
  const delta = newText.length - oldText.length;
  // 纯插入正贴某个边界时，这个边界点随插入后移——区间头因此落在插入物之前
  // （区间外），区间尾落在插入物之后（区间内，续写粘贴段）
  const mapPoint = (point: number): number => {
    if (point < prefix) return point;
    if (point === prefix) return oldEnd === prefix ? point + insertLength : point;
    if (point < oldEnd) return prefix;
    return point + delta;
  };

  const start = mapPoint(range.start);
  const end = mapPoint(range.end);
  return end > start ? { start, end } : null;
}

/**
 * 草稿文本变了之后，把所有展开区间搬到新文本上，并做形态对账：
 * - 区间被删空 → 折回收起（range = null）；
 * - 区间内容恰好是**自己的 token**（展开被 Ctrl+Z 撤销的签名：token 原样回来了）→
 *   折回收起，块里存的全文不动——撤销一步正好还原到展开前的世界。
 */
export function repositionBlocks(
  oldText: string,
  newText: string,
  blocks: readonly ComposerPasteBlock[],
): ComposerPasteBlock[] {
  if (blocks.length === 0) return [];
  return blocks.map((block) => {
    if (block.range === null) return block;
    const moved = repositionRange(oldText, newText, block.range);
    if (moved === null) return { ...block, range: null };
    const inside = newText.slice(moved.start, moved.end);
    const own = parsePasteTokens(inside);
    if (own.length === 1 && own[0].seq === block.seq && own[0].start === 0 && own[0].end === inside.length) {
      return { ...block, range: null };
    }
    return { ...block, range: moved };
  });
}

/**
 * 发送组装：草稿 → 模型文本。收起的 token 就地换成 `<pasted-text>` 块——
 * **位置保留**（胶囊在哪，块就在哪）；展开的区间本就是正文，原样通过；
 * 没人认领的 token（手打的、块已沉默的）原样保留。块与块之间用空行分开
 * （与 composePromptText 的拼法同族），空段跳过——token 在句中时前后各补
 * 一个空行，转录侧按空行拆块就能把它认出来。
 */
export function assemblePasteDraft(text: string, blocks: readonly ComposerPasteBlock[]): string {
  const bySeq = new Map(blocks.map((block) => [block.seq, block]));
  const parts: string[] = [];
  let last = 0;
  for (const token of parsePasteTokens(text)) {
    const block = bySeq.get(token.seq);
    if (block === undefined) continue;
    parts.push(text.slice(last, token.start));
    parts.push(pastedBlockOf(block.text));
    last = token.end;
  }
  parts.push(text.slice(last));
  return parts.filter((part) => part !== "").join("\n\n");
}

/**
 * 已发送文本 → 草稿（撤回 / 回退放回输入框用）：`<pasted-text>` 块换回 token，
 * 位置不动。组装时在块两侧垫的空行剥掉一层（自己垫的才是这一层）；正文里的
 * 空行是用户自己敲的，不在剥的范围。seq 从 seqBase 续（不与草稿里已有的撞）。
 */
export function draftFromSentText(
  text: string,
  seqBase: number,
  tokenOf: (seq: number, lines: number) => string,
): { draft: string; blocks: { text: string; lines: number }[] } {
  const pattern = /(?:\n\n)?<pasted-text>\r?\n([\s\S]*?)\r?\n<\/pasted-text>(?:\n\n)?/g;
  const blocks: { text: string; lines: number }[] = [];
  let draft = "";
  let last = 0;
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(text)) !== null) {
    const body = hit[1] ?? "";
    const { lines } = pastedTextSize(body);
    const seq = seqBase + blocks.length + 1;
    draft += text.slice(last, hit.index);
    draft += tokenOf(seq, lines);
    blocks.push({ text: body, lines });
    last = hit.index + hit[0].length;
  }
  draft += text.slice(last);
  return { draft, blocks };
}
