/**
 * 工具栏命令（标题 / 加粗 / 列表）：只改 markdown 源码，外观由 cm-live-markdown 负责。
 * 纯 `EditorView` 操作，返回 boolean 以便直接当 keymap 的 run。
 */
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";

const HEADING_PREFIX = /^(#{1,6})\s+/;

/** 标题循环：正文 → # → ## → ### → 正文（作用在光标所在行，选了多行就都改成同一级） */
export function cycleHeading(view: EditorView): boolean {
  const { state } = view;
  const first = state.doc.lineAt(state.selection.main.from);
  const match = HEADING_PREFIX.exec(first.text);
  const level = match === null ? 0 : (match[1] as string).length;
  const next = level >= 3 ? 0 : level + 1;
  const last = state.doc.lineAt(state.selection.main.to);
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let n = first.number; n <= last.number; n += 1) {
    const line = state.doc.line(n);
    if (line.text.trim() === "") continue;
    const current = HEADING_PREFIX.exec(line.text);
    const strip = current === null ? 0 : current[0].length;
    changes.push({ from: line.from, to: line.from + strip, insert: next === 0 ? "" : `${"#".repeat(next)} ` });
  }
  if (changes.length === 0) return false;
  view.dispatch({ changes, userEvent: "input.format" });
  return true;
}

/** 加粗：选中文字两端加 / 去 `**`；没选中就插一对并把光标放在中间 */
export function toggleBold(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const text = state.doc.sliceString(range.from, range.to);
  const wrapped = state.doc.sliceString(Math.max(0, range.from - 2), range.from) === "**" &&
    state.doc.sliceString(range.to, Math.min(state.doc.length, range.to + 2)) === "**";
  if (range.empty) {
    view.dispatch({
      changes: { from: range.from, insert: "****" },
      selection: { anchor: range.from + 2 },
      userEvent: "input.format",
    });
  } else if (wrapped) {
    view.dispatch({
      changes: [
        { from: range.from - 2, to: range.from, insert: "" },
        { from: range.to, to: range.to + 2, insert: "" },
      ],
      selection: { anchor: range.from - 2, head: range.to - 2 },
      userEvent: "input.format",
    });
  } else if (text.startsWith("**") && text.endsWith("**") && text.length >= 4) {
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: text.slice(2, -2) },
      selection: { anchor: range.from, head: range.to - 4 },
      userEvent: "input.format",
    });
  } else {
    view.dispatch({
      changes: [
        { from: range.from, insert: "**" },
        { from: range.to, insert: "**" },
      ],
      selection: { anchor: range.from + 2, head: range.to + 2 },
      userEvent: "input.format",
    });
  }
  return true;
}

/** 列表：选中的每个非空行加 / 去 `- ` 前缀（全都有就去掉，否则补齐） */
export function toggleList(view: EditorView): boolean {
  const { state } = view;
  const first = state.doc.lineAt(state.selection.main.from).number;
  const last = state.doc.lineAt(state.selection.main.to).number;
  const rows = [];
  for (let n = first; n <= last; n += 1) {
    const line = state.doc.line(n);
    if (line.text.trim() !== "") rows.push(line);
  }
  if (rows.length === 0) {
    // 空行：直接起一个列表项
    const line = state.doc.line(first);
    view.dispatch({ changes: { from: line.from, insert: "- " }, selection: { anchor: line.from + 2 }, userEvent: "input.format" });
    return true;
  }
  const allBulleted = rows.every((line) => /^\s*[-*+]\s/.test(line.text));
  view.dispatch({
    changes: rows.map((line) => {
      if (allBulleted) {
        const match = /^(\s*)[-*+]\s/.exec(line.text) as RegExpExecArray;
        return { from: line.from + (match[1] as string).length, to: line.from + match[0].length, insert: "" };
      }
      // 带 # 的标题行加列表前缀没有意义：先去掉标题标记
      const heading = HEADING_PREFIX.exec(line.text);
      return { from: line.from, to: line.from + (heading === null ? 0 : heading[0].length), insert: "- " };
    }),
    userEvent: "input.format",
  });
  return true;
}

const LIST_LINE = /^(\s*)([-*+]|\d+[.)])(\s+)(.*)$/;

/**
 * 回车 = 新段落。markdown 里单个换行只是同一段内的软换行（预览把它连成一段、Word 导出成一大段带断行），
 * 所以文档编辑器的回车写成空行分隔（`\n\n`）；Shift+回车才是段内换行（`insertSoftBreak`）。
 * 例外：围栏代码块里是普通换行；列表项里是接着开下一项（空项再按回车 = 退出列表）。
 */
export function insertParagraph(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  const line = state.doc.lineAt(range.from);
  // 围栏代码块里：普通换行
  for (let node: { name: string; parent: unknown } | null = syntaxTree(state).resolveInner(range.from, -1); node !== null; node = node.parent as typeof node) {
    if (node.name === "FencedCode") {
      view.dispatch({ changes: { from: range.from, to: range.to, insert: "\n" }, selection: { anchor: range.from + 1 }, userEvent: "input" });
      return true;
    }
  }
  const item = LIST_LINE.exec(line.text);
  const prefixLength = item === null ? 0 : (item[1] as string).length + (item[2] as string).length + (item[3] as string).length;
  if (item !== null && range.from - line.from >= prefixLength) {
    if ((item[4] as string).trim() === "" && range.empty) {
      // 空项：去掉标记，退出列表
      view.dispatch({ changes: { from: line.from, to: line.to, insert: "" }, selection: { anchor: line.from }, userEvent: "delete" });
      return true;
    }
    const marker = item[2] as string;
    const next = /^\d/.test(marker) ? `${parseInt(marker, 10) + 1}${marker.slice(-1)}` : marker;
    const insert = `\n${item[1] as string}${next}${item[3] as string}`;
    view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length }, userEvent: "input" });
    return true;
  }
  view.dispatch({ changes: { from: range.from, to: range.to, insert: "\n\n" }, selection: { anchor: range.from + 2 }, userEvent: "input" });
  return true;
}

/** Shift+回车：段内换行（markdown 硬换行：行尾两个空格 + 换行） */
export function insertSoftBreak(view: EditorView): boolean {
  const range = view.state.selection.main;
  view.dispatch({ changes: { from: range.from, to: range.to, insert: "  \n" }, selection: { anchor: range.from + 3 }, userEvent: "input" });
  return true;
}
