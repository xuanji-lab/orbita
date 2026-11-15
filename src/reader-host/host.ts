/**
 * 阅读器页面里的桥脚本（主进程把它插进 reader.html，见 main/pdf-reader/respond.ts）。与阅读器同一个窗口，
 * 面板（renderer）是它的父框架、与它跨源，两边只靠 postMessage（消息形状在 shared/pdf-reader.ts）。
 *
 * 它做的事都很薄：
 * - 收面板的命令，调阅读器的公开方法（缩放、翻页、换工具、开关侧栏、查找、深浅、跳转）；
 * - 把阅读器的回调转成消息：存 / 删批注、要确认、打开链接；
 * - 把页码 / 总页数 / 侧栏 / 当前工具推给面板，让面板自己的紧凑工具栏显示它们。读这些要包一层阅读器的
 *   `_updateState`（私有方法，提交钉死了；升级阅读器时这里要回归）。
 *
 * **一次删多条的确认**：阅读器的 `onConfirm` 要同步回答，跨框架问不了。桥把实例上的 `deleteAnnotations`
 * 换成「多条时先问面板、答应了再删」——阅读器内部所有删除入口（Delete 键、右键菜单）都经 `reader.deleteAnnotations`
 * 调用，换实例方法就都覆盖到；真删时 `onConfirm` 回 true，其余时候回 false（安全默认：不删）。
 */
import {
  READER_BRAND_FTL,
  READER_COLORS,
  READER_TOOLS,
  type ReaderAnnotation,
  type ReaderCommand,
  type ReaderEvent,
  type ReaderTool,
} from "../shared/pdf-reader.ts";

interface ReaderTool$ {
  type: string;
  color?: string;
}

interface ReaderState {
  sidebarOpen: boolean;
  tool: ReaderTool$;
  primaryViewStats: { pageIndex?: number; pageLabel?: string; pagesCount?: number };
}

interface ReaderInstance {
  /** 主视图（pdf.js 那一层）；创建后异步生成 */
  _primaryView: { initializedPromise: Promise<unknown> } | null;
  _state: ReaderState;
  _updateState: (state: Partial<ReaderState> & Record<string, unknown>, init?: boolean) => void;
  zoomIn: () => void;
  zoomOut: () => void;
  zoomPageWidth: () => void;
  navigateToPreviousPage: () => void;
  navigateToNextPage: () => void;
  navigate: (location: Record<string, unknown>, options?: Record<string, unknown>) => Promise<void>;
  setTool: (params: ReaderTool$) => void;
  toggleSidebar: (open: boolean) => void;
  toggleFindPopup: (params: { open?: boolean }) => void;
  setColorScheme: (scheme: string) => void;
  setReadOnly: (readOnly: boolean) => void;
  deleteAnnotations: (ids: string[]) => number;
}

type CreateReader = (options: Record<string, unknown>) => ReaderInstance;

declare global {
  interface Window {
    createReader?: CreateReader;
  }
}

let reader: ReaderInstance | null = null;
/** 面板的源：首条命令的 event.origin；打包版的面板是 file://，源是 "null"，只能用 "*"（父框架固定是我们的 renderer） */
let parentOrigin = "*";
let confirmBypass = false;
let nextConfirmId = 1;
const pendingConfirms = new Map<number, string[]>();

function post(event: ReaderEvent): void {
  window.parent.postMessage(event, parentOrigin);
}

const toolOf = (type: string): ReaderTool => ((READER_TOOLS as readonly string[]).includes(type) ? (type as ReaderTool) : "pointer");

let lastState = "";
function pushState(): void {
  if (reader === null) return;
  const state = reader._state;
  const stats = state.primaryViewStats;
  const event: ReaderEvent = {
    type: "state",
    pageIndex: stats.pageIndex ?? 0,
    pageLabel: stats.pageLabel ?? String((stats.pageIndex ?? 0) + 1),
    pagesCount: stats.pagesCount ?? 0,
    sidebarOpen: state.sidebarOpen,
    tool: toolOf(state.tool.type),
    color: state.tool.color ?? READER_COLORS[0].value,
  };
  const key = JSON.stringify(event);
  if (key === lastState) return;
  lastState = key;
  post(event);
}

async function fetchText(path: string): Promise<string> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`${path}: ${response.status}`);
  return response.text();
}

