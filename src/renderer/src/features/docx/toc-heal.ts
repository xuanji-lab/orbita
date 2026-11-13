/**
 * 目录页码自愈（issue #276）—— 纯函数，`node --test` 直接可测（与 docx-change.ts 同一分工：
 * 判定与计划在这里，React / ProseMirror / 引擎交给 DocxView.tsx）。
 *
 * 为什么要这一刀：docx 的目录条目不是普通文字，而是 PAGEREF 域（Word 形态）或一段静态
 * 文字（pandoc 等导出工具的形态）。域里缓存着上次算出的页码；应用内改字让分页变了以后，
 * 屏幕上的正文已经翻页，目录里还是旧数字——存出去的文档打开就是错页码，直到有人手动更新域。
 *
 * 页码从哪来：**屏幕上那一份 layout**（`getEditorRef().getLayout()`），不另算一套。
 * 书签位置取自 ProseMirror 的 bookmarkBoundary 节点，位置 → 页码取自
 * `layout.pages[*].fragments[*].pmStart/pmEnd`（覆盖该位置的最早一页）。这与 folio 自己
 * 解析 PAGEREF 时用的 `buildBookmarkPageMap` 是同一份事实，所以写进去的数字与屏幕上一致。
 *
 * 写回什么：**只改域缓存（displayText），不动域指令**。`PAGEREF _Toc123 \h` 原样保留，
 * 格式开关（`\* roman` 之类）交给 folio 自己的 `evaluateFieldInstruction` 生成显示串；
 * 生成不出来（`\p` 位置开关、书签解析不到、字段结构异常）就**不覆盖旧值**，只计数。
 *
 * 静态目录（没有域）走退化路径：TOC1..9 段落尾部那段纯文本数字 → 用同名标题所在页替换。
 * 这条只能对齐数字，它不是域，用户在 Word 里按 F9 也不会重算它——界面上要说明这一点。
 */

import { evaluateFieldInstruction } from "@stll/folio-core/fields/evaluateField";

/** 判定只需要这几种事实；用最小接口而不是 ProseMirror 的 Node，测试不必造 schema */
export interface TocHealNode {
  type: { name: string };
  attrs: Record<string, unknown>;
  /** 文字节点才有（ProseMirror 的 `node.text`） */
  text?: string | null;
  forEach: (fn: (node: TocHealNode, offset: number) => void) => void;
}

/** 只用到页码与片段覆盖范围，`Layout` 的其余字段与本判定无关 */
export interface TocHealLayout {
  pages: readonly {
    number: number;
    fragments: readonly { pmStart?: number | null; pmEnd?: number | null }[];
  }[];
}

export interface TocBookmarkFact {
  name: string;
  /** 书签起点在文档里的位置 */
  pos: number;
}

export interface TocFieldFact {
  pos: number;
  instruction: string;
  displayText: string;
}

export interface TocHeadingFact {
  /** 归一化之后的标题文字（去掉所有空白） */
  text: string;
  /** 段落起始位置（页从 `pos + 1` 算，落在段内） */
  pos: number;
}

export interface TocStaticFact {
  /** 尾部页码数字在文档里的范围 `[from, to)` */
  from: number;
  to: number;
  /** 原来的数字原文 */
  before: string;
  /** 去掉尾部数字后的条目文字（已归一化） */
  title: string;
}

export interface TocFacts {
  bookmarks: TocBookmarkFact[];
  fields: TocFieldFact[];
  headings: TocHeadingFact[];
  staticEntries: TocStaticFact[];
}

export type TocHealOp =
  | { kind: "field"; pos: number; displayText: string }
  | { kind: "text"; from: number; to: number; text: string };

export interface TocHealPlan {
  /** 要改的条目；顺序不保证（写回时由 `applyTocHeal` 从后往前改） */
  ops: TocHealOp[];
  /** 检查过的 PAGEREF 域数 / 静态目录条目数 */
  fields: number;
  staticEntries: number;
  /** 真正要改的条数 */
  changed: number;
  /** 静态目录里要改的条数（界面据此提示「用 Word 打开后转成域更稳」） */
  staticChanged: number;
  /** 算不出页码、保留旧值的条数 */
  missed: number;
}

/** 段落 / 文字节点的接口：写回时只需要这两件事 */
export interface TocHealTr {
  doc: { nodeAt: (pos: number) => { attrs: Record<string, unknown> } | null };
  setNodeMarkup: (pos: number, type: undefined, attrs: Record<string, unknown>) => unknown;
  insertText: (text: string, from: number, to: number) => unknown;
}

