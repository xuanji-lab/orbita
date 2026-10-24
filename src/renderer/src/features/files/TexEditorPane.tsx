/**
 * 论文工作台的源码编辑器（`.tex` 标签的正文）。
 *
 * 三件事写在这里：CodeMirror 的挂载 / 销毁、自动保存与冲突处理、状态行。
 * 语言与外观在 latex-editor.ts，纯状态逻辑在 editor-state.ts（`node --test` 覆盖）。
 *
 * **与 agent 同改一个文件的安全边界**（editor-collab.ts 定规则，这里只执行）：
 * - agent 本轮写过这个文件时整块只读，顶部条写明原因；回合结束自动解除。
 * - 回合结束时 `syncFromDisk`：盘上没变不动；编辑器干净就静默重载（光标留在原行）；
 *   有未保存改动就挂冲突条——**用户没保存的字永远不被冲掉**。
 * - 本轮的改动按块列出，可单块撤、可整轮撤；现在的文字里找不到那一块（用户自己改过）
 *   就标「不可撤销」，不猜。
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
import { ContextMenu } from "../../shell/ContextMenu";
import type { MenuItem } from "../../shell/Menu";
import { contentHash, type FileListRequest } from "@shared/files";
import type { CiteEntry } from "@shared/cite";
import {
  latexEditorExtensions,
  agentMarkEffect,
  clearSyncLineEffect,
  readOnlyCompartment,
  readOnlyExtensions,
  syncLineEffect,
} from "./latex-editor.ts";
import { formatSize } from "./tree-view.ts";
import { citeCompletion } from "./cite-completion.ts";
import {
  clampCursorLine,
  locateBlock,
  nonOverlappingChanges,
  pruneStaleIds,
  syncDecision,
  type AgentWritePhase,
  type EditorHunk,
} from "./editor-collab.ts";
import {
  createAutosaveScheduler,
  cursorPosition,
  detectLineEnding,
  toDiskText,
  type AutosaveScheduler,
  type EditorPhase,
  type LineEnding,
} from "./editor-state.ts";

/** 没有改动块时的常量：每次新 `[]` 会让依赖它的效果每帧重跑 */
const NO_HUNKS: readonly EditorHunk[] = [];
/** 文献库还没到（或不在项目里）时的同一份空库：常量身份，补全来源每次现读 */
const NO_CITE: readonly CiteEntry[] = [];

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
  /** 当前文档文本（CodeMirror 内部 `\n` 口径）；视图不在时 null */
  text: () => string | null;
  /** 回合结束时从盘上同步一次（干净→静默重载，脏→冲突条）；盘上没变则什么都不做 */
  syncFromDisk: (diskText: string) => void;
}