async function init(command: Extract<ReaderCommand, { type: "init" }>): Promise<void> {
  if (reader !== null || window.createReader === undefined) return;
  const [zotero, readerFtl] = await Promise.all([
    fetchText(`locales/${command.locale}/zotero.ftl`),
    fetchText(`locales/${command.locale}/reader.ftl`),
  ]);
  const noop = (): void => undefined;
  const created = window.createReader({
    type: "pdf",
    data: { url: command.docUrl },
    annotations: command.annotations,
    colorScheme: command.colorScheme,
    ftl: [zotero, readerFtl, READER_BRAND_FTL],
    readOnly: command.readOnly,
    authorName: "",
    sidebarOpen: command.sidebarOpen,
    sidebarWidth: 240,
    sidebarView: "annotations",
    showContextPaneToggle: false,
    onSaveAnnotations: (annotations: ReaderAnnotation[]) => {
      // 阅读器偶尔发 save([])：不往外传
      if (Array.isArray(annotations) && annotations.length > 0) post({ type: "save", annotations });
    },
    onDeleteAnnotations: (ids: string[]) => {
      if (Array.isArray(ids) && ids.length > 0) post({ type: "delete", ids });
    },
    onConfirm: () => confirmBypass,
    onOpenLink: (url: string) => post({ type: "open-link", url }),
    // 标签、加到笔记、上下文面板是宿主应用的东西，我们没有：给空桩（按钮由 host.css 盖掉）
    onOpenTagsPopup: noop,
    onClosePopup: noop,
    onAddToNote: noop,
    onToggleSidebar: noop,
    onChangeSidebarWidth: noop,
    onChangeSidebarView: noop,
    onChangeViewState: noop,
    onSetDataTransferAnnotations: noop,
    onSetLightTheme: noop,
    onSetDarkTheme: noop,
    onSaveCustomThemes: noop,
    onTextSelectionAnnotationModeChange: noop,
  });
  reader = created;

  const originalDelete = created.deleteAnnotations.bind(created);
  created.deleteAnnotations = (ids: string[]): number => {
    if (ids.length > 1 && !confirmBypass) {
      const id = nextConfirmId++;
      pendingConfirms.set(id, [...ids]);
      post({ type: "confirm", id, count: ids.length });
      return 0;
    }
    return originalDelete(ids);
  };
  const originalUpdate = created._updateState.bind(created);
  created._updateState = (state, initial) => {
    originalUpdate(state, initial);
    pushState();
  };

  // 阅读器自己的 initializedPromise 在这个提交里从没被 resolve（只建不兑，源码里搜得到），就绪要看主视图的
  while (created._primaryView === null || created._primaryView === undefined) {
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  await created._primaryView.initializedPromise;
  post({ type: "initialized" });
  pushState();
}

function run(command: ReaderCommand): void {
  if (command.type === "init") {
    void init(command).catch((cause: unknown) => post({ type: "error", message: cause instanceof Error ? cause.message : String(cause) }));
    return;
  }
  if (command.type === "layout") {
    document.body.toggleAttribute("data-orbita-narrow", command.narrow);
    return;
  }
  if (reader === null) return;
  switch (command.type) {
    case "zoom":
      if (command.action === "in") reader.zoomIn();
      else if (command.action === "out") reader.zoomOut();
      else reader.zoomPageWidth();
      return;
    case "page":
      if (command.action === "prev") reader.navigateToPreviousPage();
      else reader.navigateToNextPage();
      return;
    case "go-to-page":
      void reader.navigate({ pageLabel: command.label });
      return;
    case "tool":
      reader.setTool(command.color === undefined ? { type: command.tool } : { type: command.tool, color: command.color });
      return;
    case "sidebar":
      reader.toggleSidebar(command.open);
      return;
    case "find":
      reader.toggleFindPopup({ open: true });
      return;
    case "color-scheme":
      reader.setColorScheme(command.value);
      return;
    case "navigate":
      void reader.navigate({ position: { pageIndex: command.pageIndex, rects: command.rects } }, { block: "center" });
      return;
    case "confirm-result": {
      const ids = pendingConfirms.get(command.id);
      pendingConfirms.delete(command.id);
      if (ids === undefined || !command.ok) return;
      confirmBypass = true;
      try {
        reader.deleteAnnotations(ids);
      } finally {
        confirmBypass = false;
      }
      return;
    }
  }
}

function isCommand(value: unknown): value is ReaderCommand {
  return typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";
}

window.addEventListener("message", (event) => {
  // 只听父框架（面板）；阅读器内部 pdf.js 那层 iframe 的消息不归这里
  if (event.source !== window.parent || !isCommand(event.data)) return;
  if (event.data.type === "init" && event.origin !== "null") parentOrigin = event.origin;
  run(event.data);
});

window.addEventListener("error", (event) => post({ type: "error", message: event.message }));
window.addEventListener("unhandledrejection", (event) => {
  const reason: unknown = event.reason;
  post({ type: "error", message: reason instanceof Error ? reason.message : String(reason) });
});

// 脚本插在 </head> 前，阅读器的 reader.js 也在 head 里、先于我们执行；DOM 还没好也无妨——init 要等面板发
post({ type: "ready" });