/** 标题归一化：只去空白。两处的空白本来就可能是制表符 / 全角空格拼出来的 */
function normalize(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 段落（或任意节点子树）里的文字；域是叶子原子，没有文字，自然不会混进标题 */
function textOf(node: TocHealNode): string {
  if (node.type.name === "text") return typeof node.text === "string" ? node.text : "";
  let out = "";
  node.forEach((child) => {
    out += textOf(child);
  });
  return out;
}

function isHeadingParagraph(attrs: Record<string, unknown>): boolean {
  const styleId = attrs["styleId"];
  if (typeof styleId === "string" && /^Heading[1-9]$/i.test(styleId)) return true;
  const outline = attrs["outlineLevel"];
  if (typeof outline === "object" && outline !== null) {
    return (outline as { kind?: unknown }).kind === "heading";
  }
  return false;
}

function isTocEntryParagraph(attrs: Record<string, unknown>): boolean {
  const styleId = attrs["styleId"];
  return typeof styleId === "string" && /^TOC[1-9]$/i.test(styleId);
}

function isPageRefField(attrs: Record<string, unknown>): boolean {
  if (attrs["fieldType"] === "PAGEREF") return true;
  // 引擎解析不出类型时（fieldType 落到 UNKNOWN）仍按指令认一次：指令是域的真相
  const instruction = attrs["instruction"];
  return typeof instruction === "string" && /^\s*PAGEREF\b/i.test(instruction);
}

/**
 * 清点一份文档里的四类事实：书签、PAGEREF 域、标题段落、静态目录条目。
 * 只读，不改文档。
 */
export function collectTocFacts(doc: TocHealNode): TocFacts {
  const facts: TocFacts = { bookmarks: [], fields: [], headings: [], staticEntries: [] };
  const bookmarkNames = new Set<string>();

  const walk = (node: TocHealNode, pos: number): void => {
    const attrs = node.attrs ?? {};
    if (attrs["type"] === "start" && typeof attrs["name"] === "string" && attrs["name"] !== "") {
      const name = attrs["name"];
      // 同名书签取第一个起点：与 folio 解析 PAGEREF 的口径一致
      if (!bookmarkNames.has(name)) {
        bookmarkNames.add(name);
        facts.bookmarks.push({ name, pos });
      }
    }
    if (node.type.name === "field" && isPageRefField(attrs)) {
      const instruction = typeof attrs["instruction"] === "string" ? attrs["instruction"] : "";
      const displayText = typeof attrs["displayText"] === "string" ? attrs["displayText"] : "";
      facts.fields.push({ pos, instruction, displayText });
    }
    let endsWithStaticPageNumber = false;
    if (node.type.name === "paragraph") {
      const text = textOf(node);
      if (isHeadingParagraph(attrs)) {
        const title = normalize(text);
        if (title !== "") facts.headings.push({ text: title, pos });
      } else if (isTocEntryParagraph(attrs)) {
        // 静态目录的形态是「条目文字 + 制表符 + 页码」：页码必须是**尾部文字节点**里的数字。
        // 域形态的尾部是 field 原子（不是 text），下面这条条件自然为假，不会去改域缓存。
        const entry = staticPageNumber(node, pos);
        if (entry !== null) facts.staticEntries.push(entry);
        endsWithStaticPageNumber = entry !== null;
      }
    }
    // 静态目录段落不必再往里走：它的子节点里没有书签 / 域需要另算
    if (endsWithStaticPageNumber) return;
    node.forEach((child, offset) => walk(child, pos + 1 + offset));
  };

  // doc 自己没有开标签：顶层块的位置就是它的 offset（与 ProseMirror 的 descendants 一致）
  doc.forEach((child, offset) => walk(child, offset));
  return facts;
}

/** 尾部数字所在的文字节点 → 可替换的范围；不是「文字数字结尾」就返回 null */
function staticPageNumber(paragraph: TocHealNode, pos: number): TocStaticFact | null {
  const children: { node: TocHealNode; pos: number }[] = [];
  paragraph.forEach((child, offset) => {
    children.push({ node: child, pos: pos + 1 + offset });
  });
  const tail = children.length === 0 ? null : children[children.length - 1] ?? null;
  if (tail === null || tail.node.type.name !== "text") return null;
  const text = typeof tail.node.text === "string" ? tail.node.text : "";
  const match = /(\d+)\s*$/.exec(text);
  if (match === null) return null;
  const digits = match[1] ?? "";
  if (digits === "") return null;
  const before = normalize(textOf(paragraph)).slice(0, -digits.length);
  return {
    from: tail.pos + text.length - match[0].length,
    to: tail.pos + text.length - (match[0].length - digits.length),
    before: digits,
    title: before,
  };
}

/**
 * 这份版面是否已经覆盖到文档末尾。`fragment.pmEnd` 的最大值恒是 `content.size - 1`
 * （最末尾那一段的内容末尾）——不等说明拿到的还是**改动前**那一版版面。
 *
 * 为什么要这道闸：保存紧跟输入时（实测：打字后 250 ms 按 Ctrl+S）`getLayout()` 会慢一拍，
 * 拿到的还是旧的四页版面，而文档已经有五页。拿旧版面算页码会把书签往错的位置上对：
 * 轻则算不出（位置超出旧版面的覆盖范围），重则落到下一页、把错页码写进文件。
 */
export function layoutCoversDocument(layout: TocHealLayout, docSize: number): boolean {
  let end: number | null = null;
  for (const page of layout.pages) {
    for (const fragment of page.fragments) {
      const value = fragment.pmEnd;
      if (typeof value !== "number") continue;
      if (end === null || value > end) end = value;
    }
  }
  return end === docSize - 1;
}

/** 位置落在哪一页：覆盖该位置的最早一页；没有片段覆盖（块与块之间的缝）就是 null */
function pageOfPosition(layout: TocHealLayout, pos: number): number | null {
  let best: number | null = null;
  for (const page of layout.pages) {
    for (const fragment of page.fragments) {
      const start = fragment.pmStart;
      const end = fragment.pmEnd;
      if (typeof start !== "number" || typeof end !== "number") continue;
      if (start <= pos && pos <= end && (best === null || page.number < best)) best = page.number;
    }
  }
  return best;
}

/**
 * 计划要改的目录页码。`layout` 为空由调用方判（没有分页就没有页码，这里要求非空）。
 * 解析不出页码的条目只计数、不产生 op——旧值保持原样，比写错强。
 */
export function planTocHeal(facts: TocFacts, layout: TocHealLayout): TocHealPlan {
  const plan: TocHealPlan = {
    ops: [],
    fields: 0,
    staticEntries: 0,
    changed: 0,
    staticChanged: 0,
    missed: 0,
  };

  const bookmarkPages = new Map<string, number>();
  for (const bookmark of facts.bookmarks) {
    const page = pageOfPosition(layout, bookmark.pos);
    if (page !== null) bookmarkPages.set(bookmark.name, page);
  }

  const headingPages = new Map<string, number>();
  for (const heading of facts.headings) {
    if (headingPages.has(heading.text)) continue;
    const page = pageOfPosition(layout, heading.pos + 1);
    if (page !== null) headingPages.set(heading.text, page);
  }

  const ctx = {
    // PAGEREF 只用到 bookmarkPages；其余字段是 FieldContext 的形状要求，取值与本判定无关
    pageNumber: 1,
    totalPages: layout.pages.length,
    bookmarkPages,
    bookmarkText: new Map<string, string>(),
    seqValues: new Map<number, number>(),
    now: new Date(0),
  };

  for (const field of facts.fields) {
    plan.fields += 1;
    let display = "";
    try {
      display = evaluateFieldInstruction(field.instruction, ctx);
    } catch {
      // 字段结构异常（指令解析不了）：不覆盖旧值
      display = "";
    }
    if (display.trim() === "") {
      plan.missed += 1;
      continue;
    }
    if (display === field.displayText) continue;
    plan.ops.push({ kind: "field", pos: field.pos, displayText: display });
    plan.changed += 1;
  }

  for (const entry of facts.staticEntries) {
    plan.staticEntries += 1;
    const page = headingPages.get(entry.title);
    if (page === undefined) {
      plan.missed += 1;
      continue;
    }
    const text = String(page);
    if (text === entry.before) continue;
    plan.ops.push({ kind: "text", from: entry.from, to: entry.to, text });
    plan.changed += 1;
    plan.staticChanged += 1;
  }

  return plan;
}

function anchorOf(op: TocHealOp): number {
  return op.kind === "field" ? op.pos : op.from;
}

/**
 * 把计划写进一份事务。改成**缓存显示值**：域的指令、锁、TOC 域自己的 dirty 都不动。
 * 位置在两次读之间失效（节点没了）就跳过这一条——旧的页码留在那里，比写坏强。
 *
 * 从后往前改：静态目录把「99」换成「3」会让后面的位置整体前移，先改靠后的位置，
 * 前面还没执行的位置就不会被这次的增删推移。
 */
export function applyTocHeal(tr: TocHealTr, plan: TocHealPlan): void {
  const ops = [...plan.ops].sort((left, right) => anchorOf(right) - anchorOf(left));
  for (const op of ops) {
    if (op.kind === "text") {
      tr.insertText(op.text, op.from, op.to);
      continue;
    }
    const node = tr.doc.nodeAt(op.pos);
    if (node === null) continue;
    tr.setNodeMarkup(op.pos, undefined, { ...node.attrs, displayText: op.displayText, dirty: false });
  }
}
