/**
 * 论文工作台的源码编辑器（`.tex` 标签的正文）。
 *
 * 三件事写在这里：CodeMirror 的挂载 / 销毁、自动保存与冲突处理、状态行。
 * 语言与外观在 latex-editor.ts，纯状态逻辑在 editor-state.ts（`node --test` 覆盖）。
 *
 * 保存规则（原型场景 1 第 3 步 + 场景 4）：
 * - 停手 **1.5 s** 自动保存；编译前由 FilesPanel 调 `flush()` 强制落盘。
 * - 脏状态按**磁盘格式**的内容指纹判（editor-state.ts 的注释说清了 CRLF 与 mtime 两个坑）。
 * - 编辑期间盘上被外部改过：**不写**，挂出冲突条，给「重新加载 / 保留我的」。
 *   检测有两道：写前由主进程重读比对（fs:write 的 expectedHash），以及脏状态下每 2.5 s
 *   的一次轻读（你停手不打字时也要能看见「agent 改了」）。
 * - 切换标签 / 关闭标签前由 FilesPanel 调 `flush()`：1.5 s 没到就切走也不丢字。
 *
 * 编辑器容器与标签沿用 Files 面板现有语言；文字与颜色走设计 token，深浅主题同一套。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { api } from "../../api.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { contentHash, type FileListRequest } from "@shared/files";
import { latexEditorExtensions } from "./latex-editor.ts";
import { formatSize } from "./tree-view.ts";
import {
  createAutosaveScheduler,
  cursorPosition,
  detectLineEnding,
  toDiskText,
  type AutosaveScheduler,
  type EditorPhase,
  type LineEnding,
} from "./editor-state.ts";

/** 停手多久自动保存（设计稿的 1.5 s） */
const AUTOSAVE_MS = 1500;
/** 脏状态下检查盘上有没有被外部改过的间隔；只读一个小文本文件，代价远低于 fs.watch 整棵树 */
const EXTERNAL_CHECK_MS = 2500;

/** flush 的结局：FilesPanel 据此决定能不能关标签 / 能不能编译 */
export type FlushOutcome = "clean" | "saved" | "conflict" | "error";

/** 对外的把手：状态住在 CodeMirror 里，外层的「编译前保存」「关标签前保存」经它转达 */
export interface TexEditorHandle {
  /** 立刻保存未落盘的内容；没有改动时返回 clean */
  flush: () => Promise<FlushOutcome>;
  /** 此刻文档是否与盘上基线不同 */
  isDirty: () => boolean;
  /** 是否卡在「盘上被外部改过」的冲突上（关标签时不能替用户决定） */
  conflicted: () => boolean;
}

interface Snapshot {
  text: string;
  hash: string;
}

