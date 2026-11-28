import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Command } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import { DocxEditor, type DocxEditorRef } from "@stll/folio-react";
import "@stll/folio-react/editor.css";
import { IntlProvider } from "use-intl";
import { CATALOGS } from "@stll/folio-core/i18n/messages/catalogs";
import {
  TextSelection,
  alignCenter,
  alignLeft,
  alignRight,
  applyStyle,
  getDocumentStyleResolver,
  isMarkActive,
  toggleBold,
  toggleBulletList,
  toggleItalic,
  toggleNumberedList,
  toggleUnderline,
} from "@stll/folio-core/prosemirror";
import { addCommentMark } from "@stll/folio-core/prosemirror/commands/comments";
import { extractSelectionSnapshot } from "@stll/folio-core/prosemirror/selectionState";
import type { Comment } from "@stll/folio-core/types/document";
import type {
  DocxAgentEditRequest,
  DocxAnchor,
  DocxEditGroup,
  DocxInvalidReason,
  DocxParaIdStamp,
} from "@shared/docx";
import {
  DOCX_AUTOSAVE_DELAY_MS,
  DOCX_MAX_PAGES,
  estimateDocxPages,
  type DocxPackageStats,
} from "@shared/docx";
import { QUOTE_MAX_CHARS, type TextQuote } from "@shared/quote";
import { anchorFromSelection, blockAt, blockOrdinalMap } from "./docx-anchor.ts";
import { applyDocxEdit, resolveRevisionGroup } from "./docx-apply.ts";
import { registerDocxEditHost } from "./docx-edit-host.ts";
import { buildReviewRows, rowNeedsContext, type DocxChangeRow } from "./docx-review.ts";
import { DocxReviewBar } from "./DocxReviewBar.tsx";
import { DocxCommentsBar } from "./DocxCommentsBar.tsx";
import {
  commentDraftToComment,
  commentRows,
  nextCommentId,
  sameCommentAnchors,
  sameCommentQuote,
  sameComments,
  type CommentAnchorLike,
  type CommentDraftRange,
  type CommentRow,
} from "./docx-comments.ts";
import {
  FALLBACK_STYLE_CHOICE,
  alignmentIcon,
  listIcon,
  showsAlignmentButtons,
  showsListButtons,
  styleChoicesFrom,
  styleLabel,
  toolbarAlignment,
  toolbarDensity,
  toolbarList,
  type StyleChoice,
  type ToolbarAlignment,
  type ToolbarDensity,
  type ToolbarList,
} from "./docx-toolbar.ts";
import type { FileListRequest } from "@shared/files";
import { api } from "../../api";
import { LocaleContext } from "../../locale.ts";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import type { IconName } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { PanelButton, PanelLine } from "../../shell/RightPanel";
import { docxFacts, docxRepackReasons, type DocxFactsNode, type DocxRepackReason } from "./docx-change.ts";
import { registerDocxFlush, type DocxFlushOutcome } from "./docx-flush.ts";
import { applyTocHeal, collectTocFacts, layoutCoversDocument, planTocHeal, type TocHealLayout } from "./toc-heal.ts";

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
 * 不做（留给后续 PR）：表格增删行 / 图片替换 / 页面设置 / 页眉页脚 / 样式管理器 / 域编辑。
 * 2026-11-22 补了工具条（段落样式 / 对齐 / 列表）与批注（列表 + 新建），能力边界见
 * `docx-toolbar.ts` / `docx-comments.ts` 顶注释。
 */
type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "too-large"; limit: number; size: number }
  | { status: "invalid"; reason: DocxInvalidReason }
  | {
      status: "ready";
      data: Uint8Array;
      hash: string;
      size: number;
      modifiedAt: number;
      stats: DocxPackageStats;
      stamp: DocxParaIdStamp;
      /** 批注 / 修订的署名（主进程给）；空串由引擎退回默认名 */
      author: string;
    };

