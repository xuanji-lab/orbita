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
import { registerDocxFlush, type DocxFlushOutcome } from "./docx-flush.ts";

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
        {state.reason !== "missing" && (
          <PanelButton onClick={openDefault}>
            <Icon name="external-link" size={14} />
            {t.files.openDefault}
          </PanelButton>
        )}
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

/** 不以单字符出现、但真的会改文档的键（其余编辑键 key.length === 1） */
const EDIT_KEYS = new Set(["Backspace", "Delete", "Enter", "Tab"]);

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
  /** 保存失败的原始信息：状态栏只写一句「保存失败」，细节放提示条（长报错不挤工具栏） */
  const [saveDetail, setSaveDetail] = useState<string | null>(null);
  /** 因为要离开这份文档才去保存、结果没成功：切走会被拒，必须明说「切走会丢字」 */
  const [leaveBlocked, setLeaveBlocked] = useState(false);
  /**
   * 关窗口 / 刷新被自己的 beforeunload 拦下之后的状态：
   * `saved` = 改动已经存好（再关一次就安全）；`blocked` = 没存成（给重试 / 强制关闭）。
   */
  const [unloadState, setUnloadState] = useState<"none" | "saved" | "blocked">("none");
  const rootRef = useRef<HTMLDivElement | null>(null);

  /** 磁盘内容的 hash：保存时的冲突判据，保存成功后更新 */
  const hashRef = useRef(opened.hash);
  /** 打开时的文档事实：保存前比对，判「会不会整份重排」 */
  const baselineRef = useRef<ReturnType<typeof docxFacts> | null>(null);
  const dirtyRef = useRef(false);
  /**
   * **独立于引擎的待存标志**（第二轮评审的阻断 1）。引擎的 `save()` 先把基线提交、
   * 再把字节交给宿主去写；写盘失败（EPERM / 冲突）时它已经认为自己是干净的，于是
   * 「有没有待存改动」如果只问 `hasPendingChanges()`，第二次问就会答「没有」——
   * 闸门放行、字永久丢失、状态还显示「未改动」。
   * 所以：用户一改就置位；**只有写盘成功**（或用户明确放弃 / 撤销回上一次成功写盘的
   * 内容且上一次确实成功）才清。
   */
  const pendingRef = useRef(false);
  /** 上一次写盘是否成功：决定「引擎说干净」能不能信 */
  const lastWriteOkRef = useRef(true);
  /** 连续自动重试次数（写盘失败后按退避重试，别无限敲同一扇打不开的门） */
  const autoRetryRef = useRef(0);
  /** beforeunload 被拦下后的「强制关闭」：这一次不再拦 */
  const forceCloseRef = useRef(false);
  /**
   * 改动计数。保存期间用户还能继续打字（引擎不锁输入），一次「旧快照」保存成功
   * 不能把状态说成「已保存」——落盘的是改动发生之前的那一版。所以每次改动 +1，
   * 保存前记一次，成功时只有计数没动才算干净。
   */
  const editSeqRef = useRef(0);
  /** 保存串行队列：自动保存、Ctrl+S、切走前的 flush 全排在这里，不会两条 rename 交叉 */
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
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
  /** 最新一版保存 / flush：键盘监听、定时器与登记表都经过它们，闭包不会读到旧的 state */
  const saveRef = useRef<(kind: "auto" | "manual") => void>(() => undefined);
  const flushRef = useRef<(cause: "manual" | "leave") => Promise<DocxFlushOutcome>>(async () => ({
    ok: true,
  }));

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

  /**
   * 用户一敲键就算「未保存」。不能只等引擎的 `onChange`：它比真实输入晚 0.7–1.5 s
   * （评审复现的丢字窗口就是这段延迟 + 自动保存的 1.5 s 定时器叠出来的），
   * 状态栏在那段时间里说着「未改动」，切走就没人救了。
   */
  const markDirty = useCallback(() => {
    editSeqRef.current += 1;
    dirtyRef.current = true;
    pendingRef.current = true;
    // 又改了：上一次关窗口/刷新被拦下时的那句反馈已经过时，收掉
    setUnloadState((prev) => (prev === "none" ? prev : "none"));
    // 已经是 dirty 就返回同一个对象（React 跳过这次更新）：否则每敲一个字都整树重渲染
    setSaveState((prev) => (prev.kind === "dirty" ? prev : { kind: "dirty" }));
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
  const onChange = useCallback(() => markDirty(), [markDirty]);
  const onEngineError = useCallback((error: Error) => {
    // 保真回退是「需要确认」，不是「坏了」：交给保存流程里的闸门处理
    if (/fidelity fallback/i.test(error.message)) {
      engineFallbackRef.current = true;
      return;
    }
    setFatal(error.message);
  }, []);

  /**
   * 还有没有没落盘的东西。**两个来源取或**：`pendingRef`（用户一敲键就置位，
   * 只有写盘成功才清）与引擎的 `hasPendingChanges()`（迟到，且写盘失败后会误报干净）。
   * 只信自己会漏（`Input.insertText` / 输入法 / 程序化写入不产生 keydown）；
   * 只信引擎则既慢又会漏掉写盘失败的那一版。
   */
  const hasUnsaved = (): boolean => {
    if (pendingRef.current || dirtyRef.current) return true;
    return editorRef.current?.hasPendingChanges() ?? false;
  };

  /** 写盘失败后的自动重试间隔（用户多半是去改文件权限 / 关掉占用的程序） */
  const AUTO_RETRY_MS = 5000;
  const AUTO_RETRY_LIMIT = 5;

  /** 真正落盘的那一步：判定重排 → 提示 → 序列化 → 写盘（冲突是值不是异常） */
  const performSave = useCallback(
    async (kind: "auto" | "manual"): Promise<DocxFlushOutcome> => {
      const ref = editorRef.current;
      if (ref === null) return { ok: true };
      if (!hasUnsaved()) return { ok: true };
      if (conflictRef.current) return { ok: false, reason: "conflict" };
      if (oversizeRef.current) return { ok: false, reason: "failed" };
      /*
       * 「撤销回到磁盘上的那一份」这条捷径**只在最后一次写盘成功时才可信**。
       * 写盘失败之后引擎也会说 hasPendingChanges=false（它在交给宿主之前就提交了
       * 基线），照它清标志就是评审复现的那条永久丢字路径。
       */
      if (lastWriteOkRef.current && !ref.hasPendingChanges()) {
        pendingRef.current = false;
        dirtyRef.current = false;
        setSaveState({ kind: "clean" });
        setLeaveBlocked(false);
        return { ok: true };
      }

      const seqAtStart = editSeqRef.current;
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
        return { ok: false, reason: "blocked" };
      }

      setSaveState({ kind: "saving" });
      try {
        engineFallbackRef.current = false;
        const buffer = await ref.save();
        if (buffer === null) {
          setSaveState({ kind: "failed", message: t.docx.saveFailed });
          setSaveDetail(null);
          return { ok: false, reason: "failed" };
        }
        if (engineFallbackRef.current && !confirmedRef.current) {
          // 引擎已经整份重排了一遍：这一份先不写，等用户确认
          setGate(["engine"]);
          return { ok: false, reason: "blocked" };
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
          setSaveDetail(null);
          return { ok: false, reason: "conflict" };
        }
        hashRef.current = result.hash;
        setBackupPath(result.backupPath ?? null);
        if (nowFacts !== null) baselineRef.current = nowFacts;
        confirmedRef.current = false;
        setGate(null);
        setSaveDetail(null);
        setLeaveBlocked(false);
        setUnloadState((prev) => (prev === "blocked" ? prev : "none"));
        lastWriteOkRef.current = true;
        autoRetryRef.current = 0;
        pendingRef.current = false;
        if (editSeqRef.current === seqAtStart && !ref.hasPendingChanges()) {
          dirtyRef.current = false;
          setSaveState({ kind: "saved", at: result.modifiedAt });
        } else {
          // 保存期间又改了：状态如实留在「未保存」，并再排一次自动保存
          dirtyRef.current = true;
          setSaveState({ kind: "dirty" });
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            saveRef.current("auto");
          }, DOCX_AUTOSAVE_DELAY_MS);
        }
        return { ok: true };
      } catch (cause: unknown) {
        const message = cause instanceof Error ? cause.message : String(cause);
        setSaveState({ kind: "failed", message: t.docx.saveFailed });
        // 权限 / 占用是最常见的写盘失败：说一句人话，原始报错留给 title（评审只要求
        // 「中文提示」，但把 EPERM 直接摊在脸上等于没解释）
        setSaveDetail(/EPERM|EACCES|EBUSY/.test(message) ? t.docx.writeBlocked : message);
        // 写盘没成功：待存标志必须留着（引擎已经认为干净了，见 pendingRef 的注释）
        pendingRef.current = true;
        lastWriteOkRef.current = false;
        // 有限次的自动重试：用户多半正在改权限 / 关占用的程序，别让他非按一次 Ctrl+S
        if (autoRetryRef.current < AUTO_RETRY_LIMIT) {
          autoRetryRef.current += 1;
          if (timerRef.current !== null) window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            saveRef.current("auto");
          }, AUTO_RETRY_MS);
        }
        return { ok: false, reason: "failed" };
      }
    },
    [request, t],
  );

  /** 排进串行队列：一次只跑一个保存，后来的等前一个结算 */
  const enqueueSave = useCallback(
    (kind: "auto" | "manual"): Promise<DocxFlushOutcome> => {
      const next = chainRef.current.then(
        () => performSave(kind),
        () => performSave(kind),
      );
      chainRef.current = next.catch(() => undefined);
      return next;
    },
    [performSave],
  );

  /**
   * 切走 / 关窗口前的 flush：把待存改动**全部**落盘。
   * 保存期间又改了的话（引擎不锁输入）再排一次，最多三轮——三轮还没干净就是
   * 真有问题，交给调用方「别切走」。
   */
  const flushNow = useCallback(
    async (cause: "manual" | "leave" = "manual"): Promise<DocxFlushOutcome> => {
      for (let round = 0; round < 3; round += 1) {
        const outcome = await enqueueSave("manual");
        if (!outcome.ok) {
          // 「因为要切走才保存」失败：必须让用户看见「切走会丢字」，否则他会以为
          // 只是普通保存报错，继续点别的文件/面板
          if (cause === "leave") setLeaveBlocked(true);
          return outcome;
        }
        if (!hasUnsaved()) return { ok: true };
      }
      if (hasUnsaved()) {
        if (cause === "leave") setLeaveBlocked(true);
        return { ok: false, reason: "failed" };
      }
      return { ok: true };
    },
    [enqueueSave],
  );

  saveRef.current = (kind) => {
    void enqueueSave(kind);
  };
  flushRef.current = flushNow;

  // 登记给「切标签 / 关标签 / 切会话 / 关窗口」的闸门（docx-flush.ts）
  useEffect(() => {
    return registerDocxFlush(request.dir, {
      flush: (cause) => flushRef.current(cause),
      pending: () => hasUnsaved(),
    });
  }, [request.dir]);

  /**
   * 键盘：Ctrl/Cmd+S 保存；其余编辑键**立刻**标脏。
   * 只在焦点落在本文档里时接管（`view.hasFocus()` 或事件目标在自己的根里）——
   * 否则别处输入框里的 Ctrl+S 会被这里悄悄吃掉。
   */
  useEffect(() => {
    const isMine = (event: KeyboardEvent): boolean => {
      const view = viewRef.current;
      if (view !== null && view.hasFocus()) return true;
      const root = rootRef.current;
      return root !== null && event.target instanceof Node && root.contains(event.target);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (!isMine(event)) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.altKey && event.key.toLowerCase() === "s") {
        event.preventDefault();
        event.stopPropagation();
        if (timerRef.current !== null) {
          window.clearTimeout(timerRef.current);
          timerRef.current = null;
        }
        void flushNow();
        return;
      }
      if (command || event.altKey) return;
      if (event.key.length === 1 || EDIT_KEYS.has(event.key)) markDirty();
    };
    // capture：引擎自己的快捷键监听在窗口内，抢在它前面拦下 Cmd/Ctrl+S
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [flushNow, markDirty]);

  /**
   * 不走 keydown 的编辑路径同样立刻标脏：粘贴 / 剪切、输入法组字、程序化写入
   * （`beforeinput` 覆盖 typing / paste / IME 三类，`input` 兜住只发后者的实现）。
   */
  useEffect(() => {
    const onEdit = (event: Event): void => {
      const view = viewRef.current;
      const focused = view !== null && view.hasFocus();
      const root = rootRef.current;
      const inside = root !== null && event.target instanceof Node && root.contains(event.target);
      if (!focused && !inside) return;
      markDirty();
    };
    const types = ["beforeinput", "input", "paste", "cut", "compositionstart"] as const;
    for (const type of types) window.addEventListener(type, onEdit, true);
    return () => {
      for (const type of types) window.removeEventListener(type, onEdit, true);
    };
  }, [markDirty]);

  /**
   * 关窗口的兜底：有没落盘的改动就先拦下这次卸载，flush 完再关。
   * （Windows 上点叉是「收进托盘」、页面不卸载；这条兜住的是真退出 / macOS 关窗。）
   */
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (forceCloseRef.current) return;
      if (!hasUnsaved()) return;
      event.preventDefault();
      event.returnValue = "";
      void flushNow("leave").then((outcome) => {
        if (outcome.ok) {
          /*
           * **不自动 window.close()**：beforeunload 分不清「用户在关窗口」与「页面
           * 在重载」（dev 的 Ctrl+R 也会走这里），自动 close 会在重载时把整个窗口关掉
           * ——实测过。存好之后只给一句反馈，用户再关一次 / 再刷一次就安全了。
           */
          setUnloadState("saved");
          return;
        }
        // 关不掉也不能「零反馈」（评审 R2）：把「没保存成功、关闭被拦下」摆出来，
        // 并给一条明确放弃的出口
        setUnloadState("blocked");
      });
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [flushNow]);

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
    <div className="docx-view" ref={rootRef} data-oversize={oversize ? "" : undefined}>
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
        <span
          className="docx-status row-trailing"
          data-kind={saveState.kind}
          title={saveDetail ?? statusText}
        >
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

      {leaveBlocked && conflict === null && (
        <div className="docx-note" data-tone="danger" role="alert">
          <Icon name="triangle-alert" size={14} />
          <span>{t.docx.leaveBlocked}</span>
          <div className="docx-note-actions">
            <button
              className="quiet-control docx-note-button"
              data-primary=""
              onClick={() => {
                void flushNow("manual");
              }}
            >
              {t.docx.retrySave}
            </button>
          </div>
        </div>
      )}

      {unloadState === "saved" && (
        <div className="docx-note" role="status">
          <Icon name="check" size={14} />
          <span>{t.docx.unloadSaved}</span>
        </div>
      )}

      {unloadState === "blocked" && (
        <div className="docx-note" data-tone="danger" role="alert">
          <Icon name="octagon-x" size={14} />
          <span>{t.docx.unloadBlocked}</span>
          <div className="docx-note-actions">
            <button
              className="quiet-control docx-note-button"
              data-primary=""
              onClick={() => {
                void flushNow("manual").then((outcome) => {
                  if (!outcome.ok) return;
                  forceCloseRef.current = true;
                  window.close();
                });
              }}
            >
              {t.docx.retrySave}
            </button>
            <button
              className="quiet-control docx-note-button"
              onClick={() => {
                // 明确放弃：用户点过这一下之后，关窗口不再被拦
                forceCloseRef.current = true;
                window.close();
              }}
            >
              {t.docx.closeAnyway}
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

      {saveDetail !== null && saveState.kind === "failed" && (
        <div className="docx-note" data-tone="danger" role="alert">
          <Icon name="octagon-x" size={14} />
          <span>{saveDetail}</span>
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