export function TexEditorPane(props: {
  request: FileListRequest;
  /** 初次读到的磁盘文本（fs:read 的 text 回执）；编辑器只在这一刻用它 */
  initialText: string;
  /** 把把手登记给 FilesPanel（编译前 flush / 关标签前 flush 都走它）；卸载时注销 */
  register: (path: string, handle: TexEditorHandle | null) => void;
  /** 脏状态变了：标签上的圆点跟着亮 / 灭 */
  onDirtyChange: (path: string, dirty: boolean) => void;
  /** 保存成功（FilesPanel 借它让编译条立刻看到「源码比 PDF 新」） */
  onSaved?: () => void;
  /** 保存失败 / 写盘被拒：面板上给一行可见的错误，不静默 */
  onError?: (path: string, message: string) => void;
}) {
  const t = useT();
  const path = props.request.dir;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mountedRef = useRef(true);
  /** 基线：最后一次从盘上读到 / 成功写下去的文本指纹（按磁盘格式） */
  const savedHashRef = useRef(contentHash(props.initialText));
  const eolRef = useRef<LineEnding>(detectLineEnding(props.initialText));
  const phaseRef = useRef<EditorPhase>("saved");
  const [phase, setPhase] = useState<EditorPhase>("saved");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [conflictText, setConflictText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [savingNow, setSavingNow] = useState(false);
  /** 外部文本替换文档时不当作「用户编辑」（否则一挂载就排一次自动保存） */
  const replacingRef = useRef(false);
  const dirtyRef = useRef(false);

  const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

  const setPhaseBoth = useCallback(
    (next: EditorPhase): void => {
      if (phaseRef.current === next) return;
      phaseRef.current = next;
      if (mountedRef.current) setPhase(next);
      // 标签圆点的口径：只要还有没落盘的内容（含保存失败 / 冲突）就是脏
      const dirty = next !== "saved";
      if (dirty !== dirtyRef.current) {
        dirtyRef.current = dirty;
        props.onDirtyChange(path, dirty);
      }
    },
    [path, props.onDirtyChange],
  );

  /** 当前文档按磁盘格式的文本 + 指纹；视图不在时 null */
  const snapshot = useCallback((): Snapshot | null => {
    const view = viewRef.current;
    if (view === null) return null;
    const text = toDiskText(view.state.doc.toString(), eolRef.current);
    return { text, hash: contentHash(text) };
  }, []);

  const isDirtyNow = useCallback((): boolean => {
    const snap = snapshot();
    return snap !== null && snap.hash !== savedHashRef.current;
  }, [snapshot]);

  /** 保存串行化：同一标签不会有两笔写交错（自动保存撞上编译前 flush 是常态） */
  const chainRef = useRef<Promise<FlushOutcome>>(Promise.resolve("clean"));
  const schedulerRef = useRef<AutosaveScheduler | null>(null);

  /**
   * 一次保存。`fixed` 是卸载 / 切换标签时**当场**抓下的快照——不能等到微任务里再读
   * 视图，那时组件已经销毁。`force` 对应「保留我的」。
   */
  const saveOnce = useCallback(
    async (force: boolean, fixed?: Snapshot): Promise<FlushOutcome> => {
      const snap = fixed ?? snapshot();
      if (snap === null) return "clean";
      if (!force && snap.hash === savedHashRef.current) {
        // 改了又改回去：不必写盘，状态回到已保存
        if (phaseRef.current === "dirty" || phaseRef.current === "error") setPhaseBoth("saved");
        return "clean";
      }
      setPhaseBoth("saving");
      if (mountedRef.current) setSavingNow(true);
      try {
        const result = await api.files.write({
          ...props.request,
          text: snap.text,
          expectedHash: force ? null : savedHashRef.current,
        });
        if (result.kind === "too-large") {
          const message = t.editor.tooLarge(formatSize(result.size), formatSize(result.limit));
          if (mountedRef.current) setErrorText(message);
          setPhaseBoth("error");
          props.onError?.(path, message);
          return "error";
        }
        if (result.kind === "conflict") {
          // 盘上已经不是编辑器手里那份：一个字都没写。停掉自动保存，等用户裁决
          schedulerRef.current?.cancel();
          if (mountedRef.current) {
            setConflictText(result.text);
            setErrorText(null);
            setPhaseBoth("conflict");
          } else {
            // 切换 / 关标签时的兜底保存撞上冲突：面板上留一行，别让改动无声消失
            props.onError?.(path, t.editor.conflictAfterClose);
          }
          return "conflict";
        }
        savedHashRef.current = result.hash;
        if (mountedRef.current) {
          setErrorText(null);
          setConflictText(null);
          const after = snapshot();
          setPhaseBoth(after !== null && after.hash !== savedHashRef.current ? "dirty" : "saved");
        }
        props.onSaved?.();
        return "saved";
      } catch (cause) {
        const message = failMessage(cause);
        if (mountedRef.current) setErrorText(message);
        setPhaseBoth("error");
        props.onError?.(path, message);
        return "error";
      } finally {
        if (mountedRef.current) setSavingNow(false);
      }
    },
    [path, props.onError, props.onSaved, props.request, setPhaseBoth, snapshot, t],
  );

  /** 保存串行化：同一标签不会有两笔写交错（自动保存撞上编译前 flush 是常态） */
  const runSave = useCallback(
    (force: boolean, fixed?: Snapshot): Promise<FlushOutcome> => {
      const next = chainRef.current.then(
        () => saveOnce(force, fixed),
        () => saveOnce(force, fixed),
      );
      chainRef.current = next;
      return next;
    },
    [saveOnce],
  );

  // 调度器只建一次：save 走 runSave（它已经是最新的 ref 闭包）
  if (schedulerRef.current === null) {
    schedulerRef.current = createAutosaveScheduler({
      delayMs: AUTOSAVE_MS,
      save: () => void runSave(false),
    });
  }
  const scheduler = schedulerRef.current;

  const handleRef = useRef<TexEditorHandle>({
    flush: () => runSave(false),
    isDirty: () => isDirtyNow(),
    conflicted: () => phaseRef.current === "conflict",
  });

  // 挂载：建编辑器；卸载：先把没落盘的内容写下去，再销毁
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    mountedRef.current = true;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: props.initialText,
        extensions: [
          ...latexEditorExtensions((update) => {
            if (update.docChanged && !replacingRef.current) {
              const snap = snapshot();
              if (snap !== null && snap.hash !== savedHashRef.current) {
                // 冲突没裁决之前不再自动写：否则 1.5 s 后就把外部改动覆盖了
                if (phaseRef.current !== "conflict") {
                  setPhaseBoth("dirty");
                  scheduler.schedule();
                }
              } else if (phaseRef.current === "dirty" || phaseRef.current === "error") {
                scheduler.cancel();
                setPhaseBoth("saved");
              }
            }
            if (update.selectionSet || update.docChanged) {
              const state = viewRef.current?.state;
              if (state !== null && state !== undefined) {
                const pos = cursorPosition(state.doc, state.selection.main.head);
                setCursor(pos);
              }
            }
          }),
          EditorView.contentAttributes.of({ "aria-label": t.editor.aria, spellcheck: "false" }),
        ],
      }),
    });
    viewRef.current = view;
    setCursor(cursorPosition(view.state.doc, view.state.selection.main.head));
    props.register(path, handleRef.current);
    // 挂载即干净：上一个实例若在冲突中卸载，残留的脏标记不能跟着新实例继续亮
    dirtyRef.current = false;
    props.onDirtyChange(path, false);

    return () => {
      // 切换标签 / 关标签也会走到这里；先把当前文本抓下来再销毁视图。
      // FilesPanel 在切换 / 关标签前会主动 flush（冲突就不切走），这里是兜底。
      const fixed = snapshot();
      if (fixed !== null && fixed.hash !== savedHashRef.current) {
        void runSave(false, fixed);
      } else {
        // 没有未落盘内容：把脏标记清掉，不留在外层变成一个永不灭的圆点
        dirtyRef.current = false;
        props.onDirtyChange(path, false);
      }
      props.register(path, null);
      view.destroy();
      viewRef.current = null;
      mountedRef.current = false;
    };
    // 只在挂载 / 卸载时跑：initialText 是「打开这一刻的盘上内容」，换文件会换 key 重挂
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  // 脏状态下盯一眼盘上内容：用户停手不打字时，外部改动也要能看见
  useEffect(() => {
    if (phase !== "dirty") return;
    const timer = window.setInterval(() => {
      if (phaseRef.current !== "dirty") return;
      void api.files
        .read(props.request)
        .then((preview) => {
          if (!mountedRef.current || phaseRef.current !== "dirty") return;
          if (preview.kind !== "text") return;
          if (contentHash(preview.text) === savedHashRef.current) return;
          scheduler.cancel();
          setConflictText(preview.text);
          setPhaseBoth("conflict");
        })
        .catch(() => {
          // 一次读失败（文件被删 / 暂时不可读）不改状态：下一轮再看
        });
    }, EXTERNAL_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [phase, props.request, scheduler, setPhaseBoth]);

  const currentStatus = ((): string => {
    switch (phase) {
      case "saved":
        return t.editor.saved;
      case "dirty":
        return t.editor.unsaved;
      case "saving":
        return t.editor.saving;
      case "error":
        return t.editor.saveFailed;
      case "conflict":
        return t.editor.conflictState;
    }
  })();

  /** 「重新加载」：丢弃本地未保存内容，把盘上那一份装进编辑器（作为一笔可撤销的替换） */
  const reloadFromDisk = (): void => {
    const text = conflictText;
    const view = viewRef.current;
    if (text === null || view === null) return;
    replacingRef.current = true;
    try {
      eolRef.current = detectLineEnding(text);
      savedHashRef.current = contentHash(text);
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
        selection: { anchor: 0 },
      });
    } finally {
      replacingRef.current = false;
    }
    scheduler.cancel();
    if (mountedRef.current) {
      setConflictText(null);
      setErrorText(null);
      setPhaseBoth("saved");
      setCursor(cursorPosition(view.state.doc, 0));
    }
    props.onSaved?.();
  };

  /** 「保留我的」：以当前文档强制覆盖盘上那一份（唯一跳过冲突检查的入口） */
  const keepMine = (): void => {
    if (mountedRef.current) setConflictText(null);
    void runSave(true);
  };

  const retry = (): void => {
    if (mountedRef.current) setErrorText(null);
    void runSave(false);
  };

  // 搜索面板的 Esc 只关面板，不再让 App 把它当成「关标签」（2026-10-23 验收实测：
  // 一下 Esc 连搜索面板带标签一起关了）。用**原生**监听而不是 React 合成事件：
  // 合成事件在根容器上分发，拿到的 defaultPrevented 不可靠；原生监听在容器冒泡阶段
  // 看到的就是 CodeMirror 处理之后的值（它已 preventDefault，但没 stopPropagation）。
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const target = event.target instanceof Element ? event.target : null;
      if (event.defaultPrevented || target?.closest(".cm-panels") != null) event.stopPropagation();
    };
    root.addEventListener("keydown", onKeyDown);
    return () => root.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="tex-editor" ref={rootRef}>
      {(conflictText !== null || errorText !== null) && (
        <div className="tex-editor-banner" data-tone={conflictText !== null ? "warning" : "danger"} role="status">
          <Icon
            name="triangle-alert"
            size={14}
            className="tex-editor-banner-icon"
            style={{ flex: "0 0 auto", marginTop: 1 }}
          />
          <span className="tex-editor-banner-text">
            {conflictText !== null ? t.editor.conflictBanner : t.editor.errorBanner}
            {errorText !== null && <span className="tex-editor-banner-detail">{errorText}</span>}
          </span>
          <span className="row-trailing tex-editor-banner-acts">
            {conflictText !== null ? (
              <>
                <button type="button" className="quiet-control" onClick={reloadFromDisk}>
                  {t.editor.reload}
                </button>
                <button type="button" className="quiet-control" onClick={keepMine}>
                  {t.editor.keepMine}
                </button>
              </>
            ) : (
              <button type="button" className="quiet-control" onClick={retry}>
                {t.common.retry}
              </button>
            )}
          </span>
        </div>
      )}
      <div className="tex-editor-host" ref={hostRef} />
      <div className="tex-editor-status" data-phase={phase}>
        <span className="tex-editor-cursor">
          {t.editor.cursor(cursor.line, cursor.column)}
        </span>
        <span className="row-trailing tex-editor-save-state">
          {savingNow && <span className="tex-editor-spinner" aria-hidden="true" />}
          {currentStatus}
        </span>
      </div>
    </div>
  );
}