/** 读盘 + 分派空态。换文件或刷新时代整份重来（引擎按 hash 重新挂载） */
export function DocxView(props: {
  request: FileListRequest;
  reloadToken: number;
  /** 把锚点写成一条引用放进输入框（agent 据此调 edit_docx） */
  onQuote?: (quote: TextQuote) => void;
}) {
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
            stamp: result.stamp,
            author: result.author,
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
      {...(props.onQuote === undefined ? {} : { onQuote: props.onQuote })}
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

type MarkState = { bold: boolean; italic: boolean; underline: boolean };

/**
 * 工具条要跟手的那一格状态：字符格式 + 光标所在段落的样式 / 对齐 / 列表。
 * 段落部分来自 folio 的 `extractSelectionSnapshot`，与引擎自己的工具栏同一份投影。
 */
type FormatState = MarkState & {
  styleId: string;
  alignment: ToolbarAlignment;
  list: ToolbarList;
};

/**
 * 等版面跟上改动：总时长与轮询间隔。上界故意压得很短——保存不应该为了页码去等排版，
 * 等不到就这一轮不写页码（下一轮保存还有机会）。实测慢一拍的量级是一两帧（≤200 ms）。
 */
const LAYOUT_WAIT_MS = 600;
const LAYOUT_POLL_MS = 50;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/**
 * 选区 → 锚点的防抖时长。拖一次鼠标会连发几十个 selection 事件，而锚点要算一次
 * 块内干净文本（微秒级）+ 一次文档遍历（序号 / 表格坐标）。150 ms 对人是「松手就到」，
 * 对 104 页的文档也只多跑一次遍历。
 */
const ANCHOR_DEBOUNCE_MS = 150;

/**
 * 保存前那次目录自愈的结果（issue #276），只为界面提示；计数是「这次改了什么 / 什么没算出来」。
 * `noLayout` = 屏幕上还没有分页（排版没跑完），这一轮没有页码可对齐。
 */
type TocHealNote = {
  fieldsChanged: number;
  staticChanged: number;
  missed: number;
  noLayout: boolean;
};

const NO_FORMAT: FormatState = {
  bold: false,
  italic: false,
  underline: false,
  styleId: FALLBACK_STYLE_CHOICE.id,
  alignment: "left",
  list: "none",
};

/** 不以单字符出现、但真的会改文档的键（其余编辑键 key.length === 1） */
const EDIT_KEYS = new Set(["Backspace", "Delete", "Enter", "Tab"]);

/**
 * 挂着引擎的编辑面。`opened.hash` 是这一刻磁盘内容的身份：每次保存都带着它去判冲突，
 * 保存成功后换成新内容的 hash —— 于是「外部改了文件」与「我自己刚存过」不会混为一谈。
 */
function DocxSurface(props: {
  request: FileListRequest;
  opened: {
    data: Uint8Array;
    hash: string;
    size: number;
    modifiedAt: number;
    stamp: DocxParaIdStamp;
    author: string;
  };
  onQuote?: (quote: TextQuote) => void;
  onReload: () => void;
}) {
  const t = useT();
  const locale = useContext(LocaleContext);
  /**
   * 正文区的可读下限宽（px）：A4 纸面按 fit-width 缩到容器宽，窄于这个宽度时正文
   * 落到 ~9px 以下，审阅条点一行「跳到那一处」也读不清。低于它就给一句可操作提示
   * （拖宽面板 / 切稿件布局），不硬缩。
   */
  const DOCX_READABLE_WIDTH = 472;
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
  const [format, setFormat] = useState<FormatState>(NO_FORMAT);
  /** 工具条形态：面板宽度量出来之后才从「宽」降到「窄」 */
  const [density, setDensity] = useState<ToolbarDensity>("wide");
  /** 文档自己定义的段落样式（folio 的 resolver）；没有就只给 Normal */
  const [styleChoices, setStyleChoices] = useState<StyleChoice[]>([FALLBACK_STYLE_CHOICE]);
  /** 当前选区是否有可批注的文字（工具栏的批注键据此启用） */
  const [hasSelection, setHasSelection] = useState(false);
  /**
   * 批注显示用的一份。**开始是非受控的**：文档里已有的批注由引擎自己加载并回给我们
   * （`onCommentsChange` 在加载完成后会发一次），我们不抢所有权——受控数组一旦出错
   * 会在存盘时把文件里的批注元数据覆盖掉。
   * 只有用户**自己新建**一条时，才带着一份完整的数组切到受控（见 submitComment）。
   */
  const [comments, setComments] = useState<Comment[]>([]);
  /** 是否已切到受控 comments（用户本会话里加过批注） */
  const [controlComments, setControlComments] = useState(false);
  const [commentAnchors, setCommentAnchors] = useState<CommentAnchorLike[]>([]);
  const [commentDraft, setCommentDraft] = useState<CommentDraftRange | null>(null);
  const [commentText, setCommentText] = useState("");
  const [commentNote, setCommentNote] = useState<string | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: "clean" });
  const [gate, setGate] = useState<DocxRepackReason[] | null>(null);
  const [conflict, setConflict] = useState<"changed" | "missing" | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [backupPath, setBackupPath] = useState<string | null>(null);
  /** 保存失败的原始信息：状态栏只写一句「保存失败」，细节放提示条（长报错不挤工具栏） */
  const [saveDetail, setSaveDetail] = useState<string | null>(null);
  /** 上一次保存里目录自愈的结果（没有目录 / 没算出来都是 null 或计数，见 tocHealNoteText） */
  const [tocNote, setTocNote] = useState<TocHealNote | null>(null);
  /** 因为要离开这份文档才去保存、结果没成功：切走会被拒，必须明说「切走会丢字」 */
  const [leaveBlocked, setLeaveBlocked] = useState(false);
  /**
   * 关窗口 / 刷新被自己的 beforeunload 拦下之后的状态：
   * `saved` = 改动已经存好（再关一次就安全）；`blocked` = 没存成（给重试 / 强制关闭）。
   */
  const [unloadState, setUnloadState] = useState<"none" | "saved" | "blocked">("none");
  const rootRef = useRef<HTMLDivElement | null>(null);
  /**
   * 面板太窄（正文区 < 可读下限）：页是 A4、fit-width 缩到容器宽，再窄下去正文就
   * 读不清了。不硬缩——给一句可操作的提示（拖宽面板 / 切到稿件布局）。右栏
   * 的宽度规则属既有 UI，这一版不在 App 层强加下限（见报告里的提案）。
   */
  const [tooNarrow, setTooNarrow] = useState(false);
  useEffect(() => {
    const el = rootRef.current;
    if (el === null) return undefined;
    const measure = (): void => {
      const width = el.getBoundingClientRect().width;
      setTooNarrow(width > 0 && width < DOCX_READABLE_WIDTH);
      const next = toolbarDensity(width);
      setDensity((prev) => (prev === next ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /* ── N2「指哪打哪」：选区锚点 + agent 修订 + 审阅条 ────────────────────── */

  /**
   * 当前选区锚点。**选区事件里只做块内计算**（段落遍历 + 干净文本 + hash，微秒级）；
   * 文档级遍历（序号、表格坐标）也在这里做，但要防抖——鼠标拖选一次会连发几十个事件，
   * 每次全文档扫一遍会在长文档上卡掉帧（锚点调研 §5 的硬线）。
   */
  const [anchor, setAnchor] = useState<DocxAnchor | null>(null);
  const anchorRef = useRef<DocxAnchor | null>(null);
  /** 选区建不出锚点时的原因（跨段落 / 太长）：一句人话，不摆一个假 chip */
  const [anchorNote, setAnchorNote] = useState<string | null>(null);
  const selectionRef = useRef<{ from: number; to: number } | null>(null);
  const anchorTimerRef = useRef<number | null>(null);
  /** 本会话里 agent 写进去的改动（op → revisionIds）：审阅条按它整组裁决 */
  const groupsRef = useRef<DocxEditGroup[]>([]);
  const [reviewRows, setReviewRows] = useState<DocxChangeRow[]>([]);
  /** 刚写完的那一条（给一句确认） */
  const [editNote, setEditNote] = useState<string | null>(null);
  /** 一条编辑请求在途：界面显示「正在写入」并把裁决按钮禁掉，免得半途点 */
  const [editBusy, setEditBusy] = useState(false);

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
  const syncFormat = useCallback(() => {
    const view = getView();
    if (view === null) {
      setFormat((prev) => (prev === NO_FORMAT ? prev : NO_FORMAT));
      setHasSelection((prev) => (prev ? false : prev));
      return;
    }
    const { marks: markTypes } = view.state.schema;
    const bold = markTypes["bold"] !== undefined && isMarkActive(view.state, markTypes["bold"]);
    const italic = markTypes["italic"] !== undefined && isMarkActive(view.state, markTypes["italic"]);
    const underline =
      markTypes["underline"] !== undefined && isMarkActive(view.state, markTypes["underline"]);
    // 批注键的可用性也在这里跟手：折叠光标 = 没有可批注的文字
    const selected = view.state.selection.to > view.state.selection.from;
    setHasSelection((prev) => (prev === selected ? prev : selected));
    // 段落样式 / 对齐 / 列表走引擎自己的 selection snapshot（与它的工具栏同一份投影）。
    // 图片这类非段落选区没有这些字段，退回默认值；异常也不能带走字符格式的按下态。
    let styleId = FALLBACK_STYLE_CHOICE.id;
    let alignment: ToolbarAlignment = "left";
    let list: ToolbarList = "none";
    try {
      const snapshot = extractSelectionSnapshot(view.state);
      styleId = snapshot.styleId ?? FALLBACK_STYLE_CHOICE.id;
      alignment = toolbarAlignment(snapshot.paragraphFormatting.alignment);
      list = toolbarList(snapshot.listState.type);
    } catch {
      // 非段落选区（整张图片等）：保持默认值
    }
    setFormat((prev) =>
      prev.bold === bold &&
      prev.italic === italic &&
      prev.underline === underline &&
      prev.styleId === styleId &&
      prev.alignment === alignment &&
      prev.list === list
        ? prev
        : { bold, italic, underline, styleId, alignment, list },
    );
  }, []);

  /** 文档自己定义的段落样式。样式表在打开时就位；没有样式表的文档只给 Normal。 */
  const readStyleChoices = useCallback(() => {
    const view = getView();
    if (view === null) return;
    const resolver = getDocumentStyleResolver(view.state);
    const next = styleChoicesFrom(resolver?.getParagraphStyles() ?? []);
    setStyleChoices((prev) =>
      prev.length === next.length &&
      prev.every((choice, index) => choice.id === next[index]?.id && choice.label === next[index]?.label)
        ? prev
        : next,
    );
  }, []);

  /** 批注锚点（引擎按 comment mark 读）：文档一变就重算，供列表定位 */
  const refreshCommentAnchors = useCallback(() => {
    const ref = editorRef.current;
    if (ref === null) return;
    const next = ref.getCommentAnchors();
    setCommentAnchors((prev) => (sameCommentAnchors(prev, next) ? prev : next));
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
  // 所以挂载后主动要一份，但不抢焦点。ref 要等子组件的 ref 回调跑完才在，所以补一拍
  // （少了这一拍，用户没点过文档时 agent 的第一次 edit_docx 会一直等到超时）
  // 批注元数据 / 段落样式也要视图才读得到；慢文档解析更晚，多补一拍（1.2 s）。
  useEffect(() => {
    const kick = (): void => {
      editorRef.current?.ensureEditorView({ focus: false });
      readStyleChoices();
    };
    const first = window.setTimeout(kick, 0);
    const second = window.setTimeout(kick, 400);
    const third = window.setTimeout(kick, 1200);
    return () => {
      window.clearTimeout(first);
      window.clearTimeout(second);
      window.clearTimeout(third);
    };
  }, [readStyleChoices]);

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
      syncFormat();
      readStyleChoices();
      refreshCommentAnchors();
    },
    [readStyleChoices, refreshCommentAnchors, syncFormat],
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

  /* ── N2：审阅条、选区锚点、agent 写入 ───────────────────────────────────── */

  /** 审阅条数据：我们自己的改动账 + 引擎此刻的修订清单 */
  const refreshReview = useCallback(() => {
    const ref = editorRef.current;
    const changes = ref === null ? [] : ref.getTrackedChanges();
    setReviewRows(buildReviewRows(groupsRef.current, changes));
  }, []);

  /** 文档一变就重算（300 ms 防抖：排版与修订遍历都不便宜，每次敲键跑一遍会掉帧） */
  const reviewTimerRef = useRef<number | null>(null);
  const refreshReviewLater = useCallback(() => {
    if (reviewTimerRef.current !== null) window.clearTimeout(reviewTimerRef.current);
    reviewTimerRef.current = window.setTimeout(() => {
      reviewTimerRef.current = null;
      refreshReview();
      refreshCommentAnchors();
    }, 300);
  }, [refreshCommentAnchors, refreshReview]);

  /** 选区 → 锚点（防抖：拖选一次会连发几十个事件，每个都做全文档遍历会卡） */
  const buildAnchor = useCallback(() => {
    // 用 ref 取视图，不进依赖：getView 每次渲染都是新函数，进了依赖会让
    // onSelectionText 每帧换身份——引擎的回调依赖它会重跑（本文件顶注释里的渲染循环）
    const view = viewRef.current;
    const selection = selectionRef.current;
    if (view === null || selection === null || selection.to <= selection.from) {
      anchorRef.current = null;
      setAnchor(null);
      setAnchorNote(null);
      return;
    }
    const doc = view.state.doc;
    const block = blockAt(doc, selection.from);
    const next =
      block === null
        ? null
        : anchorFromSelection({
            path: request.dir,
            docHash: opened.hash,
            editSeq: editSeqRef.current,
            block,
            from: selection.from,
            to: selection.to,
            doc,
          });
    if (next !== null && Array.from(next.quote).length > QUOTE_MAX_CHARS) {
      // 引用的总字数上限（2000）同时是锚点的上限：再长就不是「指一处」，也不该整段塞进消息
      anchorRef.current = null;
      setAnchor(null);
      setAnchorNote(t.docx.anchorTooLong(QUOTE_MAX_CHARS));
      return;
    }
    anchorRef.current = next;
    setAnchor(next);
    setAnchorNote(next === null ? t.docx.anchorSpanBlock : null);
  }, [request.dir, opened.hash, t]);

  const queueAnchor = useCallback(
    (selection: { from: number; to: number }) => {
      selectionRef.current = selection;
      if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current);
      anchorTimerRef.current = window.setTimeout(() => {
        anchorTimerRef.current = null;
        buildAnchor();
      }, ANCHOR_DEBOUNCE_MS);
    },
    [buildAnchor],
  );

  /**
   * 引擎的选区回调：这里只记账 + 排一次防抖。`syncFormat` 走 onSelectionChange
   * 同步跑（工具栏按下态要跟手），锚点可以慢半拍——它是给 agent 用的坐标，不是给眼睛看的。
   */
  const onSelectionText = useCallback(
    (selection: { from: number; to: number }) => {
      queueAnchor({ from: selection.from, to: selection.to });
      const next = selection.to > selection.from;
      setHasSelection((prev) => (prev === next ? prev : next));
    },
    [queueAnchor],
  );

  /**
   * 一条 agent 写入请求（主进程转过来的）：写进活编辑器，回执交给登记表。
   *
   * **刚打开的那几百毫秒里引擎还没有可编辑视图**（`createAIEditSnapshot()` 回 null）：
   * `not-ready` 不是失败，等一拍重试（最多 6 × 150 ms）。真等不到再如实回给模型。
   */
  const runAgentEdit = useCallback(
    async (next: DocxAgentEditRequest, author: string) => {
      setEditBusy(true);
      try {
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const ref = editorRef.current;
          if (ref === null) {
            return { ok: false as const, reason: "not-open" as const, error: "编辑器还在加载，稍后再试。" };
          }
          // 引擎的可编辑视图是**延迟创建**的：用户还没在文档里点过，视图可能根本不存于。
          // 写入前主动要一份（同工具栏命令的做法），再等一拍让引擎把它建出来
          if (attempt > 0) ref.ensureEditorView({ focus: false });
          const outcome = applyDocxEdit({ ref, author: author === "" ? t.docx.agentAuthor : author }, next);
          if (outcome.ok === false && outcome.reason === "not-ready") {
            await sleep(150);
            continue;
          }
          if (outcome.ok) {
            groupsRef.current = [...groupsRef.current, ...outcome.groups];
            setEditNote(
              outcome.groups.length === 0
                ? t.docx.agentEditNothing
                : t.docx.agentEditDone(outcome.groups.length, outcome.skipped.length),
            );
            // 修订已经进内存：按普通编辑记账，1.5 s 后自动落盘（保存路径仍是 #308 那一条）
            markDirty();
          } else {
            setEditNote(outcome.error);
          }
          refreshReview();
          return outcome;
        }
        return { ok: false as const, reason: "engine" as const, error: "编辑器一直没就绪（排版卡住了？）。让用户点一下编辑器再试。" };
      } finally {
        setEditBusy(false);
      }
    },
    [markDirty, refreshReview, t],
  );
  const runAgentEditRef = useRef(runAgentEdit);
  runAgentEditRef.current = runAgentEdit;

  // 登记成「这份文档的编辑宿主」：主进程推来的 edit_docx 请求按路径找到这里
  useEffect(() => {
    return registerDocxEditHost({
      path: request.dir,
      apply: (next, author) => runAgentEditRef.current(next, author),
    });
  }, [request.dir]);

  /** 裁决一整组（一次 replace 的删除 + 插入两个 w:id 必须一起走，否则残留半条修订） */
  const resolveRow = useCallback(
    (row: DocxChangeRow, decision: "accept" | "reject") => {
      const ref = editorRef.current;
      if (ref === null) return;
      const ok = resolveRevisionGroup(ref, row.revisionIds, decision);
      if (!ok) {
        // 这组 id 已经不在了（用户单独接受过 / 撤销过）：不当作错误，只刷新一次
        setEditNote(t.docx.reviewStale);
      } else {
        setEditNote(null);
        markDirty();
      }
      refreshReview();
    },
    [markDirty, refreshReview, t],
  );

  /** 整批：把审阅条上所有行一起接受 / 拒绝（用户说「全都不要」时不必一条条点） */
  const resolveAll = useCallback(
    (decision: "accept" | "reject") => {
      const ref = editorRef.current;
      if (ref === null) return;
      for (const row of reviewRows) resolveRevisionGroup(ref, row.revisionIds, decision);
      groupsRef.current = [];
      setEditNote(null);
      markDirty();
      refreshReview();
    },
    [markDirty, refreshReview, reviewRows],
  );

  /**
   * 审阅条的一次初始计算。挂在 `pages` 上而不是挂载时立刻算：引擎的视图是延迟创建的，
   * 挂载那一刻 `getTrackedChanges()` 还是空的；排版落定（页数变化）时修订清单已经可读。
   */
  useEffect(() => {
    refreshReview();
  }, [pages, refreshReview]);

  /**
   * 审阅条要的段号表：**只在有「文字太短、看不出位置」的行时才建**（一次文档遍历）。
   * 重开文档后退回启发式分组，我们的账没了，行里可能只剩「8 → 5」——段号是仅剩的定位线索。
   */
  const reviewOrdinals = useMemo(() => {
    if (!reviewRows.some(rowNeedsContext)) return new Map<string, number>();
    const view = viewRef.current;
    return view === null ? new Map<string, number>() : blockOrdinalMap(view.state.doc);
  }, [reviewRows]);

  /** 把当前锚点写成一条引用放进输入框（agent 据此调 edit_docx） */
  const quoteAnchor = (): void => {
    const current = anchorRef.current;
    if (current === null || props.onQuote === undefined) return;
    // 不截断：锚点的偏移与引文必须逐字对应，截了就不是同一处了（超长选区在上面被拒）
    props.onQuote({
      text: current.quote,
      messageId: "",
      role: "user",
      filePath: current.path,
      docx: current,
    });
    anchorRef.current = null;
    selectionRef.current = null;
    setAnchor(null);
    setAnchorNote(null);
    setEditNote(t.docx.anchorQuoted);
  };

  /** 点审阅条一行：滚到那一处并选中（引擎的 scrollToAIEditOperation，按整组 id） */
  const locateRow = (row: DocxChangeRow): void => {
    editorRef.current?.scrollToAIEditOperation(row.revisionIds);
  };

  const anchorLabelText =
    anchor === null
      ? ""
      : anchor.table === null
        ? t.docx.anchorLabel(anchor.blockOrdinal, Array.from(anchor.quote).length)
        : t.docx.anchorTableLabel(anchor.table.rowIndex + 1, anchor.table.cellIndex + 1, Array.from(anchor.quote).length);

  // 说明性的提示（"请在一个段落内选择"）自己退场：用户可以什么都不做，它不该一直挂在那里
  useEffect(() => {
    if (anchorNote === null) return;
    const timer = window.setTimeout(() => setAnchorNote(null), 4000);
    return () => window.clearTimeout(timer);
  }, [anchorNote]);

  useEffect(() => {
    return () => {
      if (anchorTimerRef.current !== null) window.clearTimeout(anchorTimerRef.current);
      if (reviewTimerRef.current !== null) window.clearTimeout(reviewTimerRef.current);
    };
  }, []);

  /**
   * 交给引擎的三份回调必须身份稳定：它们是引擎 effect 的依赖，每次渲染换一份会
   * 让引擎重跑（并再次回调我们），轻则白重渲染、重则渲染循环。
   */
  const onSelectionChange = useCallback(() => syncFormat(), [syncFormat]);
  /**
   * 文档变了一次。**非受控时**引擎会在加载完成后把文档里的批注数组回给我们
   * （`onCommentsChange`），列表靠它显示；我们不自作主张播种。
   */
  const onChange = useCallback(() => {
    markDirty();
    refreshReviewLater();
  }, [markDirty, refreshReviewLater]);
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

  /**
   * 保存前的目录页码自愈（issue #276）。判定与计划在 toc-heal.ts（纯函数），这里只做接线：
   * 屏幕上那一份 layout + 当前文档 → 计划 → 派发一次事务。
   *
   * **版面必须已经跟上这一次改动**：保存紧跟输入时 `getLayout()` 会慢一拍（实测：打字后
   * 250 ms 按 Ctrl+S，拿到的是改前的四页版面，而文档已是五页）。这里等它一拍（最多
   * 600 ms），等不到就这一轮不动任何页码——宁可旧数字，不写错数字。
   *
   * **失败不阻塞保存**：没有视图、排版没跟上、计划或写回抛错，都只返回计数交给界面提示；
   * 计划为空（没有目录 / 页码已经对）就不派发——文档一个字节都不动。
   */
  const healTocNumbers = async (view: EditorView | null): Promise<TocHealNote | null> => {
    const editor = editorRef.current?.getEditorRef();
    const target = editor?.getView() ?? view;
    if (target === null) return null;
    const doc = target.state.doc;
    const facts = collectTocFacts(doc);
    if (facts.fields.length === 0 && facts.staticEntries.length === 0) return null;
    const total = facts.fields.length + facts.staticEntries.length;
    let layout = editor?.getLayout() ?? null;
    if (layout === null) return { fieldsChanged: 0, staticChanged: 0, missed: 0, noLayout: true };
    // 版面还没排到文档末尾 = 还是改动前那一版：等一拍。等的时候用户又改了就不算了，
    // 这一轮交给下一次保存（位置对不上的计划比旧页码更糟）
    const deadline = performance.now() + LAYOUT_WAIT_MS;
    while (!layoutCoversDocument(layout, doc.content.size)) {
      if (performance.now() >= deadline || target.state.doc !== doc) {
        return { fieldsChanged: 0, staticChanged: 0, missed: 0, noLayout: true };
      }
      await sleep(LAYOUT_POLL_MS);
      const next = editor?.getLayout() ?? null;
      if (next === null) return { fieldsChanged: 0, staticChanged: 0, missed: 0, noLayout: true };
      layout = next;
    }
    try {
      const plan = planTocHeal(facts, layout);
      if (plan.ops.length > 0) {
        const tr = target.state.tr;
        applyTocHeal(tr, plan);
        target.dispatch(tr);
      }
      return {
        fieldsChanged: plan.changed - plan.staticChanged,
        staticChanged: plan.staticChanged,
        missed: plan.missed,
        noLayout: false,
      };
    } catch {
      // 字段结构异常 / 引擎状态在两次读之间变了：这一轮一条都不改，交给界面说「没定位到」
      return { fieldsChanged: 0, staticChanged: 0, missed: total, noLayout: false };
    }
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

      // 目录页码自愈（issue #276）：先把 PAGEREF 域的缓存页码对齐到屏幕上这一份分页，再序列化。
      // 它只改域缓存与静态目录的尾部数字，不动段落 / 表格成员，所以不影响上面的重排判定。
      // 这一步在我们自己的派发里，不计入「用户在保存期间又改了」——序号在它之后取。
      setTocNote(await healTocNumbers(view));
      const seqAtStart = editSeqRef.current;

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
    syncFormat();
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

  /** 上一次保存里目录自愈的结果：只说确实发生了什么，没事就一句不说 */
  const tocNoteText = ((): string => {
    if (tocNote === null) return "";
    if (tocNote.noLayout) return t.docx.tocNoLayout;
    const parts: string[] = [];
    if (tocNote.fieldsChanged > 0) parts.push(t.docx.tocHealed(tocNote.fieldsChanged));
    if (tocNote.staticChanged > 0) parts.push(t.docx.tocStatic(tocNote.staticChanged));
    if (tocNote.missed > 0) parts.push(t.docx.tocMissed(tocNote.missed));
    // 中文句子自带句号，不用再加空格；英文靠空格分开
    return parts.join(locale === "zh" ? "" : " ");
  })();

  const docxAuthor = opened.author === "" ? t.docx.commentAuthor : opened.author;
  /**
   * 引擎回报的批注数组 → 列表用的那一份。值不变就保住引用，否则文档每改一次
   * 都会用一份内容相同的新数组让本组件重渲染一轮。
   */
  const onCommentsChange = useCallback((next: Comment[]) => {
    setComments((prev) => (sameComments(prev, next) ? prev : next));
  }, []);
  const commentRowsView = useMemo(
    () => commentRows(comments, commentAnchors, locale),
    [comments, commentAnchors, locale],
  );

  const editor = (
      <DocxEditor
        documentBuffer={opened.data}
        ref={editorRef}
        /*
         * **只读只看页数**：回合内不锁输入。folio 在只读视图上会把这次 dispatch 丢掉——
         * 实测「applied 有回执、文档里没有标记」，而 agent 的修订只能走这条路。
         * 并发打字的防护换在写入那一刻：锚点按偏移 + 引文重新校验，命中不了就拒绝写入。
         */
        readOnly={oversize}
        author={docxAuthor}
        comments={controlComments ? comments : undefined}
        onCommentsChange={onCommentsChange}
        showToolbar={false}
        showReviewControls={false}
        showHeaderFooterEditing={false}
        initialZoom="fit-width"
        onEditorViewReady={onViewReady}
        onSelectionChange={onSelectionChange}
        onSelectionTextChange={onSelectionText}
        onChange={onChange}
        onError={onEngineError}
      />
  );

  const wideTools = showsAlignmentButtons(density);
  const alignmentItems: MenuItem[] = [
    {
      id: "align-left",
      label: t.docx.alignLeft,
      icon: "align-left",
      checked: format.alignment === "left",
      onSelect: () => runCommand(alignLeft),
    },
    {
      id: "align-center",
      label: t.docx.alignCenter,
      icon: "align-center",
      checked: format.alignment === "center",
      onSelect: () => runCommand(alignCenter),
    },
    {
      id: "align-right",
      label: t.docx.alignRight,
      icon: "align-right",
      checked: format.alignment === "right",
      onSelect: () => runCommand(alignRight),
    },
  ];
  const listItems: MenuItem[] = [
    {
      id: "bullet",
      label: t.docx.bulletList,
      icon: "list",
      checked: format.list === "bullet",
      onSelect: () => runCommand(toggleBulletList),
    },
    {
      id: "numbered",
      label: t.docx.numberedList,
      icon: "list-ordered",
      checked: format.list === "numbered",
      onSelect: () => runCommand(toggleNumberedList),
    },
  ];

  /** 新建批注：先把当前选区收成草稿；文字变过就拒绝提交（submitComment 里复核） */
  const startComment = (): void => {
    const view = getView();
    if (view === null) {
      setCommentNote(t.docx.commentWriteFailed);
      return;
    }
    const { from, to } = view.state.selection;
    if (to <= from) return;
    setCommentDraft({ from, to, quote: view.state.doc.textBetween(from, to, "\n") });
    setCommentText("");
    setCommentNote(null);
  };

  const cancelComment = (): void => {
    setCommentDraft(null);
    setCommentText("");
    setCommentNote(null);
  };

  /**
   * 提交批注：校验选区仍指向同一段文字 → 把 mark 写进活文档 → 追加同 id 的元数据。
   * 两步必须同 id：mark 是锚点，元数据是作者 / 时间 / 正文（见 docx-comments.ts 顶注释）。
   */
  const submitComment = (): void => {
    if (commentDraft === null) return;
    const view = getView();
    const body = commentText.trim();
    if (view === null || body === "") {
      setCommentNote(t.docx.commentWriteFailed);
      return;
    }
    const current = view.state.doc.textBetween(commentDraft.from, commentDraft.to, "\n");
    if (!sameCommentQuote(current, commentDraft.quote)) {
      setCommentNote(t.docx.commentStaleSelection);
      return;
    }
    // 新建这条要连元数据一起落进去：切到受控 comments，数组必须**完整**（含文档里
    // 已有的那几条）。以 controller 的文档为准——它是引擎此刻真正拥有的全量。
    const owned = editorRef.current?.getEditor()?.getDocument()?.package.document.comments ?? comments;
    const id = nextCommentId(owned);
    try {
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, commentDraft.from, commentDraft.to)),
      );
    } catch {
      setCommentNote(t.docx.commentStaleSelection);
      return;
    }
    if (!addCommentMark(id)(view.state, view.dispatch)) {
      setCommentNote(t.docx.commentWriteFailed);
      return;
    }
    setComments([...owned, commentDraftToComment(body, docxAuthor, id, new Date().toISOString())]);
    setControlComments(true);
    setCommentDraft(null);
    setCommentText("");
    setCommentNote(t.docx.commentAdded);
    refreshCommentAnchors();
    view.focus();
  };

  /** 点批注行：用引擎的 passage 高亮跳到锚点；锚点没了就明说，不假装跳了 */
  const locateComment = (row: CommentRow): void => {
    if (row.blockId === null) {
      setCommentNote(t.docx.commentAnchorMissing);
      return;
    }
    const outcome = editorRef.current?.highlightPassage({ blockId: row.blockId, text: row.quote });
    setCommentNote(outcome === undefined || outcome === "none" ? t.docx.commentAnchorMissing : null);
  };

  return (
    <div className="docx-view" ref={rootRef} data-oversize={oversize ? "" : undefined}>
      <div className="docx-bar">
        <DocxStyleMenu
          choices={styleChoices}
          value={format.styleId}
          compact={!wideTools}
          disabled={oversize}
          onChange={(styleId) => runCommand(applyStyle(styleId))}
        />
        <span className="docx-bar-sep" aria-hidden="true" />
        <DocxTool
          icon="bold"
          label={t.docx.bold}
          pressed={format.bold}
          disabled={oversize}
          onClick={() => runCommand(toggleBold)}
        />
        <DocxTool
          icon="italic"
          label={t.docx.italic}
          pressed={format.italic}
          disabled={oversize}
          onClick={() => runCommand(toggleItalic)}
        />
        <DocxTool
          icon="underline"
          label={t.docx.underline}
          pressed={format.underline}
          disabled={oversize}
          onClick={() => runCommand(toggleUnderline)}
        />
        {wideTools ? (
          <>
            <DocxTool
              icon="align-left"
              label={t.docx.alignLeft}
              pressed={format.alignment === "left"}
              disabled={oversize}
              onClick={() => runCommand(alignLeft)}
            />
            <DocxTool
              icon="align-center"
              label={t.docx.alignCenter}
              pressed={format.alignment === "center"}
              disabled={oversize}
              onClick={() => runCommand(alignCenter)}
            />
            <DocxTool
              icon="align-right"
              label={t.docx.alignRight}
              pressed={format.alignment === "right"}
              disabled={oversize}
              onClick={() => runCommand(alignRight)}
            />
          </>
        ) : (
          <DocxMenuTool
            icon={alignmentIcon(format.alignment)}
            label={t.docx.paragraphMenu}
            disabled={oversize}
            items={alignmentItems}
          />
        )}
        {showsListButtons(density) ? (
          <>
            <DocxTool
              icon="list"
              label={t.docx.bulletList}
              pressed={format.list === "bullet"}
              disabled={oversize}
              onClick={() => runCommand(toggleBulletList)}
            />
            <DocxTool
              icon="list-ordered"
              label={t.docx.numberedList}
              pressed={format.list === "numbered"}
              disabled={oversize}
              onClick={() => runCommand(toggleNumberedList)}
            />
          </>
        ) : (
          <DocxMenuTool
            icon={listIcon(format.list)}
            label={t.docx.listMenu}
            disabled={oversize}
            items={listItems}
          />
        )}
        <DocxTool
          icon="message-square"
          label={t.docx.commentAdd}
          pressed={commentDraft !== null}
          disabled={oversize || !hasSelection}
          onClick={startComment}
        />
        <span className="docx-bar-sep" aria-hidden="true" />
        <DocxTool
          icon="undo-2"
          label={t.docx.undo}
          disabled={oversize}
          onClick={() => {
            editorRef.current?.undo();
            syncFormat();
          }}
        />
        <DocxTool
          icon="redo-2"
          label={t.docx.redo}
          disabled={oversize}
          onClick={() => {
            editorRef.current?.redo();
            syncFormat();
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

      {commentDraft !== null && (
        <div className="docx-comment-compose">
          <div className="docx-comment-quote" title={commentDraft.quote}>
            <Icon name="message-square" size={12} />
            <span>{commentDraft.quote}</span>
          </div>
          <textarea
            className="docx-comment-input"
            value={commentText}
            placeholder={t.docx.commentPlaceholder}
            rows={2}
            autoFocus
            onChange={(event) => setCommentText(event.target.value)}
            onKeyDown={(event) => {
              // Ctrl/Cmd+Enter 提交；Esc 取消（批量改稿时不想为一条批注去摸鼠标）
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitComment();
              } else if (event.key === "Escape") {
                event.preventDefault();
                cancelComment();
              }
            }}
          />
          <div className="docx-comment-actions">
            <button
              type="button"
              className="quiet-control docx-note-button"
              disabled={commentText.trim() === ""}
              onClick={submitComment}
            >
              {t.docx.commentSubmit}
            </button>
            <button type="button" className="quiet-control docx-note-button" onClick={cancelComment}>
              {t.docx.commentCancel}
            </button>
          </div>
        </div>
      )}

      {commentNote !== null && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="message-square" size={14} />
          <span>{commentNote}</span>
        </div>
      )}

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

      {tocNoteText !== "" && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="info" size={14} />
          <span>{tocNoteText}</span>
        </div>
      )}

      {/* 盖章结果（N2）：盖上时说一句「补了多少段」，盖不上时说清「锚点只活在本次打开」 */}
      {opened.stamp.ok && opened.stamp.assigned > 0 && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="info" size={14} />
          <span>{t.docx.stampNote(opened.stamp.assigned)}</span>
        </div>
      )}
      {!opened.stamp.ok && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="info" size={14} />
          <span>{t.docx.stampFailed}</span>
        </div>
      )}

      {/* 选区锚点（N2）：可读 chip + 一键放进输入框 */}
      {anchor !== null && (
        <div className="docx-anchor-row">
          <button
            type="button"
            className="quiet-control docx-anchor-chip"
            title={t.docx.anchorQuoteTitle}
            aria-label={`${anchorLabelText} — ${t.docx.anchorQuote}`}
            disabled={props.onQuote === undefined}
            onClick={quoteAnchor}
          >
            <Icon name="quote" size={12} />
            <span className="docx-anchor-label">{anchorLabelText}</span>
          </button>
          <button
            type="button"
            className="quiet-control docx-anchor-clear"
            title={t.docx.anchorClear}
            aria-label={t.docx.anchorClear}
            onClick={() => {
              anchorRef.current = null;
              selectionRef.current = null;
              setAnchor(null);
            }}
          >
            <Icon name="x" size={11} strokeWidth={2.2} />
          </button>
        </div>
      )}
      {anchorNote !== null && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="info" size={14} />
          <span>{anchorNote}</span>
        </div>
      )}

      {/* 审阅条（N2）：一行一条改动，按 applied[].revisionIds 整组裁决 */}
      <DocxReviewBar
        rows={reviewRows}
        ordinals={reviewOrdinals}
        busy={editBusy}
        onResolve={resolveRow}
        onAll={resolveAll}
        onLocate={locateRow}
      />

      {/* 批注条（2026-11-22）：与审阅条同一块区域，点一行跳到锚点 */}
      <DocxCommentsBar rows={commentRowsView} onLocate={locateComment} />

      {editBusy && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="loader-circle" size={14} spin />
          <span>{t.docx.agentWriting}</span>
        </div>
      )}
      {editNote !== null && !editBusy && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="info" size={14} />
          <span>{editNote}</span>
        </div>
      )}

      {tooNarrow && (
        <div className="docx-note" data-tone="info" role="status">
          <Icon name="arrow-left-right" size={14} />
          <span>{t.docx.tooNarrow}</span>
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
  icon:
    | "bold"
    | "italic"
    | "underline"
    | "undo-2"
    | "redo-2"
    | "save"
    | "align-left"
    | "align-center"
    | "align-right"
    | "list"
    | "list-ordered"
    | "message-square";
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

/**
 * 窄栏里的「一个按钮 + 一个下拉」：对齐三档 / 两种列表各自收成一个。
 * 触发器同样要 `mousedown.preventDefault()`，不能因为打开菜单而丢掉文档里的选区。
 */
function DocxMenuTool(props: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  items: MenuItem[];
  align?: "start" | "end";
}) {
  return (
    <Menu
      items={props.items}
      align={props.align ?? "start"}
      panelMinWidth={160}
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className="quiet-control docx-tool"
          title={props.label}
          aria-label={props.label}
          aria-expanded={open}
          disabled={props.disabled === true}
          onMouseDown={(event) => event.preventDefault()}
          onClick={toggle}
        >
          <Icon name={props.icon} size={14} strokeWidth={2} />
        </button>
      )}
    />
  );
}