/** 编辑器看到的「agent 本轮对我做了什么」（由 useEditorCollab 算好递进来） */
export interface EditorCollabView {
  /**
   * 这个编辑器本轮被谁占着：
   * - "writing" / "done"：agent 的 write/edit 正在写 / 写过了
   * - "possible"：本轮出现了 shell、终端执行或 MCP 工具——它们改哪个文件我们看不见，
   *   所以把打开的项目文件都按「可能被写」算（宁可多锁一轮，不能丢字）
   * - null：没被占，正常编辑 + 自动保存
   */
  hold: AgentWritePhase | "possible" | null;
  /** 这一轮还在跑（用户编辑要按「本轮动过」记账，用事务而不是脏快照） */
  turnActive: boolean;
  /** 本轮的改动块（回合落定后才有，按块可撤） */
  hunks: readonly EditorHunk[];
  /** 撤销成功的块回报给外层（从清单里去掉） */
  onUndone: (ids: readonly string[]) => void;
  /** 回合落定的同步请求（token 变化触发一次） */
  sync: { token: number; text: string } | null;
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
  /** agent 与本文件的互动（只读、重载、按块撤销）；缺席 = 没有论文工作台的接线 */
  collab?: EditorCollabView;
  /**
   * 右键菜单「在 PDF 中定位」：把这一行交给外层做 SyncTeX 正向查找。
   * 缺席 = 这个文件不属于 LaTeX 项目，菜单里不出这一项。
   */
  onForwardSync?: (line: number) => void;
  /** 右键菜单「引用到对话」：选中文字（没有选区时是这一行）放进输入框 */
  onQuote?: (text: string, line: number) => void;
  /**
   * 外部要求跳到某一行并高亮（PDF 双击 / Ctrl+单击的结果）。token 单调递增，
   * 同一个 token 只跳一次；行号 1 基，越界贴到末行（syncFromDisk 同一条纪律）。
   */
  reveal?: { line: number; token: number } | null;
  /**
   * 项目文献库（`\cite{` 的候选）。缺席 / 空数组时补全不弹——不在 LaTeX 项目里的
   * .tex 就是这种情形。往下传的是**最新一份**而不是挂载时的快照：库可能比编辑器
   * 晚到（IPC 在飞），重挂编辑器会丢光标与撤销历史。
   */
  cite?: readonly CiteEntry[];
}) {
  const t = useT();
  const path = props.request.dir;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const mountedRef = useRef(true);
  /**
   * 补全的来源读这个 ref：库比编辑器晚到、换项目后重扫，都不必重建编辑器——
   * 重建会丢光标、撤销历史与滚动位置。
   */
  const citeRef = useRef<readonly CiteEntry[]>(props.cite ?? NO_CITE);
  citeRef.current = props.cite ?? NO_CITE;
  /** 基线：最后一次从盘上读到 / 成功写下去的文本指纹（按磁盘格式） */
  const savedHashRef = useRef(contentHash(props.initialText));
  const eolRef = useRef<LineEnding>(detectLineEnding(props.initialText));
  /**
   * 冲突那一刻盘上的指纹。「保留我的」用它当 expectedHash——盘上在那之后又被改过就再
   * 冲突，**不覆盖**（验收要求：保留用户文本，但不许把更新的一份盘上内容抹掉）。
   */
  const conflictHashRef = useRef<string | null>(null);
  const phaseRef = useRef<EditorPhase>("saved");
  const [phase, setPhase] = useState<EditorPhase>("saved");
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [conflictText, setConflictText] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [savingNow, setSavingNow] = useState(false);
  /** 右键菜单：打开位置 + 被右键的那一行（行号 1 基）与将要引用的文字 */
  const [menu, setMenu] = useState<{ x: number; y: number; line: number; text: string } | null>(null);
  /** 改动块清单的展开态（默认展开：这是回合结束后最想知道的事） */
  const [hunksOpen, setHunksOpen] = useState(true);
  /** 现场找不到的块（用户自己改过 / 被删）：标成不可撤，不隐藏 */
  const [staleIds, setStaleIds] = useState<ReadonlySet<string>>(new Set());
  /** 文档被外部整体换过几次：改动块的高亮要在这个新文档上重算 */
  const [docEpoch, setDocEpoch] = useState(0);
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
        // 「保留我的」不是无条件覆盖：拿冲突那一刻的盘上指纹做校验，盘上又变了就再冲突
        const expected = force ? (conflictHashRef.current ?? savedHashRef.current) : savedHashRef.current;
        const result = await api.files.write({
          ...props.request,
          text: snap.text,
          expectedHash: expected,
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
          conflictHashRef.current = contentHash(result.text);
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
        conflictHashRef.current = null;
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
      save: () => {
        // 回合进行中：**不写盘**，待存改动留在内存（P0 的根因就在这一步）
        if (pausedRef.current) {
          heldPendingRef.current = true;
          return;
        }
        void runSave(false);
      },
    });
  }
  const scheduler = schedulerRef.current;

  /** 回合落定时的同步实现（每轮渲染更新，把手上的引用永远是最新那份闭包） */
  const syncFromDiskRef = useRef<(diskText: string) => void>(() => {});
  const handleRef = useRef<TexEditorHandle>({
    flush: () => runSave(false),
    isDirty: () => isDirtyNow(),
    conflicted: () => phaseRef.current === "conflict",
    text: () => viewRef.current?.state.doc.toString() ?? null,
    syncFromDisk: (diskText: string) => syncFromDiskRef.current(diskText),
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
              // 用户事务：落定时的判定靠它，而不是「那一刻脏不脏」（P0）
              if (turnActiveRef.current) editedDuringTurnRef.current = true;
              const snap = snapshot();
              if (snap !== null && snap.hash !== savedHashRef.current) {
                // 冲突没裁决之前不再自动写：否则 1.5 s 后就把外部改动覆盖了
                if (phaseRef.current !== "conflict") {
                  setPhaseBoth("dirty");
                  if (pausedRef.current) heldPendingRef.current = true;
                  else scheduler.schedule();
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
          citeCompletion(() => citeRef.current),
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

  // PDF → 源码的落点：选中这一行、滚到视口中间、铺一条短暂的底色。
  // 依赖只有 token：同一次定位在重渲染时不该再抢一次滚动条。
  const reveal = props.reveal ?? null;
  useEffect(() => {
    if (reveal === null) return;
    const view = viewRef.current;
    if (view === null) return;
    const line = view.state.doc.line(clampCursorLine(reveal.line, view.state.doc.lines));
    view.dispatch({
      selection: { anchor: line.from, head: line.to },
      effects: [
        EditorView.scrollIntoView(line.from, { y: "center" }),
        syncLineEffect(line.from),
      ],
    });
    view.focus();
    const timer = window.setTimeout(() => {
      viewRef.current?.dispatch({ effects: clearSyncLineEffect() });
    }, 2000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal?.token]);

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
          conflictHashRef.current = contentHash(preview.text);
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
    conflictHashRef.current = null;
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

  /**
   * 回合结束时从盘上同步一次。三种结局都与「不丢用户字」对齐：
   * - 盘上就是基线：什么都不做（同一个 token 重复到达也是空操作）
   * - 编辑器干净：静默重载，光标留在原来那一行（越界贴到末行）
   * - 有未保存改动：**不覆盖**，挂冲突条等用户选（重新加载 / 保留我的）
   */
  const syncFromDisk = (diskText: string): void => {
    const view = viewRef.current;
    if (view === null) return;
    const incoming = contentHash(diskText);
    // 三种结局的取舍在 editor-collab.ts 的 syncDecision（有表驱动测试）
    const snap = snapshot();
    const decision = syncDecision({
      diskChanged: incoming !== savedHashRef.current,
      conflicted: phaseRef.current === "conflict",
      dirty: snap !== null && snap.hash !== savedHashRef.current,
      // 本轮用户动过（哪怕现在已经改回基线）：agent 也写过 → 不许静默重载（P0）
      editedThisTurn: editedDuringTurnRef.current,
    });
    if (decision === "nothing" || decision === "wait") return;
    if (decision === "keep") {
      heldPendingRef.current = false;
      schedulerRef.current?.cancel();
      conflictHashRef.current = incoming;
      if (mountedRef.current) {
        setConflictText(diskText);
        setErrorText(null);
        setPhaseBoth("conflict");
      }
      return;
    }
    const doc = view.state.doc;
    const head = view.state.selection.main.head;
    const line = doc.lineAt(head).number;
    const column = head - doc.lineAt(head).from;
    const text = diskText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    replacingRef.current = true;
    try {
      eolRef.current = detectLineEnding(diskText);
      savedHashRef.current = incoming;
      view.dispatch({
        changes: { from: 0, to: doc.length, insert: text },
        selection: { anchor: 0 },
        scrollIntoView: false,
      });
      const target = view.state.doc.line(clampCursorLine(line, view.state.doc.lines));
      view.dispatch({ selection: { anchor: target.from + Math.min(column, target.length) } });
    } finally {
      replacingRef.current = false;
    }
    scheduler.cancel();
    if (mountedRef.current) {
      setConflictText(null);
      setErrorText(null);
      setPhaseBoth("saved");
      setCursor(cursorPosition(view.state.doc, view.state.selection.main.head));
      setDocEpoch((epoch) => epoch + 1);
    }
    props.onSaved?.();
  };
  syncFromDiskRef.current = syncFromDisk;

  /** 本轮占着这个编辑器的原因（agent 正在写 / 写过了 / 可能出现 shell·MCP 写） */
  const hold = props.collab?.hold ?? null;
  const readOnly = hold !== null;
  /** 回合是否在跑：用户编辑按「本轮动过」记账（落在 ref 上给 CodeMirror 的监听读） */
  const turnActive = props.collab?.turnActive ?? false;
  const turnActiveRef = useRef(turnActive);
  turnActiveRef.current = turnActive;
  const editedDuringTurnRef = useRef(false);
  /**
   * 自动保存的闸门。**整个回合都不写盘**（不只是 agent 已经写过之后）：P0 的时间线是
   * 「用户先打字 → 1.5 s 自动保存落盘 → agent 用自己读到的旧内容覆盖」，暂停必须从
   * 开轮就生效。回合中用户另开的文件同样暂停——最坏是一次拖动标签时由 flush 显式落盘。
   */
  const autosavePaused = readOnly || turnActive;
  const pausedRef = useRef(false);
  pausedRef.current = autosavePaused;
  /** 被闸门拦下的待存改动：解除占位后补一次自动保存 */
  const heldPendingRef = useRef(false);

  // 开轮就重置「本轮用户动过」：上一轮的编辑不算这一轮
  useEffect(() => {
    if (turnActive) editedDuringTurnRef.current = false;
  }, [turnActive]);

  // 只读开关：回合边界翻转时重配（重建编辑器会丢光标与撤销历史）
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    view.dispatch({ effects: readOnlyCompartment.reconfigure(readOnlyExtensions(readOnly)) });
  }, [readOnly]);

  // 回合落定的同步：只认自己这一份（同一个 token 只跑一次）
  const sync = props.collab?.sync ?? null;
  const consumedSyncRef = useRef<number | null>(null);
  // 挂载那一刻的 sync 已经落在 initialText 里（挂上来读的就是当前盘上那份），
  // 不重放：否则切走再切回来会把上一轮的旧内容当「最新」加载进来
  if (consumedSyncRef.current === null) consumedSyncRef.current = sync?.token ?? 0;
  useEffect(() => {
    if (sync === null || consumedSyncRef.current === sync.token) return;
    consumedSyncRef.current = sync.token;
    syncFromDiskRef.current(sync.text);
  }, [sync]);

  // 闸门解除（回合落定）：被拦下的待存内容回到常规自动保存。盘上若已被 agent 改过，
  // 这一笔会撞 expectedHash → 冲突条，正是我们要的「不覆盖、问用户」
  useEffect(() => {
    if (autosavePaused) return;
    if (!heldPendingRef.current) return;
    heldPendingRef.current = false;
    if (phaseRef.current === "dirty") scheduler.schedule();
  }, [autosavePaused, scheduler]);

  const hunks = props.collab?.hunks ?? NO_HUNKS;

  // 换了一轮 / 撤掉几块：只清掉**已经不在清单里**的现场判定——撤掉别的块不能让
  // 不可撤的块重新变得可点（P3）
  useEffect(() => {
    setStaleIds((prev) => pruneStaleIds(prev, hunks));
  }, [hunks]);

  /** 在现在的文档里定位一块（行区间 + 字符区间）；找不到返回 null */
  const locate = useCallback(
    (hunk: EditorHunk): { from: number; to: number; startLine: number } | null => {
      const view = viewRef.current;
      if (view === null) return null;
      const range = locateBlock(view.state.doc.toString().split("\n"), hunk.after, hunk.anchorLine);
      if (range === null) return null;
      return {
        from: view.state.doc.line(range.start + 1).from,
        to: view.state.doc.line(range.end).to,
        startLine: range.start,
      };
    },
    [],
  );

  /** 把改动块的高亮铺上去：只圈新增的行（上下文行不涂） */
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const ranges: { from: number; to: number }[] = [];
    for (const hunk of hunks) {
      const block = locate(hunk);
      if (block === null) continue;
      for (const span of hunk.addedSpans) {
        const first = block.startLine + span.line + 1;
        if (first > view.state.doc.lines) continue;
        const last = Math.min(first + span.count - 1, view.state.doc.lines);
        ranges.push({ from: view.state.doc.line(first).from, to: view.state.doc.line(last).to });
      }
    }
    view.dispatch({ effects: agentMarkEffect(ranges) });
  }, [hunks, docEpoch, locate]);

  /** 撤一块：定位→换成改动前那一块。找不到说明用户自己改过，标成不可撤 */
  const undoHunk = (hunk: EditorHunk): void => {
    const view = viewRef.current;
    const block = locate(hunk);
    if (view === null || block === null) {
      setStaleIds((prev) => new Set(prev).add(hunk.id));
      return;
    }
    view.dispatch({
      changes: { from: block.from, to: block.to, insert: hunk.before.join("\n") },
      selection: { anchor: block.from },
      scrollIntoView: true,
    });
    view.focus();
    props.collab?.onUndone([hunk.id]);
  };

  /** 整轮撤：一次性 dispatch（一笔撤销历史），找不到的块留着并标记 */
  const undoTurn = (): void => {
    const view = viewRef.current;
    if (view === null) return;
    const plans: { id: string; from: number; to: number; insert: string }[] = [];
    const missing: string[] = [];
    for (const hunk of hunks) {
      const block = locate(hunk);
      if (block === null) {
        missing.push(hunk.id);
        continue;
      }
      plans.push({ id: hunk.id, from: block.from, to: block.to, insert: hunk.before.join("\n") });
    }
    // CodeMirror 不接受同一批里重叠的 changes（定位是按内容做的，用户编辑后两块可能撞上）
    const { keep, dropped } = nonOverlappingChanges(plans);
    if (keep.length > 0) {
      view.dispatch({ changes: keep.map(({ from, to, insert }) => ({ from, to, insert })), scrollIntoView: true });
      view.focus();
      props.collab?.onUndone(keep.map((plan) => plan.id));
    }
    const stale = [...missing, ...dropped.map((plan) => plan.id)];
    if (stale.length > 0) setStaleIds((prev) => new Set([...prev, ...stale]));
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

  /**
   * 右键：把光标位置换算成行号（不移动光标、不动选区）。菜单里的「在 PDF 中定位」
   * 用被右键的那一行；「引用到对话」优先用选区原文，没有选区就是这一行。
   * 没有可给的菜单项时完全不拦右键（不抢浏览器 / CodeMirror 自己的行为）。
   */
  const contextMenuItems: MenuItem[] = menu === null
    ? []
    : [
        ...(props.onForwardSync === undefined
          ? []
          : [
              {
                id: "sync-forward",
                label: t.editor.locateInPdf,
                icon: "pin" as const,
                onSelect: () => {
                  const line = menu.line;
                  setMenu(null);
                  props.onForwardSync?.(line);
                },
              },
            ]),
        ...(props.onQuote === undefined
          ? []
          : [
              {
                id: "quote",
                label: t.editor.quoteLine,
                icon: "quote" as const,
                onSelect: () => {
                  const { text, line } = menu;
                  setMenu(null);
                  props.onQuote?.(text, line);
                },
              },
            ]),
      ];

  const openContextMenu = (event: React.MouseEvent<HTMLDivElement>): void => {
    if (props.onForwardSync === undefined && props.onQuote === undefined) return;
    const view = viewRef.current;
    if (view === null) return;
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    const target = view.state.doc.lineAt(pos);
    const selection = view.state.selection.main;
    // 只有点在选区**里面**才引选区：之前在别处留下的选区不该把这一行的右键引成另一段
    const insideSelection = !selection.empty && pos >= selection.from && pos <= selection.to;
    const text = insideSelection ? view.state.sliceDoc(selection.from, selection.to) : target.text;
    setMenu({ x: event.clientX, y: event.clientY, line: target.number, text });
  };

  return (
    <div className="tex-editor" ref={rootRef} onContextMenu={openContextMenu}>
      <ContextMenu
        position={menu === null ? null : { x: menu.x, y: menu.y }}
        items={contextMenuItems}
        onClose={() => setMenu(null)}
      />
      {readOnly && (
        <div className="tex-editor-banner" data-tone="info" role="status">
          <Icon
            name="lock"
            size={14}
            className="tex-editor-banner-icon"
            style={{ flex: "0 0 auto", marginTop: 1 }}
          />
          <span className="tex-editor-banner-text">
            {hold === "writing"
              ? t.editor.agentWriting
              : hold === "done"
                ? t.editor.agentWrote
                : t.editor.agentMayWrite}
          </span>
        </div>
      )}
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
      {hunks.length > 0 && !readOnly && (
        <div className="tex-editor-hunks" role="status">
          <div className="tex-editor-hunks-head">
            <Icon name="git-commit-horizontal" size={13} className="tex-editor-hunks-icon" />
            <span className="tex-editor-hunks-title">{t.editor.agentHunks(hunks.length)}</span>
            <span className="row-trailing tex-editor-hunks-acts">
              <button type="button" className="quiet-control" onClick={undoTurn}>
                {t.editor.undoTurn}
              </button>
              <button
                type="button"
                className="quiet-control tex-editor-hunks-toggle"
                aria-expanded={hunksOpen}
                title={hunksOpen ? t.editor.hunksHide : t.editor.hunksShow}
                onClick={() => setHunksOpen((open) => !open)}
              >
                <Icon name={hunksOpen ? "chevron-down" : "chevron-up"} size={12} strokeWidth={2} />
              </button>
            </span>
          </div>
          {hunksOpen && (
            <ul className="tex-editor-hunk-list">
              {hunks.map((hunk) => {
                const stale = staleIds.has(hunk.id);
                return (
                  <li key={hunk.id} className="tex-editor-hunk" data-stale={stale}>
                    <button
                      type="button"
                      className="tex-editor-hunk-goto"
                      title={hunk.preview}
                      onClick={() => {
                        const block = locate(hunk);
                        const view = viewRef.current;
                        if (block === null || view === null) {
                          setStaleIds((prev) => new Set(prev).add(hunk.id));
                          return;
                        }
                        view.dispatch({ selection: { anchor: block.from, head: block.to } });
                        view.focus();
                      }}
                    >
                      <span className="tex-editor-hunk-delta">
                        <span className="tex-editor-hunk-add">+{hunk.added}</span>
                        <span className="tex-editor-hunk-del">−{hunk.removed}</span>
                      </span>
                      <span className="tex-editor-hunk-preview">{hunk.preview}</span>
                    </button>
                    <span className="row-trailing">
                      {stale ? (
                        <span className="tex-editor-hunk-stale">{t.editor.hunkEdited}</span>
                      ) : (
                        <button
                          type="button"
                          className="quiet-control"
                          onClick={() => undoHunk(hunk)}
                        >
                          {t.editor.undoHunk}
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
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
