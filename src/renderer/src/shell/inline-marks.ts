/**
 * 一行标题里的行内 markdown（章节标题、首页卡那一句，2026-10-30）。
 *
 * 章节标题是 agent 说的话的第一行（turn-process.ts 的 firstLine）：行首的井号、列表符剥掉了，
 * 行内的 `代码` 与 **粗体** 记号没剥，界面按纯文本画，反引号与星号就原样露出来
 * （「先看 `Sidebar.tsx` 里分组怎么渲染」）。这里拆成段：反引号包着的是代码段（等宽画），
 * 粗体记号剥掉——标题本身是一行注脚，不再加粗。不配对的记号原样留着，不猜。
 *
 * 纯模块：不 import React，可被 node --test 直接加载。
 */
export type InlineMark = { kind: "text"; text: string } | { kind: "code"; text: string };

const CODE = /`([^`]+)`/g;
const STRONG = /\*\*([^*]+)\*\*|__([^_]+)__/g;

export function inlineMarks(line: string): InlineMark[] {
  const marks: InlineMark[] = [];
  const pushText = (raw: string): void => {
    const text = raw.replace(STRONG, (_, a: string | undefined, b: string | undefined) => a ?? b ?? "");
    if (text === "") return;
    const last = marks.at(-1);
    if (last?.kind === "text") last.text += text;
    else marks.push({ kind: "text", text });
  };
  let from = 0;
  for (const match of line.matchAll(CODE)) {
    const at = match.index ?? 0;
    pushText(line.slice(from, at));
    marks.push({ kind: "code", text: match[1] ?? "" });
    from = at + match[0].length;
  }
  pushText(line.slice(from));
  return marks;
}

/** 剥成纯文本（title / aria 用）：代码段去掉反引号，粗体去掉记号 */
export function inlinePlain(line: string): string {
  return inlineMarks(line)
    .map((mark) => mark.text)
    .join("");
}