/** 段落样式下拉：宽栏显示样式名，窄栏收成一个「文字样式」图标 */
function DocxStyleMenu(props: {
  choices: readonly StyleChoice[];
  value: string;
  compact: boolean;
  disabled: boolean;
  onChange: (styleId: string) => void;
}) {
  const t = useT();
  const items: MenuItem[] = props.choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    checked: choice.id === props.value,
    onSelect: () => props.onChange(choice.id),
  }));
  return (
    <Menu
      items={items}
      panelMinWidth={200}
      trigger={({ open, toggle }) => {
        if (props.compact) {
          return (
            <button
              type="button"
              className="quiet-control docx-tool"
              title={styleLabel(props.choices, props.value)}
              aria-label={t.docx.paragraphStyleNamed(styleLabel(props.choices, props.value))}
              aria-expanded={open}
              disabled={props.disabled}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggle}
            >
              <Icon name="type" size={14} strokeWidth={2} />
            </button>
          );
        }
        return (
          <button
            type="button"
            className="select-control docx-style-select"
            title={styleLabel(props.choices, props.value)}
            aria-label={t.docx.paragraphStyleNamed(styleLabel(props.choices, props.value))}
            aria-expanded={open}
            disabled={props.disabled}
            onMouseDown={(event) => event.preventDefault()}
            onClick={toggle}
          >
            <span className="select-control-label">{styleLabel(props.choices, props.value)}</span>
            <Icon name="chevron-down" size={12} strokeWidth={2} />
          </button>
        );
      }}
    />
  );
}
