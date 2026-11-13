/**
 * 文档模式编辑器的键位与「第一个字成标题」（从 DocEditor.tsx 抽出，为了能不起 DOM 地测：
 * 测试用同一份扩展建 state，再经 `runScopeHandlers` 派真按键——只测命令函数测不出 keymap 里谁先抢到回车，
 * 上一版的列表分支就是这样「单测全绿、真编辑器里从没跑到」）。
 */
import { Annotation, EditorState, Prec, Transaction, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { insertParagraph, insertSoftBreak, toggleBold } from "./doc-commands.ts";

/** 外部改动（agent / 重新对齐）的事务打这个标：不回报给 onChange、不进撤销栈、不触发标题补全 */
export const External = Annotation.define<boolean>();

/** 文档视图的键位（回车 = 新段落，Shift+回车 = 段内换行，Mod-b 加粗）。优先级高于默认键位 */
export function documentKeymap(): Extension {
  return Prec.high(
    keymap.of([
      { key: "Enter", run: insertParagraph, preventDefault: true },
      { key: "Shift-Enter", run: insertSoftBreak, preventDefault: true },
      { key: "Mod-b", run: toggleBold, preventDefault: true },
    ]),
  );
}

const needsTitle = (text: string): boolean => text !== "" && !text.startsWith("#") && !text.startsWith("\n");

/** 输入法组合期间的事务（拼音字母还在组合区里，改写它会让浏览器与编辑器的组合状态对不上） */
const isComposing = (tr: Transaction): boolean => tr.isUserEvent("input.type.compose") || tr.isUserEvent("input.compose");

/**
 * 空文档里用户打的第一个字：前面补 `# `（第一行就是标题）。只认用户输入（外部合并、撤销不算）。
 * 不动已经以 `#` 起头的内容（粘贴一整段 markdown 时别二次加）。
 * **输入法组合中不改写**：拼音字母还在组合区里，改写事务会让浏览器与编辑器的组合状态对不上（空文档里打「中」
 * 曾因此存成 `# z中`）；等组合结束再补（`titleAfterComposition` → `ensureTitle`）。
 */
export const titleFirstFilter: Extension = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || tr.startState.doc.length !== 0 || tr.annotation(External) === true) return tr;
  const userEvent = tr.annotation(Transaction.userEvent);
  if (userEvent === undefined || !userEvent.startsWith("input")) return tr;
  if (isComposing(tr)) return tr;
  const text = tr.newDoc.toString();
  if (!needsTitle(text)) return tr;
  return [
    {
      changes: { from: 0, insert: `# ${text}` },
      selection: { anchor: tr.newSelection.main.head + 2 },
      userEvent,
    },
  ];
});

/** 组合结束后调用：文档开头缺 `# `（且整份是组合里从空写出来的）就补上。幂等 */
export function ensureTitle(view: EditorView, wasEmptyBefore: boolean): boolean {
  if (!wasEmptyBefore || view.composing) return false;
  const text = view.state.doc.toString();
  if (!needsTitle(text)) return false;
  view.dispatch({
    changes: { from: 0, insert: "# " },
    userEvent: "input.format",
  });
  return true;
}

/**
 * 跟踪「组合开始时文档是不是空的」：compositionstart 记下，compositionend 之后（等 CodeMirror 把组合结果
 * 并进文档）补标题。浏览器里 compositionend 先于 CM 的最终 flush，所以延后一拍并重试几次。
 */
export function titleAfterComposition(): Extension {
  let wasEmpty = false;
  return EditorView.domEventHandlers({
    compositionstart(_event, view) {
      wasEmpty = view.state.doc.length === 0;
      return false;
    },
    compositionend(_event, view) {
      const started = wasEmpty;
      if (!started) return false;
      let tries = 0;
      const attempt = (): void => {
        tries += 1;
        if (view.composing && tries < 10) {
          setTimeout(attempt, 20);
          return;
        }
        ensureTitle(view, true);
      };
      setTimeout(attempt, 30);
      return false;
    },
  });
}
