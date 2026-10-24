import { useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { DocxEditor, type DocxEditorRef } from "@stll/folio-react";
import "@stll/folio-react/editor.css";
import { IntlProvider } from "use-intl";
import { CATALOGS } from "@stll/folio-core/i18n/messages/catalogs";
import { isMarkActive, toggleBold, toggleItalic, toggleUnderline } from "@stll/folio-core/prosemirror";
import type { DocxInvalidReason } from "@shared/docx";
import {
  DOCX_AUTOSAVE_DELAY_MS,
  DOCX_MAX_PAGES,
  estimateDocxPages,
  type DocxPackageStats,
} from "@shared/docx";
import type { FileListRequest } from "@shared/files";
import { api } from "../../api";
import { LocaleContext } from "../../locale.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { docxFacts, docxRepackReasons, type DocxFactsNode, type DocxRepackReason } from "./docx-change.ts";

/**
 * 应用内 docx 轻量编辑（issue #273 的第一刀）：打开、分页显示、改字、保存。
 *
 * 分工：**编辑与序列化全部交给 `@stll/folio`**（ProseMirror + 分页布局 + docx 写回），
 * 本组件只做四件事：
 *  1. 读盘（`docx:open`，白名单与 fs:read 同一道）→ 交给引擎；
 *  2. 工具栏：粗 / 斜 / 下划线、撤销 / 重做、保存 —— 命令走引擎自己的命令栈与历史栈；
 *  3. 保存：Ctrl/Cmd+S 显式保存 + 停手 1.5 s 自动保存，写盘走 hash 冲突检测；
 *  4. **保真闸门**：保存前若判定引擎会整份重排（判据与实测见 docx-change.ts 顶注释），
 *     先提示并等确认；自动保存遇到这种情况不写盘，只把提示挂出来——静默重排会让用户
 *     看不见版式整体挪动。上一版由主进程在覆盖前备份进应用数据目录。
 *
 * 不做（留给后续 PR）：表格 / 图片 / 批注 / 修订 / 查找替换 / 页眉页脚 / 样式管理器 / 域编辑。
 */
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "too-large"; limit: number; size: number }
  | { status: "invalid"; reason: DocxInvalidReason }
  | { status: "ready"; data: Uint8Array; hash: string; size: number; modifiedAt: number; stats: DocxPackageStats };

/** 读盘 + 分派空态。换文件或刷新时代整份重来（引擎按 hash 重新挂载） */
export function DocxView(props: { request: FileListRequest; reloadToken: number }) {
  const t = useT();
  const { request } = props;
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** 页数粗估超过上限时，用户仍然坚持打开 */
  const [forced, setForced] = useState(false);

  const key = `${request.root}\u0000${request.dir}\u0000${request.extraWorkspaceId ?? ""}\u0000${props.reloadToken}\u0000${attempt}`;
  useEffect(() => {
    let alive = true;
    setState({ status: "loading" });
    api.docx
      .open(request)
      .then((result) => {
        if (!alive) return;
        if (result.kind === "docx") {
          setState({
            status: "ready",
            data: result.data,
            hash: result.hash,
            size: result.size,
            modifiedAt: result.modifiedAt,
            stats: result.stats,
          });
        } else if (result.kind === "too-large") {
          setState({ status: "too-large", limit: result.limit, size: result.size });
        } else {
          setState({ status: "invalid", reason: result.reason });
        }
      })
      .catch((cause: unknown) => {
        if (!alive) return;
        setState({ status: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      alive = false;
    };
    // request 每次渲染都是新对象：按它的字段与刷新令牌重读，不按对象身份
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const openDefault = (): void => {
    void api.files.open(request).catch(() => {
      // 系统对话框自己会说为什么打不开，面板不另开一条错误态
    });
  };

  if (state.status === "loading") {
    return (
      <div className="file-preview-loading">
        <Icon name="loader-circle" size={14} spin />
        {t.common.loading}
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="file-preview-error">
        <PanelLine danger>{state.message}</PanelLine>
        <PanelButton onClick={() => setAttempt((n) => n + 1)}>{t.common.retry}</PanelButton>
      </div>
    );
  }
  if (state.status === "too-large") {
    return (
      <div className="file-preview-empty">
        <Icon name="file-text" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{t.docx.tooLarge(formatBytes(state.size), formatBytes(state.limit))}</PanelLine>
        <PanelButton onClick={openDefault}>
          <Icon name="external-link" size={14} />
          {t.files.openDefault}
        </PanelButton>
      </div>
    );
  }
  if (state.status === "invalid") {
    return (
      <div className="file-preview-empty">
        <Icon name="file-text" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{t.docx.invalid[state.reason]}</PanelLine>
        <PanelButton onClick={openDefault}>
          <Icon name="external-link" size={14} />
          {t.files.openDefault}
        </PanelButton>
      </div>
    );
  }
  /*
   * 页数异常的**挂载前**闸门：精确页数只有排完版才知道，而排一份 800 页的文档会把
   * 面板冻住两分钟（实测 828 页样本 125 s）。所以先用主进程数出的段落数 / 分页符
   * 粗估一次，超上限就先问，不直接挂引擎。用户坚持要开，再交给挂载后的真实页数判定
   * （超过就整份只读）。
   */
  const estimate = estimateDocxPages(state.stats);
  if (estimate > DOCX_MAX_PAGES && !forced) {
    return (
      <div className="file-preview-empty">
        <Icon name="file-text" size={24} style={{ color: "var(--color-text-tertiary)" }} />
        <PanelLine>{t.docx.oversizeEstimate(estimate, DOCX_MAX_PAGES)}</PanelLine>
        <PanelButton onClick={() => setForced(true)}>{t.docx.openAnyway}</PanelButton>
        <PanelButton onClick={openDefault}>
          <Icon name="external-link" size={14} />
          {t.files.openDefault}
        </PanelButton>
      </div>
    );
  }
  return (
    <DocxSurface
      // hash 变 = 磁盘上是另一份文档（重新加载 / 外部改过）：整份重新挂载引擎
      key={`${request.dir}:${state.hash}`}
      request={request}
      opened={state}
      onReload={() => setAttempt((n) => n + 1)}
    />
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1) return `${mb.toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "failed"; message: string };

type Marks = { bold: boolean; italic: boolean; underline: boolean };

const NO_MARKS: Marks = { bold: false, italic: false, underline: false };

/**
 * 挂着引擎的编辑面。`opened.hash` 是这一刻磁盘内容的身份：每次保存都带着它去判冲突，
 * 保存成功后换成新内容的 hash —— 于是「外部改了文件」与「我自己刚存过」不会混为一谈。
 */
function DocxSurface(props: {
  request: FileListRequest;
  opened: { data: Uint8Array; hash: string; size: number; modifiedAt: number };
  onReload: () => void;
}) {
  const t = useT();
  const locale = useContext(LocaleContext);
  const { request, opened } = props;

  const editorRef = useRef<DocxEditorRef | null>(null);
  /**
   * 可编辑的 ProseMirror 视图。**不从 `getEditor().getView()` 取**：分页编辑器里
   * 那个 headless controller 未必已就位（实测这一版在无工具栏形态下取不到视图），
   * 而 `onEditorViewReady` 是给宿主的正式出口，视图出现时它一定已经可以派发命令。
   */
  const viewRef = useRef<EditorView | null>(null);
  const [pages, setPages] = useState(0);
  const [oversize, setOversize] = useState(false);
  const [marks, setMarks] = useState<Marks>(NO_MARKS);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "clean" });
  const [gate, setGate] = useState<DocxRepackReason[] | null>(null);
  const [conflict, setConflict] = useState<"changed" | "missing" | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);

  /** 磁盘内容的 hash：保存时的冲突判据，保存成功后更新 */
  const hashRef = useRef(opened.hash);
  /** 打开时的文档事实：保存前比对，判「会不会整份重排」 */
  const baselineRef = useRef<ReturnType<typeof docxFacts> | null>(null);
  const dirtyRef = useRef(false);
  const busyRef = useRef(false);
  const queuedRef = useRef(false);
  const confirmedRef = useRef(false);
  /**
   * 引擎自己报告「这次保存发生了保真回退」（onError 里的 fidelity fallback）。
   * 正常路径用不到——判据在保存前用文档事实算；这是双保险：万一引擎的回退条件比
   * docx-change.ts 认得的多，这次保存的产物也不写盘，改成走同一条确认流程。
   */
  const engineFallbackRef = useRef(false);
  const timerRef = useRef<number | null>(null);
  const oversizeRef = useRef(false);
  const conflictRef = useRef(false);
  /** 最新一版保存函数：键盘监听与定时器都经过它，闭包不会读到旧的 state */
  const saveRef = useRef<(kind: "auto" | "manual") => void>(() => undefined);

  const getView = (): EditorView | null => viewRef.current;

  /**
   * 实际页数。`getTotalPages()` 这一版**不可靠**：同一份 828 页的文档它回报 1，
   * 2 页的样张回报 1（实测 folio 0.30）。用户看到的是画出来的页节点，所以取两者
   * 的较大值：`layout-page` 是引擎自己分页容器的类名（版本已锁死，改版名会先炸
   * 样式，不会静默）。
   */
  const readPageCount = (ref: DocxEditorRef): number => {
    const painted = ref.getScrollRoot()?.querySelectorAll(".layout-page").length ?? 0;
    return Math.max(ref.getTotalPages(), painted);
  };

  /**
   * 选区变化 → 工具栏的按下态。**值没变就返回同一个对象**：引擎会在每次选区变化时
   * 回调，setState 一个新对象会让本组件每次重渲染，而重渲染又给引擎换一份回调身份，
   * 形成渲染循环（实测过一次白屏）。所以这里按值比较，稳定引用。
   */
  const syncMarks = useCallback(() => {
    const view = getView();
    if (view === null) {
      setMarks((prev) => (prev === NO_MARKS ? prev : NO_MARKS));
      return;
    }
    const { marks: markTypes } = view.state.schema;
    const bold = markTypes["bold"] !== undefined && isMarkActive(view.state, markTypes["bold"]);
    const italic = markTypes["italic"] !== undefined && isMarkActive(view.state, markTypes["italic"]);
    const underline =
      markTypes["underline"] !== undefined && isMarkActive(view.state, markTypes["underline"]);
    setMarks((prev) =>
      prev.bold === bold && prev.italic === italic && prev.underline === underline
        ? prev
        : { bold, italic, underline },
    );
  }, []);

  // 分页数走引擎的布局事件；超过上限整份转只读（不再自动保存）——几百页的文档在
  // renderer 里编辑会让输入延迟肉眼可见，那不是这一刀要解决的问题
  useEffect(() => {
    const ref = editorRef.current;
    if (ref === null) return;
    const update = (): void => {
      const count = readPageCount(ref);
      setPages(count);
      if (count > DOCX_MAX_PAGES) {
        oversizeRef.current = true;
        setOversize(true);
      }
    };
    const off = ref.onLayoutChange(update);
    /**
     * 页数只能轮询。两个实测事实（folio 0.30）：`getTotalPages()` 在排版过程中先给
     * 一个偏小的数（2 页的样张一开始报 1），而 `onLayoutChange` 在纯排版完成时并不
     * 一定回调。所以：**看到超过上限就停，没看到就继续看**（每 750 ms 一次，页数
     * 是整数比较，开销可以忽略）；240 次 = 3 分钟后放弃，不值得再等。
     */
    let ticks = 0;
    const poll = window.setInterval(() => {
      ticks += 1;
      update();
      if (oversizeRef.current || ticks >= 240) window.clearInterval(poll);
    }, 750);
    return () => {
      off();
      window.clearInterval(poll);
    };
  }, []);

  // 引擎的可编辑视图是延迟创建的（性能取舍）：工具栏命令与「打开时的事实」都要它，
  // 所以挂载后主动要一份，但不抢焦点
  useEffect(() => {
    editorRef.current?.ensureEditorView({ focus: false });
  }, []);

  /**
   * 视图就绪 = 第一处「打开时的文档事实」。这个时机是确定的：用户只能通过这个视图
   * 编辑，所以它出现时文档一定还是磁盘上那一份（不会被后续编辑污染）。之前用定时器
   * 补一次的做法在慢机器上会晚于第一次编辑，基线就丢了——丢了就永远不会提示重排。
   */
  const onViewReady = useCallback(
    (view: EditorView | null) => {
      if (view === null) return;
      viewRef.current = view;
      baselineRef.current = docxFacts(view.state.doc as unknown as DocxFactsNode);
      syncMarks();
    },
    [syncMarks],
  );

  const scheduleAutosave = useCallback(() => {
    dirtyRef.current = true;
    setSaveState({ kind: "dirty" });
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      saveRef.current("auto");
    }, DOCX_AUTOSAVE_DELAY_MS);
  }, []);

  /**
   * 交给引擎的三份回调必须身份稳定：它们是引擎 effect 的依赖，每次渲染换一份会
   * 让引擎重跑（并再次回调我们），轻则白重渲染、重则渲染循环。
   */
  const onSelectionChange = useCallback(() => syncMarks(), [syncMarks]);
  const onChange = useCallback(() => scheduleAutosave(), [scheduleAutosave]);
  const onEngineError = useCallback((error: Error) => {
    // 保真回退是「需要确认」，不是「坏了」：交给保存流程里的闸门处理
    if (/fidelity fallback/i.test(error.message)) {
      engineFallbackRef.current = true;
      return;
    }
    setFatal(error.message);
  }, []);

  /** 真正落盘的那一步：判定重排 → 提示 → 序列化 → 写盘（冲突是值不是异常） */
  const runSave = useCallback(
    async (kind: "auto" | "manual") => {
      const ref = editorRef.current;
      if (ref === null || oversizeRef.current || conflictRef.current) return;
      if (busyRef.current) {
        queuedRef.current = true;
        return;
      }
      if (!dirtyRef.current) return;
      // 撤销回到磁盘上的那一份：没有待序列化的改动，就不用写盘，状态也退回「未改动」
      if (!ref.hasPendingChanges()) {
        dirtyRef.current = false;
        setSaveState({ kind: "clean" });
        return;
      }

      const view = getView();
      const nowFacts = view === null ? null : docxFacts(view.state.doc as unknown as DocxFactsNode);
      // 基线可能还没拿到（视图创建慢于第一次编辑）：拿不到就不做重排判定，
      // 而不是当成「结构变了」乱报警
      const reasons =
        nowFacts !== null && baselineRef.current !== null
          ? docxRepackReasons(baselineRef.current, nowFacts)
          : [];
      if (reasons.length > 0 && !confirmedRef.current) {
        // 自动保存绝不整份重排：提示挂出来，等用户按 Ctrl+S 或点「仍然保存」
        setGate(reasons);
        return;
      }

      busyRef.current = true;
      setSaveState({ kind: "saving" });
      try {
        engineFallbackRef.current = false;
        const buffer = await ref.save();
        if (buffer === null) {
          setSaveState({ kind: "failed", message: t.docx.saveFailed });
          return;
        }
        if (engineFallbackRef.current && !confirmedRef.current) {
          // 引擎已经整份重排了一遍：这一份先不写，等用户确认
          setGate(["engine"]);
          return;
        }
        const result = await api.docx.save({
          target: request,
          expectedHash: hashRef.current,
          data: new Uint8Array(buffer),
        });
        if (result.kind === "conflict") {
          conflictRef.current = true;
          setConflict(result.reason);
          setSaveState({ kind: "failed", message: t.docx.conflictShort });
          return;
        }
        hashRef.current = result.hash;
        setBackupPath(result.backupPath ?? null);
        if (nowFacts !== null) baselineRef.current = nowFacts;
        confirmedRef.current = false;
        dirtyRef.current = false;
        setGate(null);
        setSaveState({ kind: "saved", at: result.modifiedAt });
      } catch (cause: unknown) {
        setSaveState({
          kind: "failed",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      } finally {
        busyRef.current = false;
        if (queuedRef.current) {
          queuedRef.current = false;
          // 保存期间又改了：紧接着再存一次（改动不属于这次快照）
          if (dirtyRef.current) saveRef.current("auto");
        }
      }
    },
    [request, t],
  );

  // 定时器与键盘监听走 ref：它们只在挂载时绑定一次，不必跟着 runSave 的身份重绑
  saveRef.current = (kind) => {
    void runSave(kind);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
      if (event.key.toLowerCase() !== "s") return;
      event.preventDefault();
      event.stopPropagation();
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      saveRef.current("manual");
    };
    // capture：引擎自己的快捷键监听在窗口内，抢在它前面拦下 Cmd/Ctrl+S
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const runCommand = (command: Command): void => {
    const view = getView();
    if (view === null) return;
    command(view.state, view.dispatch, view);
    view.focus();
    syncMarks();
  };

  const statusText =
    saveState.kind === "saving"
      ? t.docx.saving
      : saveState.kind === "saved"
        ? t.docx.saved
        : saveState.kind === "failed"
          ? saveState.message
          : saveState.kind === "dirty"
            ? t.docx.unsaved
            : t.docx.clean;

  const editor = (
      <DocxEditor
        documentBuffer={opened.data}
        ref={editorRef}
        readOnly={oversize}
        showToolbar={false}
        showReviewControls={false}
        showHeaderFooterEditing={false}
        initialZoom="fit-width"
        onEditorViewReady={onViewReady}
        onSelectionChange={onSelectionChange}
        onChange={onChange}
        onError={onEngineError}
      />
  );

  return (
    <div className="docx-view" data-oversize={oversize ? "" : undefined}>
      <div className="docx-bar">
        <DocxTool
          icon="bold"
          label={t.docx.bold}
          pressed={marks.bold}
          disabled={oversize}
          onClick={() => runCommand(toggleBold)}
        />
        <DocxTool
          icon="italic"
          label={t.docx.italic}
          pressed={marks.italic}
          disabled={oversize}
          onClick={() => runCommand(toggleItalic)}
        />
        <DocxTool
          icon="underline"
          label={t.docx.underline}
          pressed={marks.underline}
          disabled={oversize}
          onClick={() => runCommand(toggleUnderline)}
        />
        <span className="docx-bar-sep" aria-hidden="true" />
        <DocxTool
          icon="undo-2"
          label={t.docx.undo}
          disabled={oversize}
          onClick={() => {
            editorRef.current?.undo();
            syncMarks();
          }}
        />
        <DocxTool
          icon="redo-2"
          label={t.docx.redo}
          disabled={oversize}
          onClick={() => {
            editorRef.current?.redo();
            syncMarks();
          }}
        />
        <span className="docx-status row-trailing" data-kind={saveState.kind}>
          {statusText}
        </span>
        <DocxTool
          icon="save"
          label={backupPath === null ? t.common.save : t.docx.savedWithBackup(backupPath)}
          disabled={oversize}
          onClick={() => saveRef.current("manual")}
        />
      </div>

      {oversize && (
        <div className="docx-note" role="status">
          <Icon name="info" size={14} />
          <span>{t.docx.oversize(DOCX_MAX_PAGES, pages)}</span>
        </div>
      )}

      {conflict !== null && (
        <div className="docx-note" data-tone="danger" role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>{conflict === "missing" ? t.docx.conflictMissing : t.docx.conflictChanged}</span>
          <div className="docx-note-actions">
            <button className="quiet-control docx-note-button" onClick={props.onReload}>
              {t.docx.reload}
            </button>
            <button
              className="quiet-control docx-note-button"
              onClick={() => {
                conflictRef.current = false;
                setConflict(null);
              }}
            >
              {t.docx.dismiss}
            </button>
          </div>
        </div>
      )}

      {gate !== null && conflict === null && (
        <div className="docx-note" role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>
            {t.docx.repackLead(gate.map((reason) => t.docx.repackReason[reason]).join(t.common.listSeparator))}
            {" "}
            {t.docx.backupHint}
          </span>
          <div className="docx-note-actions">
            <button
              className="quiet-control docx-note-button"
              onClick={() => setGate(null)}
            >
              {t.common.cancel}
            </button>
            <button
              className="quiet-control docx-note-button"
              data-primary=""
              onClick={() => {
                confirmedRef.current = true;
                saveRef.current("manual");
              }}
            >
              {t.docx.saveAnyway}
            </button>
          </div>
        </div>
      )}

      {fatal !== null && (
        <div className="docx-note" data-tone="danger" role="alert">
          <Icon name="octagon-x" size={14} />
          <span>{fatal}</span>
        </div>
      )}

      <div className="docx-page-area">
        <IntlProvider locale={locale === "zh" ? "zh-CN" : "en"} messages={CATALOGS[locale === "zh" ? "zh-CN" : "en"]}>
          {editor}
        </IntlProvider>
      </div>
    </div>
  );
}

function DocxTool(props: {
  icon: "bold" | "italic" | "underline" | "undo-2" | "redo-2" | "save";
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="quiet-control docx-tool"
      title={props.label}
      aria-label={props.label}
      aria-pressed={props.pressed === true ? true : undefined}
      disabled={props.disabled === true}
      // 按下工具栏不抢走文档里的选区：mousedown 的默认行为会让编辑器失焦
      onMouseDown={(event) => event.preventDefault()}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={14} strokeWidth={2} />
    </button>
  );
}
