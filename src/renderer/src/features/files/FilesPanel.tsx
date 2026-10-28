import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon, type IconName } from "../../shell/Icon";
import { RowHoverAction } from "../../shell/RowHoverAction";
import { ContextMenu } from "../../shell/ContextMenu";
import type { MenuItem } from "../../shell/Menu";
import { PanelFilter, PanelGroupHead, PanelIconButton, PanelLine, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { IconButton } from "../../shell/IconButton";
import { api } from "../../api";
import type { ChatSession } from "../chat/useChatSession";
import {
  countLoadedEntries,
  countVisibleEntries,
  fileIcon,
  fileIconTone,
  FILETYPE_TONE_COLOR,
  filterCountText,
  filterEntries,
  formatSize,
  hasAgentsMd,
  orderEntries,
  orderEntriesByType,
} from "./tree-view";
import { useFileTree } from "./useFileTree";
import {
  attachmentName,
  collectSentAttachments,
  type SentAttachment,
  type SentFileRef,
} from "./sent-attachments.ts";
import { FilePreviewPane } from "./FilePreviewPane";
import { LatexBuildBar } from "./LatexBuildBar";
import { LatexProblems, type ProblemItem } from "./LatexProblems";
import {
  groupLatexIssues,
  isFailedStatus,
  issueLocation,
  latexBarState,
  pdfStale,
} from "./latex-workbench.ts";
import { useLatexWorkbench } from "./useLatexWorkbench.ts";
import { closeDecision } from "./editor-state.ts";
import type { FlushOutcome, TexEditorHandle } from "./TexEditorPane.tsx";
import {
  closeTab,
  decideFocusDrop,
  dropTabsAtRoot,
  fileTabName,
  openTab,
  panelLayoutAttrs,
  shouldCollapseOnNarrow,
  tabScrollTarget,
  toggleGroupCollapsed,
  TREE_BREAKPOINT,
  type FileTab,
} from "./panel-layout.ts";
import { decideCiteFocus, type CiteFocusRequest } from "./cite-focus.ts";
import type { PdfJump } from "./PdfView";
import { DirMarkName } from "../../shell/DirMarkName.tsx";
import type { FileEntryKind, FileRoot, FileRootKind, FsEntryFact } from "@shared/files";
import type { LatexFileContext } from "@shared/latex";
import { pathTail, pathWithin, samePath } from "../../../../shared/path.ts";
import { useT } from "../../locale.ts";

/** 占位 Session 组（还没有会话）的折叠键：真实根的键是绝对路径，常量撞不上 */
const PLACEHOLDER_SESSION_GROUP = "session";

/**
 * 文件面板（设计稿 files-panel (b) 形态）：三组根——Session（本会话工作台，唯一随
 * 会话变的根，用户最常来找 plan / handoff）→ Workspace → Attached，往下每层
 * 30px 树行懒加载。attach / detach 就地做（工作区级、可增可减，不进设置页）。
 *
 * 交互模型（2026-10-10 改版，HTML 原型 files-panel-prototype.html，用户逐条裁决）：
 * 打开的文件以标签页列在头部「文件」标题旁，单击文件行即打开 / 激活标签；
 * 「文件」标题本身是文件树开关——有打开文件时可切树的显隐（宽容器并排窄列，
 * 窄容器浮层），没有打开文件时树就是整个面板、开关禁用。树开着时面板被拉窄
 * 就自动折叠（任何幅度），拉宽永不反向展开。布局裁决纯函数在 panel-layout.ts，
 * 显示形态的 container query 在 styles.css——这里不量宽度做显示判定。
 *
 * 头部没有 ×：关文件是标签 ✕ / Esc，关面板是右侧栏的面板按钮（同一个入口不必
 * 在面板里再长一个）——2026-10-10 用户裁决。
 */
export function FilesPanel(props: {
  session: ChatSession;
  /**
   * App 的全局 Esc 先问这里：有激活标签就只关它、回报「处理掉了」，面板不关——
   * 与子会话面板「Esc 先退一层」同一个台阶。不自己挂 window 监听：App 的监听注册
   * 更早、先执行，两个都挂的话一下 Esc 会连标签带面板一起关掉。
   */
  escapeRef: { current: (() => boolean) | null };
  /**
   * PDF 引用跳转请求（实验功能「PDF 引用」）：点了正文里的引用编号，App 打开本面板并
   * 递进来。token 单调递增，同一条引用连点也会重新定位；请求带着出生会话戳，
   * 换会话后由 cite-focus.ts 判作废。null = 没有请求
   */
  citeFocus?: CiteFocusRequest | null;
  /**
   * 专注 / 浏览态正在看的工作区（额外预览根，shared/files.ts 的 extraWorkspaceId）：
   * 当前会话可以不在它里面——左栏（WorkspaceFiles）双击的文件照样能预览。
   * null = 不在专注 / 浏览态，面板根只跟会话走
   */
  focusWorkspaceId?: string | null;
  /**
   * 专注时间已到（useFocus 的 done 相位）：左栏的专注视图还在、额外根也还在，
   * 但这一轮专注结束了——该工作区的预览标签按「结束专注」同一纪律收掉。
   * 与 focusWorkspaceId 分开传：id 不变，光看它分不出 run → done 这一拍
   */
  focusDone?: boolean;
  /**
   * 左栏文件树的双击打开请求（与 citeFocus 同一套消费模式）：token 单调递增，
   * 同一个文件连点两次也重新激活。null = 没有请求
   */
  fileOpen?: { path: string; token: number } | null;
  /**
   * 把一条命令填进可见终端（编译条「在终端安装」）：App 切到终端面板并粘贴，
   * 回车仍由用户按——缺宏包的安装可能需要 sudo / 管理员密码，agent 不替用户提权。
   */
  onRunInTerminal?: (command: string) => void;
  /**
   * 布局 B（稿件为主）：稿件工作台占主位、对话收进右侧一栏。页头跟着画在卡里
   * （inline），源码与 PDF 并排。由 App 的 paper-layout.ts 裁决后传进来。
   */
  paperLayout?: boolean;
  /**
   * 布局 A 的大屏自动并排（窗口 ≥ 1800、项目有 PDF）：只并排，不改页头位置与侧栏。
   */
  autoSplit?: boolean;
  /** 切换布局的按钮（住在文件页头的右端——两种布局里是同一个位置） */
  onTogglePaperLayout?: () => void;
  /**
   * 项目里有 PDF（可以并排）：报给 App——布局 A 的自动并排与「并排前把右栏拉宽」
   * 都要先知道这一点，而项目事实住在本面板里。
   */
  onPaperReady?: (ready: boolean) => void;
}) {
  const t = useT();
  const session = props.session;
  /** 与 App 的 mainSessionId 同口径：活会话优先，退盘上打开的那条 */
  const sessionId = session.sessionId ?? session.opened?.id ?? null;
  const workspaceId = session.workspaceId;
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  /** 打开的文件标签（按打开顺序排队）；激活的就是面板正显示的那个 */
  const [tabs, setTabs] = useState<readonly FileTab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  /** 文件树显隐（状态，≠显示形态）：只能由「文件」标题开关打开、跨断点缩窄自动折叠 */
  const [treeOn, setTreeOn] = useState(false);
  /** 折叠的根分组（键 = 根的绝对路径，随会话 / 工作区切换重置） */
  const [collapsedGroups, setCollapsedGroups] = useState<ReadonlySet<string>>(new Set());
  /** Session 组的排序：默认按名字，可切按类型（用户 2026-10-11 点名只要 Session；
   * 视图偏好而非会话状态，不随会话 / 工作区切换重置） */
  const [sessionSort, setSessionSort] = useState<"name" | "type">("name");
  const activeTab =
    activePath === null ? null : (tabs.find((tab) => tab.path === activePath) ?? null);
  // 标签栏 / 激活标签的把手：切换或新开标签时把当前标签滚进可视区（见下面的
  // effect）——标签多了以后新开的被截在右沿、连 ✕ 都看不到，是验收实测问题
  const tabsBarRef = useRef<HTMLDivElement | null>(null);
  const activeTabRef = useRef<HTMLDivElement | null>(null);
  /** 右键菜单：打开位置 + 被右键的根（目前只有 Session 根接了右键，
   * 只有「添加文件引用」一项——把工作台目录整个递给模型）。条目行不接右键：
   * 行尾 hover 按钮已覆盖引用，打开/复制路径类动作频率不足以撑一张菜单 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    root: FileRoot;
    path: string;
    name: string;
    kind: FileEntryKind;
  } | null>(null);
  const focusWorkspaceId = props.focusWorkspaceId ?? null;
  const focusDone = props.focusDone === true;
  const tree = useFileTree(sessionId, workspaceId, session.workspaces, focusWorkspaceId);

  // 专注 / 浏览态结束（或换到另一个工作区）、以及专注到点（run → done）：之前那个
  // 额外根失去 fs:read 白名单（roots.ts 只认会话根 + 当前 extraWorkspaceId），留着的
  // 标签会重新读一次、变成常驻「不是这条会话允许的根目录之一」（2026-10-22 发版前
  // 验收实测）。与换会话 / 换工作区清标签同一条纪律，只收掉 root 恰是那个工作区路径
  // 的标签；失去的根仍是白名单里的另一条（会话自己的根 / 会话的工作区 / 附加目录）时
  // 标签仍可读，不动——专注的工作区恰好也是会话附加目录就是这种（#267 C8）。
  //
  // done 这一拍不一样：左栏专注视图与额外根都还在，focusWorkspaceId 一个字节也不变，
  // 原先只看 id 的 effect 不触发——2026-10-23 验收 files.scope.done 实测 done 后
  // tabCount=1，点「结束专注」才归零。但这一轮专注已经结束了，预览标签按「结束专注」
  // 同一纪律收掉：同时盯 focusDone，用 panel-layout 的纯函数裁决该收哪个根——只在
  // 真正的相位变化上给出路径，effect 依赖里有 tabs 也不会反复收。
  //
  // 「收哪个」不只看相位：失去的根若同时是会话附加目录（C8），标签仍读得动，不收。
  const previousFocusRef = useRef<string | null>(focusWorkspaceId);
  const previousFocusDoneRef = useRef(focusDone);
  // 渲染期就读这两只 ref：它们只在下面的 effect 里写，读到的就是「上一次提交的专注
  // 相位」——正是判「这一拍刚失去根」要的那份。判决本身是纯函数，effect 用同一份输入
  // 再算一次，两边不会分叉。
  const focusDrop = decideFocusDrop({
    previousWorkspaceId: previousFocusRef.current,
    nextWorkspaceId: focusWorkspaceId,
    previousDone: previousFocusDoneRef.current,
    nextDone: focusDone,
    sessionWorkspaceId: session.workspaceId,
    workspaces: session.workspaces,
    roots: tree.attachmentsRoot === null ? tree.roots : [...tree.roots, tree.attachmentsRoot],
  });
  useEffect(() => {
    // 判决用更新前的 ref（与渲染期同一份输入），然后记下这一拍
    const drop = decideFocusDrop({
      previousWorkspaceId: previousFocusRef.current,
      nextWorkspaceId: focusWorkspaceId,
      previousDone: previousFocusDoneRef.current,
      nextDone: focusDone,
      sessionWorkspaceId: session.workspaceId,
      workspaces: session.workspaces,
      roots: tree.attachmentsRoot === null ? tree.roots : [...tree.roots, tree.attachmentsRoot],
    });
    previousFocusRef.current = focusWorkspaceId;
    previousFocusDoneRef.current = focusDone;
    if (drop.rootPath === null) return;
    const next = dropTabsAtRoot(tabs, activePath, drop.rootPath);
    if (next.tabs.length === tabs.length) return;
    setTabs(next.tabs);
    setActivePath(next.activePath);
    if (next.activePath === null) setTreeOn(false);
  }, [
    focusWorkspaceId,
    focusDone,
    session.workspaceId,
    session.workspaces,
    tree.roots,
    tree.attachmentsRoot,
    tabs,
    activePath,
  ]);

  /**
   * 这一拍要收的标签先不渲染（C9）：读取 effect 是子组件的、先于上面收标签的 effect
   * 跑，渲染出来就会拿刚失效的根再读一次（界面无报错，主进程日志多一条被拒记录）。
   * 挡的是同一个判决、同一个根，effect 在下一拍把状态也收掉。
   */
  const shownTab = activeTab !== null && activeTab.root === focusDrop.rootPath ? null : activeTab;

  /**
   * 论文工作台：当前文件属于 LaTeX 项目时，标签行下方多一条编译条、面板底部多个
   * 问题抽屉；其余文件完全无感（项目探测走主进程，不在这里读盘）。
   *
   * 授权上下文与 fs:read 同形（root + path），所以附图标签（path 是原图引用、
   * root 是空串）直接跳过——它不可能是 LaTeX 项目里的文件。
   */
  const latexContext = useMemo<LatexFileContext | null>(() => {
    if (activeTab === null || activeTab.name !== undefined) return null;
    return {
      sessionId,
      workspaceId,
      ...(focusWorkspaceId === null ? {} : { extraWorkspaceId: focusWorkspaceId }),
      root: activeTab.root,
      path: activeTab.path,
    };
  }, [activeTab, sessionId, workspaceId, focusWorkspaceId]);
  const latex = useLatexWorkbench(latexContext);

  /**
   * 源码编辑器的把手登记表（path → handle）。编辑器只在激活标签里挂载，关标签前
   * 先 ask 它存盘；编译前必须把未落盘的改动写完——否则编的是盘上的旧版。
   * 切标签不靠这里：旧编辑器卸载时会自己把文本抓下来再写（配「切走不丢字」）。
   */
  const editorsRef = useRef(new Map<string, TexEditorHandle>());
  const [dirtyPaths, setDirtyPaths] = useState<ReadonlySet<string>>(new Set());
  /** 编辑器事件造成的可见提示（关标签撞冲突 / 编译前保存失败），不静默 */
  const [editorNotice, setEditorNotice] = useState<string | null>(null);

  const registerEditor = useCallback((path: string, handle: TexEditorHandle | null): void => {
    if (handle === null) editorsRef.current.delete(path);
    else editorsRef.current.set(path, handle);
  }, []);

  const handleEditorDirty = useCallback((path: string, dirty: boolean): void => {
    setDirtyPaths((current) => {
      if (current.has(path) === dirty) return current;
      const next = new Set(current);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const handleEditorError = useCallback((path: string, message: string): void => {
    setEditorNotice(`${pathTail(path) || path}：${message}`);
  }, []);

  /** 保存成功的统一回调：清掉旧提示，并让编译条立刻看到「源码比 PDF 新」 */
  const handleEditorSaved = useCallback((): void => {
    setEditorNotice(null);
    latex.refresh();
    // 保存即编译（项目级开关，缺省关）：自动保存落定后触一发。
    // 显式编译前的那次 flush 也要走到这里，由 compileWithSave 的抑制标记挡掉，
    // 否则一次点击会变成「先编一轮、排队再编一轮」。
    if (suppressSaveCompileRef.current) return;
    if (latex.project?.compileOnSave === true) latex.compile();
  }, [latex]);
  /** 问题抽屉的展开态：默认收起（安静）；用户自己点的编译失败时自动展开一次 */
  const [problemsOpen, setProblemsOpen] = useState(false);
  const latexGroups = useMemo(
    () => groupLatexIssues(latex.last?.errors ?? [], latex.last?.warnings ?? []),
    [latex.last],
  );
  const latexState = latexBarState({
    running: latex.running,
    lastStatus: latex.last?.status ?? null,
    stale: pdfStale(latex.project?.pdf?.modifiedAt ?? null, latex.project?.sourceModifiedAt ?? null),
    hasPdf: latex.project?.pdf !== null && latex.project !== undefined,
  });
  useEffect(() => {
    if (latex.last !== null && isFailedStatus(latex.last.status)) setProblemsOpen(true);
  }, [latex.last]);

  // 切文件 / 换项目：抽屉收起（上一份问题不属于新文件）
  useEffect(() => {
    setProblemsOpen(false);
  }, [latexContext?.path]);

  /**
   * 论文工作台的两种布局（paper-layout.ts）：B 的并排是主位天然形态；A 在宽屏
   * （≥1800）也自动并排。并排的右半永远是**这个项目的 PDF**，左半是激活标签——
   * 激活标签本身就是 PDF 时，左半换成项目主文件（原型：左源码右 PDF）。
   */
  const projectPdfPath = latex.project?.pdf?.path ?? null;
  const splitWanted = props.paperLayout === true || props.autoSplit === true;
  const mainSourcePath =
    latex.project !== null && latex.project.main !== null
      ? `${latex.project.dir}${/[\\/]$/.test(latex.project.dir) ? "" : "/"}${latex.project.main}`
      : null;
  const splitPdfPath = splitWanted ? projectPdfPath : null;
  const activeIsPdf =
    activeTab !== null && splitPdfPath !== null && samePath(activeTab.path, splitPdfPath);
  const splitLeftPath = activeIsPdf ? mainSourcePath : (activeTab?.path ?? null);
  const splitOn =
    splitPdfPath !== null && splitLeftPath !== null && !samePath(splitLeftPath, splitPdfPath);
  /** 左栏真正显示的文件：不并排时就是激活标签（含「激活标签是 PDF」那种单栏） */
  const leftPath = splitOn ? splitLeftPath : (activeTab?.path ?? null);
  /** 左栏显示的是不是项目 PDF（决定它要不要走 PDF 预览与编译后重载） */
  const leftIsProjectPdf =
    leftPath !== null && projectPdfPath !== null && samePath(leftPath, projectPdfPath);

  // 项目有 PDF 才谈得上并排（App 据此决定 A 的自动并排与右栏宽度）
  const paperReady = latex.project !== null && latex.project.pdf !== null;
  const reportPaperReady = props.onPaperReady;
  useEffect(() => {
    reportPaperReady?.(paperReady);
  }, [paperReady, reportPaperReady]);

  /**
   * 编译前强制保存：未落盘的改动先写盘，编译用的就是你眼前这一版（原型场景 1 第 5 步 / 场景 4）。
   * 冲突或写盘失败时**不编**：编出来的 PDF 会对应一份你不知道内容的源码，比不编更误导。
   * 只 flush 当前挂载的编辑器（其它标签在切走时已经保存过），但保存链是串行的，不会交错。
   */
  const compile = latex.compile;
  /** 显式编译期间的「保存不算一次新触发」标记（见 handleEditorSaved） */
  const suppressSaveCompileRef = useRef(false);
  const compileWithSave = useCallback((): void => {
    void (async () => {
      suppressSaveCompileRef.current = true;
      try {
        const outcomes: FlushOutcome[] = await Promise.all(
          [...editorsRef.current.values()].map((handle) => handle.flush()),
        );
        if (outcomes.includes("conflict")) {
          setEditorNotice(t.editor.conflictBlocksCompile);
          return;
        }
        if (outcomes.includes("error")) return; // 编辑器自己的错误条已经在说了
        compile();
      } finally {
        suppressSaveCompileRef.current = false;
      }
    })();
  }, [compile, t]);

  /**
   * 编译快捷键（Ctrl/Cmd+B）。**不抢终端与输入框**：终端里的 Ctrl+B 是 readline 的
   * backward-char（vim 里是翻页），在输入框里它也不是编译——那两个场景直接放过。
   */
  useEffect(() => {
    if (latex.project === null) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "b") return;
      const target = event.target;
      if (target instanceof Element && target.closest(".xterm") !== null) return;
      if (target instanceof HTMLElement) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA") return;
        // 源码编辑器里的 Ctrl+B 不当输入法 / 加粗用：那是 LaTeX 项目，编译才是它该做的事
        if (target.isContentEditable && target.closest(".tex-editor") === null) return;
      }
      event.preventDefault();
      if (latex.running) return;
      compileWithSave();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [latex.project, latex.running, compileWithSave]);

  /**
   * 一条编译问题 → 输入框引用。走现有的引用通道（TextQuote）：用户自己按发送才发。
   * `filePath` 让 chip 的注脚显示文件名（而不是「agent 说的」）——它不是历史消息的
   * 片段，是一条工具事实。
   */
  const handProblemToAgent = (item: ProblemItem): void => {
    const prefix =
      item.level === "error"
        ? t.latex.quoteError
        : item.level === "warning"
          ? t.latex.quoteWarning
          : item.level === "layout"
            ? t.latex.quoteLayout
            : t.latex.quoteMissingPackage;
    const loc = issueLocation(item);
    session.addQuote({
      text: `${prefix} · ${loc === "" ? item.message : `${loc} · ${item.message}`}`,
      messageId: `latex:${item.file ?? ""}:${item.line ?? 0}:${item.message}`,
      role: "assistant",
      ...(item.file === null ? {} : { filePath: item.file }),
    });
    document.querySelector<HTMLTextAreaElement>("textarea.composer-input")?.focus();
  };

  // Session · 附件：已发送过的文件引用与附图从已加载转录派生（sent-attachments.ts，
  // 不动盘、不建链接不建副本）；盘上事实（还在不在 / 类型）走已有的 fs:stat-kind 现问，
  // 只问文件引用——附图按原图引用走 session.attachment 读，没有 stat 这回事。
  // 转录每变一次（新发送）重问一次；面板头的刷新也顺带重问
  const sentAttachments = useMemo(() => collectSentAttachments(session.transcript), [session.transcript]);
  const [attachFacts, setAttachFacts] = useState<ReadonlyMap<string, FsEntryFact>>(new Map());
  // 重问一次盘上事实的把手（面板头刷新时一并触发）：effect 的依赖加一个自增的轮次
  const [attachStatRound, setAttachStatRound] = useState(0);
  useEffect(() => {
    const refs = sentAttachments.filter((item): item is SentFileRef => item.kind === "ref");
    if (refs.length === 0) {
      setAttachFacts(new Map());
      return;
    }
    let alive = true;
    void api.files
      .statKind(refs.map((item) => item.path))
      .then((facts) => {
        if (!alive) return;
        setAttachFacts(
          new Map(
            refs.map((item, index) => [
              item.path,
              facts[index] ?? { kind: null, size: null },
            ]),
          ),
        );
      })
      .catch(() => {
        // 问不到就当未知显示（不标不在，也不报错）——列表本身来自转录，不依赖这次 IPC
        if (alive) setAttachFacts(new Map());
      });
    return () => {
      alive = false;
    };
  }, [sentAttachments, attachStatRound]);

  // 会话 / 工作区切换 = 换一棵树：标签与分组折叠跟着清掉，treeOn 一并复位——旧
  // 会话的文件路径在新树里没有意义（同 useFileTree 清缓存 / 展开态的先例），树的
  // 展开理由也随最后一个文件消失；新会话从「树关」起步，点开文件不会突然顶着
  // 浮层 / 并排列（同 closeOne 关最后一个标签的复位逻辑）。顶部的报错与引用跳转
  // 同理清掉：错误属于旧会话里那次点击，带进新会话就是张冠李戴的常驻红字
  // （2026-10-18 修的 citeOutside 跨会话残留）
  useEffect(() => {
    setTabs([]);
    setActivePath(null);
    setCollapsedGroups(new Set());
    setTreeOn(false);
    setActionError(null);
    setJump(null);
    setEditorNotice(null);
  }, [sessionId, workspaceId]);

  // 附件列表吃同一条过滤词（按末段名字）；过滤中零命中时整节隐藏（与树的空目录
  // 同一条纪律：安静），不过滤时才出空态文案
  const filteredAttachments = filterAttachments(sentAttachments, query);

  // 面板主体的宽度感知：唯一 allowed 的 JS 宽度事实，来自这只 ResizeObserver——
  // 面板被拉窄（任何幅度）就把 treeOn 折叠（拉宽永不反向展开）；窄侧事实缓存进
  // narrowRef 供「浮层里点了文件 → 收浮层」用。显示形态（并排 / 浮层）仍由
  // styles.css 的 container query 裁决，这里只更新状态
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const narrowRef = useRef(false);
  /** 最近一次量到的面板宽（退出 B 后判断「最终是并排窄列还是浮层」用） */
  const bodyWidthRef = useRef(0);
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    let lastWidth: number | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      // 首帧只记宽、不动作（lastWidth === null）：面板挂载时不该把已经开着的树折掉
      if (shouldCollapseOnNarrow(lastWidth, width)) setTreeOn(false);
      lastWidth = width;
      bodyWidthRef.current = width;
      narrowRef.current = width < TREE_BREAKPOINT;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /**
   * 布局 B 里文件树自动收起：树占掉 224 以后，并排的两块只剩 280–300——正是原型里
   * 判「三块都读不了」的那个形态（B 的原型画面本来也没有树）。退出 B 时恢复**进 B
   * 之前**的开合态（与侧栏同一套记忆纪律）；布局 A 的宽屏自动并排不跟——那里宽度够。
   * B 里要看树随时点「文件」展开。
   *
   * 恢复要等宽度落定：退出 B 的面板宽是 200ms 过渡出来的，期间「拉窄即折叠」会不断
   * 折树（那是布局切换不是用户拉窄，不跟它抢）。过渡结束后再看最终宽度：宽（树是并排
   * 窄列）才放回来，窄（树只能浮层）不自动弹——那是又一层盖在内容上的面，交给用户自己点。
   */
  const treeOnRef = useRef(treeOn);
  treeOnRef.current = treeOn;
  const treeBeforePaperRef = useRef<boolean | null>(null);
  const restoreTreeTimerRef = useRef<number | null>(null);
  useEffect(() => {
    if (props.paperLayout === true) {
      if (restoreTreeTimerRef.current !== null) {
        window.clearTimeout(restoreTreeTimerRef.current);
        restoreTreeTimerRef.current = null;
      }
      if (treeBeforePaperRef.current === null) treeBeforePaperRef.current = treeOnRef.current;
      setTreeOn(false);
      return;
    }
    const before = treeBeforePaperRef.current;
    if (before === null) return;
    treeBeforePaperRef.current = null;
    if (!before) return;
    restoreTreeTimerRef.current = window.setTimeout(() => {
      restoreTreeTimerRef.current = null;
      if (bodyWidthRef.current >= TREE_BREAKPOINT) setTreeOn(true);
    }, 520);
    return () => {
      if (restoreTreeTimerRef.current !== null) {
        window.clearTimeout(restoreTreeTimerRef.current);
        restoreTreeTimerRef.current = null;
      }
    };
  }, [props.paperLayout]);

  /** 关闭一个标签；关掉最后一个 = 回纯树，treeOn 一并复位——之后从 solo 点开
   * 文件不会突然顶着浮层 / 并排列（树的展开理由随最后一个文件消失） */
  /** 真的把标签拿掉（保存已确认 / 本来不脏） */
  const applyClose = (path: string): void => {
    const next = closeTab(tabs, activePath, path);
    setTabs(next.tabs);
    setActivePath(next.activePath);
    if (next.activePath === null) setTreeOn(false);
  };

  /**
   * 关闭一个标签；有未保存内容时**先存再关**（自动保存的 1.5 s 没到就按 ✕ 不该丢字）。
   * 卡在冲突上时不关：替用户选「重载还是保留」是丢改动，停下来让他自己裁。
   * 保存失败也不关，标签留着、错误在编辑器里。
   */
  const closeOne = (path: string): void => {
    const handle = editorsRef.current.get(path);
    const decision = closeDecision({
      dirty: handle?.isDirty() ?? false,
      conflicted: handle?.conflicted() ?? false,
    });
    if (decision === "block") {
      setEditorNotice(t.editor.resolveConflictFirst);
      return;
    }
    if (decision === "save" && handle !== undefined) {
      void handle.flush().then((outcome) => {
        if (outcome === "saved" || outcome === "clean") applyClose(path);
        else setEditorNotice(t.editor.resolveConflictFirst);
      });
      return;
    }
    applyClose(path);
  };

  /**
   * 把当前激活标签滚进可视区。正常切换 / 新开由下面的 effect 管；**被拦下的切换**
   * 不经过 effect（activePath 与 tabs.length 都没变），而浏览器点击已把被点的标签
   * 滚进了视口——必须手动滚回去，否则用户眼前是那个并没切过去的标签，会以为切换成功了。
   */
  const scrollActiveTabIntoView = useCallback((): void => {
    const bar = tabsBarRef.current;
    const tab = activeTabRef.current;
    if (bar === null || tab === null) return;
    // 用视口矩形换算成「滚动内容坐标」：标签的 offsetParent 不一定是滚动容器
    // （.cap-tabs 没有 position），offsetLeft 是相对 toolbar 的，直接喂给
    // tabScrollTarget 会把它当成已可见（实测：真正左溢出 91px 时 offsetLeft
    // 恰好等于 scrollLeft，target 被判成 null）。
    const barRect = bar.getBoundingClientRect();
    const tabRect = tab.getBoundingClientRect();
    const target = tabScrollTarget(
      { scrollLeft: bar.scrollLeft, clientWidth: bar.clientWidth },
      { offsetLeft: tabRect.left - barRect.left + bar.scrollLeft, offsetWidth: tabRect.width },
    );
    if (target !== null) bar.scrollTo({ left: target });
  }, []);

  /**
   * 切换激活标签前的保存闸：当前编辑器脏就先 flush，**冲突 / 写盘失败时不切走**。
   * 切走会让 TexEditorPane 卸载，而卸载时的兜底保存一旦撞上冲突，那份未保存文本
   * 就再也拿不回来了（验收实测的丢字路径）。flush 成功后由这里统一 setActivePath；
   * 本来干净 / 没有编辑器就直接切。
   */
  const switchTo = useCallback(
    (next: string | null): void => {
      if (next === activePath) return;
      const current = activePath === null ? undefined : editorsRef.current.get(activePath);
      if (current === undefined || !current.isDirty()) {
        setActivePath(next);
        return;
      }
      void current.flush().then((outcome) => {
        if (outcome === "saved" || outcome === "clean") {
          setActivePath(next);
          return;
        }
        setEditorNotice(t.editor.resolveConflictBeforeSwitch);
        // 点击已经把被点的标签滚进视口（浏览器对聚焦元素的默认行为）；把可视区
        // 拉回真正的激活标签，否则看起来像已经切过去了。
        // 延到下一帧：浏览器的「聚焦滚动」排在点击处理器之后，当场 scrollTo 会被它盖掉
        window.requestAnimationFrame(() => scrollActiveTabIntoView());
      });
    },
    [activePath, scrollActiveTabIntoView, t],
  );

  // 预览打开时 Esc 关当前激活标签（原型同语义）；没有激活标签回报「没处理」，
  // 让 App 继续把 Esc 用在关面板上。由 App 的全局监听派发过来（见 props.escapeRef）
  const escapeRef = props.escapeRef;
  useEffect(() => {
    escapeRef.current = () => {
      if (activePath === null) return false;
      closeOne(activePath);
      return true;
    };
    return () => {
      escapeRef.current = null;
    };
    // closeOne 闭包跟随本轮渲染的 tabs / activePath，依赖要跟着列全
  }, [escapeRef, tabs, activePath]);

  /** 单击文件行 = 打开 / 激活标签（原型裁决，取代旧的「单击选中、双击才开」）；
   * 双击 / Enter 同一动作（标签复用，幂等）。浮层里点了文件 = 挑选完成：浮层
   * 自动收起——窄侧事实来自 ResizeObserver 的缓存，不在这里量宽度做显示判定 */
  const openFile = (root: FileRoot, path: string): void => {
    setTabs((prev) => openTab(prev, root.path, path));
    switchTo(path);
    if (narrowRef.current) setTreeOn(false);
  };

  /** 单击附图行 = 打开 / 激活附图标签：身份用原图引用（同一张图复用同一个标签），
   * 显示名用合成名；root 传空串——附图预览走 session.attachment，不过 fs:read 白名单 */
  const openSentImage = (ref: string, name: string): void => {
    setTabs((prev) => openTab(prev, "", ref, name));
    switchTo(ref);
    if (narrowRef.current) setTreeOn(false);
  };

  // 引用跳转（实验功能「PDF 引用」）：怎么处理一条请求由 cite-focus.ts 的纯函数
  // 裁决（含「请求属于别的会话 → 作废」——面板重挂后旧会话的请求不会拿新会话的
  // 根重判、报出无关的 citeOutside，2026-10-18 修），这里只按结论改 state；
  // 已消费的 token 不重放（同一条引用连点两次，每次都是新 token）
  const citeFocus = props.citeFocus ?? null;
  const consumedCiteRef = useRef<number | null>(null);
  const [jump, setJump] = useState<PdfJump | null>(null);
  useEffect(() => {
    if (citeFocus === null) return;
    const outcome = decideCiteFocus({
      request: citeFocus,
      consumedToken: consumedCiteRef.current,
      session: sessionId,
      roots: tree.roots,
      attachmentsRoot: tree.attachmentsRoot,
      rootsLoading: tree.rootsLoading,
    });
    if (outcome.kind === "idle" || outcome.kind === "wait") return;
    consumedCiteRef.current = citeFocus.token;
    if (outcome.kind === "drop") return;
    const path = citeFocus.citation.path;
    if (outcome.kind === "outside") {
      setActionError(t.files.citeOutside(pathTail(path) || path));
      return;
    }
    setActionError(null);
    setTabs((prev) => openTab(prev, outcome.root, path));
    switchTo(path);
    if (narrowRef.current) setTreeOn(false);
    setJump(citeFocus);
  }, [citeFocus, sessionId, tree.roots, tree.attachmentsRoot, tree.rootsLoading, t]);

  // 左栏（专注 / 浏览态的文件树）双击打开：与 citeFocus 同一套——找到路径所在的根
  // （额外预览根让专注工作区总在清单里），开它的标签；根清单没回来先等
  const focusFileOpen = props.fileOpen ?? null;
  const consumedOpenRef = useRef<number | null>(null);
  useEffect(() => {
    if (focusFileOpen === null || consumedOpenRef.current === focusFileOpen.token) return;
    const candidates = tree.attachmentsRoot === null ? tree.roots : [...tree.roots, tree.attachmentsRoot];
    const owner = candidates.find((root) => root.exists && pathWithin(root.path, focusFileOpen.path)) ?? null;
    if (owner === null) {
      if (tree.rootsLoading) return;
      consumedOpenRef.current = focusFileOpen.token;
      setActionError(t.files.treeOpenOutside(pathTail(focusFileOpen.path) || focusFileOpen.path));
      return;
    }
    consumedOpenRef.current = focusFileOpen.token;
    setActionError(null);
    openFile(owner, focusFileOpen.path);
  }, [focusFileOpen, tree.roots, tree.attachmentsRoot, tree.rootsLoading, t]);

  // 切换或新开标签：把激活标签滚进标签栏可视区（纯函数 tabScrollTarget 裁决
  // 目标；已完整可见就不动）。关掉非激活标签时 activePath 不变、tabs.length 变，
  // 重跑一次也只是无事发生
  useEffect(() => {
    scrollActiveTabIntoView();
  }, [activePath, tabs.length, scrollActiveTabIntoView]);

  /**
   * 挂目录。成功后 reloadWorkspaces——workspaces 引用一变，useFileTree 的 roots
   * 跟着重拉，新根自然出现，不在这里手拉第二份。Home（workspaceId null）同一条路：
   * 主进程把 Home 挂的目录也回在 roots 里，不需要单独的刷新逻辑。
   */
  const attach = (): void => {
    void api.workspace
      .attachDir(workspaceId)
      .then((next) => {
        // null = 用户在选目录对话框里取消：什么都不做
        if (next !== null) session.reloadWorkspaces();
      })
      .catch((cause: unknown) => setActionError(failMessage(cause)));
  };

  /** 摘目录：直接摘（工作区级、可随时再挂回来），不做二次确认；Home 同样 */
  const detach = (dir: string): void => {
    void api.workspace
      .detachDir(workspaceId, dir)
      .then(() => session.reloadWorkspaces())
      .catch((cause: unknown) => setActionError(failMessage(cause)));
  };

  /** 「添加文件引用」：条目行与会话根行共用——把这一行的路径附进当前输入框（原位置引用） */
  const referenceItem = (entry: { path: string; name: string; kind: FileEntryKind }): MenuItem => ({
    id: "reference",
    label: t.files.reference,
    icon: "paperclip",
    onSelect: () =>
      session.attachFileRef({
        path: entry.path,
        name: entry.name,
        kind: entry.kind === "directory" ? "dir" : "file",
      }),
  });

  /** 一个分组里的整棵子树（递归渲染已展开的层） */
  const rowsOf = (root: FileRoot, dir: string, depth: number): React.ReactNode => {
    const entries = tree.dirs.get(dir);
    if (entries === undefined) {
      // 只有 workspace 根的第一层加载态给 spinner：它是用户打开面板后第一眼
      // 等的那一条，别的嵌套目录 Loading… 不加——加了到处转，反而没有重点。
      const showSpinner = depth === 0 && root.kind === "workspace";
      return (
        <DimRow key={`pending:${dir}`}>
          {showSpinner && <Icon name="loader-circle" size={12} spin style={{ marginRight: 6 }} />}
          {t.common.loading}
        </DimRow>
      );
    }
    const shown = filterEntries(
      root.kind === "session" && sessionSort === "type"
        ? orderEntriesByType(entries)
        : orderEntries(entries),
      query,
    );
    if (shown.length === 0) return null; // 空目录 / 全被过滤：安静，不出空文件夹
    return shown.map((entry) => {
      const child = `${dir}/${entry.name}`;
      const isDir = entry.kind === "directory";
      const open = tree.expanded.has(child);
      return (
        <Fragment key={entry.name}>
          <TreeRow
            name={entry.name}
            kind={entry.kind}
            depth={depth}
            open={open}
            size={entry.size}
            modifiedAt={entry.modifiedAt}
            onToggle={() => tree.toggle(root.path, child)}
            onReveal={() => tree.reveal(root.path, child)}
            selected={!isDir && activePath === child}
            onOpen={() => openFile(root, child)}
            onReference={() =>
              session.attachFileRef({
                path: child,
                name: entry.name,
                kind: entry.kind === "directory" ? "dir" : "file",
              })
            }
          />
          {isDir && open && rowsOf(root, child, depth + 1)}
        </Fragment>
      );
    });
  };

  const workspaceRoot = tree.roots.find((root) => root.kind === "workspace") ?? null;
  /** 提示行只在第一层已加载后判（加载中闪一下「没有 AGENTS.md」是误报） */
  const workspaceEntries =
    workspaceRoot === null ? undefined : tree.dirs.get(workspaceRoot.path);
  const error = actionError ?? tree.actionError;

  /**
   * 过滤行计数：shown 只数当前实际展开会渲染的行（与上面 rowsOf 同一条规则），
   * loaded 是已加载目录的条目总数——过滤不递归拉取，这个口径写进 title。
   */
  const filtering = query.trim() !== "";
  const shownCount = countVisibleEntries(tree.roots, tree.dirs, tree.expanded, query);
  const loadedCount = countLoadedEntries(tree.dirs);

  const fileOpen = activeTab !== null;
  // data-* 属性是 CSS 显示形态的唯一输入（solo / 隐藏 / 浮层 / 并排全在 container
  // query 里裁决）；「无文件时开关禁用」的不变式也压在这里，不靠组件记得清
  const layoutAttrs = panelLayoutAttrs(fileOpen, treeOn);

  const rootGroup = (root: FileRoot): React.ReactNode => {
    const collapsed = collapsedGroups.has(root.path);
    return (
      <div key={root.path}>
        <RootLabel
          kind={root.kind}
          detail={root.label}
          detailTitle={root.path}
          canReveal={root.exists}
          missing={root.kind === "attached" && !root.exists}
          collapsed={collapsed}
          onToggle={() => setCollapsedGroups((prev) => toggleGroupCollapsed(prev, root.path))}
          onReveal={root.exists ? () => tree.reveal(root.path, root.path) : undefined}
          // Session 组的排序切换（2026-10-11 用户裁决：只要 Session）：图标反映当前
          // 档位，tooltip 说点击后的动作；与 Reveal / Detach 同一套行尾 hover 键
          sort={root.kind === "session" ? { mode: sessionSort } : undefined}
          onSort={
            root.kind === "session"
              ? () => setSessionSort((mode) => (mode === "name" ? "type" : "name"))
              : undefined
          }
          // missing 的 attached 根下面有常驻 Detach（见 MissingAttachedRow）——组头
          // 不再重复一个 hover 才出的 Detach，一个状态只留一个处理入口
          onDetach={root.kind === "attached" && root.exists ? () => detach(root.path) : undefined}
          // 会话根行也接右键：只有「添加文件引用」（把工作台目录整个递给模型）。
          // 工作台还没建（exists=false）时引用一条不存在的路径没有意义，不接
          onContextMenu={
            root.kind === "session" && root.exists
              ? (position) => setMenu({ ...position, root, path: root.path, name: root.label, kind: "directory" })
              : undefined
          }
        />
        {/* 「在 Proma 里找不到规则文件」的痛点落点：工作区没有 AGENTS.md 时给一条
            虚线提示行。点击只 reveal 工作区根（打开文件夹让用户手建）——创建动作
            等写文件 IPC 落地，这一版不碰盘。分组折起时整组内容一并藏起 */}
        {!collapsed && (
          <>
            {root.kind === "workspace" &&
              workspaceEntries !== undefined &&
              !hasAgentsMd(workspaceEntries) && (
                <AgentsMdHint onReveal={() => tree.reveal(root.path, root.path)} />
              )}
            {/* Session · 附件（像一个子文件夹，排在会话组最前，同树里目录先于文件）：本会话已发给过模型的引用清单（方案 A——不动盘、不建链接、
                不新增副本），从转录派生；点文件走现有预览（单击 = 开标签），目录走 reveal，
                不在任何根内的（超限未复制的原位置引用等）只展示不可点 */}
            {root.kind === "session" && (query.trim() === "" || filteredAttachments.length > 0) && (
              <AttachmentSection
                attachments={filteredAttachments}
                facts={attachFacts}
                // 附件副本在不进树的 attachments 根里：拼进来当白名单 root，副本才点得开
                roots={tree.attachmentsRoot === null ? tree.roots : [...tree.roots, tree.attachmentsRoot]}
                onSelectPreview={openFile}
                onOpenImage={openSentImage}
                onReveal={tree.reveal}
                onReference={(ref) => session.attachFileRef(ref)}
              />
            )}
            {!root.exists && root.kind === "session" && (
              <DimRow>{t.files.emptyWorkbench}</DimRow>
            )}
            {!root.exists && root.kind === "attached" && (
              <MissingAttachedRow onDetach={() => detach(root.path)} />
            )}
            {root.exists && rowsOf(root, root.path, 0)}
          </>
        )}
      </div>
    );
  };

  return (
    <RightPanelFrame
      inline={props.paperLayout === true}
      header={
        <>
          {/* 「文件」标题本身就是文件树开关（原型裁决）：树开着时呈点亮态（选中行
              的 mode 淡底配方）；没有打开文件时禁用——那时树就是整个面板。
              2026-10-19 走 PanelTitle 的开关形态，住工具栏右栏胶囊（样式见
              shell/toolbar.css 的 .cap-pt） */}
          <PanelTitle
            icon="folder"
            title={t.files.title}
            tip={t.files.treeToggleTip}
            onClick={() => setTreeOn((value) => !value)}
            ariaExpanded={fileOpen && treeOn}
            disabled={!fileOpen}
            // 没打开文件时开关是禁用的，箭头只会让人以为能点——干脆不画（2026-10-19 用户裁决）
            trailing={
              fileOpen ? (
                <Icon
                  name="chevron-right"
                  size={11}
                  strokeWidth={2.2}
                  className="files-title-chev"
                />
              ) : undefined
            }
          />
          {tabs.length === 0 ? (
            // 没打开文件：树就是整个面板，过滤框住在标题行（方案 B）；打开文件后标题行
            // 让给标签页，过滤框挪到树的顶部（树开着时才在场）
            <PanelFilter
              value={query}
              onChange={setQuery}
              placeholder={t.files.filter}
              ariaLabel={t.files.filterAria}
              count={filterCountText(shownCount, loadedCount, filtering)}
            />
          ) : (
            <>
              <div className="cap-tabs cap-grow" role="tablist" aria-label={t.files.tabsAria} ref={tabsBarRef}>
                {tabs.map((tab) => {
                  const name = tab.name ?? fileTabName(tab.path);
                  const active = tab.path === activePath;
                  const dirty = dirtyPaths.has(tab.path);
                  return (
                    <div
                      key={tab.path}
                      ref={active ? activeTabRef : undefined}
                      role="tab"
                      tabIndex={0}
                      aria-selected={active}
                      className="cap-tab no-drag"
                      title={tab.path}
                      onClick={() => switchTo(tab.path)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        switchTo(tab.path);
                      }}
                    >
                      <Icon
                        name={fileIcon(name, "file")}
                        size={13}
                        style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)" }}
                      />
                      <span className="files-tab-name">{name}</span>
                      {/* 未保存圆点（原型场景 1 第 3 步）：脏的时候占 ✕ 的位置，鼠标
                          悬停标签时让位给 ✕——同一个槽位两个状态，不额外占宽。
                          ✕ 停在标签内（button 不能套 button，标签本体是 div）：点击
                          只关这一个标签，不要顺带触发标签的激活 */}
                      <span className="files-tab-tail">
                        {dirty && (
                          <span className="files-tab-dirty" title={t.editor.unsaved}>
                            <Icon name="circle-dot" size={12} strokeWidth={2} />
                          </span>
                        )}
                        <button
                          type="button"
                          className={`files-tab-close${dirty ? " is-dirty" : ""}`}
                          title={t.files.closeTab}
                          aria-label={`${t.files.closeTab} ${name}`}
                          onClick={(event) => {
                            event.stopPropagation();
                            closeOne(tab.path);
                          }}
                        >
                          <Icon name="x" size={10} strokeWidth={2.4} />
                        </button>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      }
      contentKey="files"
      headerExtra={
        <>
          {/* 面板是快照：agent 写了文件、外部改了盘，点这里重拉根与所有展开目录，
              展开态与滚动位置不动。图标用 folder-sync 而不是 refresh-cw：文件预览头上
              的 refresh-cw 是「重读这一个文件」，同屏时同一个图标不能干两件事。
              在途时换成面板里通用的 loader-circle——转一个文件夹不像在加载 */}
          <PanelIconButton
            title={tree.refreshing ? t.files.refreshing : t.files.refresh}
            onClick={() => {
              tree.refresh();
              // 附件的存在性也一并重问——树刷了、附件标着旧状态会更误导
              setAttachStatRound((round) => round + 1);
            }}
            disabled={tree.refreshing}
          >
            <Icon name={tree.refreshing ? "loader-circle" : "folder-sync"} size={16} strokeWidth={1.8} spin={tree.refreshing} />
          </PanelIconButton>
          <PanelIconButton title={t.files.attach} onClick={attach}>
            <Icon name="plus" size={16} strokeWidth={2} />
          </PanelIconButton>
          {/* 两种布局的切换键（同一个位置：页头最右）：布局 A 只在论文项目里出现
              （布局 B 是为稿件工作台做的）；布局 B 里**总是**在——否则在 B 里打开一个
              非项目文件后再也点不回去（只能靠快捷键退出） */}
          {(latex.project !== null || props.paperLayout === true) &&
            props.onTogglePaperLayout !== undefined && (
            <PanelIconButton
              title={props.paperLayout === true ? t.paper.toChat : t.paper.toPaper}
              onClick={props.onTogglePaperLayout}
            >
              <Icon
                name={props.paperLayout === true ? "panel-right" : "maximize"}
                size={16}
                strokeWidth={1.8}
              />
            </PanelIconButton>
          )}
        </>
      }
    >
      {/* 右键菜单（portal 到 body，位置在指针处）。只有 Session 根分组头接了右键，
          仅一项「添加文件引用」——把工作台目录整个递给模型。条目行不接右键：
          引用走行尾 hover 按钮，其余动作不值得一张菜单（2026-09-27 用户裁决） */}
      <ContextMenu
        position={menu === null ? null : { x: menu.x, y: menu.y }}
        onClose={() => setMenu(null)}
        items={menu === null ? [] : [referenceItem(menu)]}
      />
      {/* 论文工作台：编译条（项目内才在）+ 文件内容 + 问题抽屉。三者同住一个
          纵向 flex，抽屉钉在面板底部；非 LaTeX 文件只多一层无副作用的包裹 */}
      <div className="files-workbench">
        {latex.project !== null && (
          <LatexBuildBar
            project={latex.project}
            probe={latex.probe}
            state={latexState}
            last={latex.last}
            startedAt={latex.startedAt}
            cleaning={latex.cleaning}
            onCompile={compileWithSave}
            onCancel={latex.cancel}
            onClean={latex.clean}
            onToggleCompileOnSave={latex.setCompileOnSave}
            onSelectEngine={latex.selectEngine}
            onSelectMain={latex.selectMain}
          />
        )}
        {/* 动作回执（清理辅助文件）：一行、几秒后自己消失。它说的是「刚才那件事成了」，
            不是需要处理的问题——那种走下面的 latex-error */}
        {latex.notice !== null && (
          <p className="latex-toast" role="status">
            <Icon
              name={latex.notice.kind === "cleaned" ? "circle-check" : "octagon-x"}
              size={12}
              style={{
                color:
                  latex.notice.kind === "cleaned" ? "var(--color-success)" : "var(--color-danger)",
              }}
            />
            {latex.notice.kind === "cleaned"
              ? latex.notice.result.removed.length === 0
                ? t.latex.cleanedNothing
                : t.latex.cleaned(latex.notice.result.removed.length)
              : t.latex.cleanFailed(latex.notice.message)}
          </p>
        )}
      {/* body 是 container query 的查询容器（styles.css 裁决 solo / 隐藏 / 浮层 /
          并排四种形态），layout 是它的直接内容层——@container 查不到容器自己，
          两层不能合并。遮罩只在「浮层」形态显示（CSS 管），点击收起树 */}
      <div className="files-panel-body" ref={bodyRef}>
        <div
          className="files-panel-layout"
          data-file={layoutAttrs["data-file"]}
          data-tree={layoutAttrs["data-tree"]}
        >
          <div className="files-panel-tree">
            {/* 过滤行钉在面板头顶部不随树滚动（设计稿的位置）：壳的内容区是一个滚动层，
                这里在内部分「固定过滤行 + 滚动树」两块，不动 RightPanelFrame */}
            {fileOpen ? (
              <div className="files-tree-filter">
                <PanelFilter
                  value={query}
                  onChange={setQuery}
                  placeholder={t.files.filter}
                  ariaLabel={t.files.filterAria}
                  count={filterCountText(shownCount, loadedCount, filtering)}
                />
              </div>
            ) : null}
            {/* 列宽钉死在容器宽度（minmax(0,1fr)）：隐式列默认按内容撑开，一条很长的附加目录
                路径（不换行）会把整列撑到几倍宽，整棵树横向溢出、居中的 Attach 文案与行尾的
                Detach 都被推出视野——省略号只有在列宽受约束时才会出现 */}
            <div className="panel-list" style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto" }}>
              {error !== null && (
                <div style={{ padding: "var(--space-3)" }}>
                  <PanelLine danger>{error}</PanelLine>
                </div>
              )}
              {tree.rootsError !== null && (
                <div style={{ padding: "var(--space-3)" }}>
                  <PanelLine danger>{t.files.rootsFailed} {tree.rootsError}</PanelLine>
                </div>
              )}
              {tree.rootsLoading && tree.roots.length === 0 && sessionId !== null && (
                <div style={{ padding: "var(--space-3)" }}>
                  <PanelLine>{t.common.loading}</PanelLine>
                </div>
              )}
              {tree.roots.map(rootGroup)}
              {/* 还没有会话（新任务没发首条消息）：Session 分组留在最前，但只给一行灰字——
                  此刻工作台既不该请求也不存在，roots 里的 session 根已被 useFileTree 过滤。
                  组头同样可折叠（2026-10-11 用户裁决：Session 组「没东西的时候也应该可以折叠」，
                  不然那行解释词一直顶着）；折叠键用常量——真实根的键是绝对路径，撞不上 */}
              {sessionId === null && (
                <div>
                  <RootLabel
                    kind="session"
                    detail=""
                    detailTitle=""
                    canReveal={false}
                    collapsed={collapsedGroups.has(PLACEHOLDER_SESSION_GROUP)}
                    onToggle={() =>
                      setCollapsedGroups((prev) => toggleGroupCollapsed(prev, PLACEHOLDER_SESSION_GROUP))
                    }
                  />
                  {!collapsedGroups.has(PLACEHOLDER_SESSION_GROUP) && (
                    <DimRow>{t.files.noWorkbench}</DimRow>
                  )}
                </div>
              )}
            </div>
          </div>
          {/* 浮层形态的遮罩：常驻渲染，显隐由 container query 管（与树同源） */}
          <div className="files-panel-backdrop" aria-hidden="true" onClick={() => setTreeOn(false)} />
          {/* 稿件区：单标签，或并排的两块。左块在两种形态下是**同一个组件位置**
              （只外面多一层 flex 容器），切布局不会把编辑器重挂。
              C9：这一拍要收的标签（focusDrop）整块都不渲染——并排的两块请求的是
              同一个根的白名单，只挡左块等于让右块拿刚失效的根再读一次 */}
          {shownTab !== null && (
            <div className={`files-panel-panes${splitOn ? " split" : ""}`}>
              <div className="files-panel-pane">
                <FilePreviewPane
                  key={`left:${leftPath ?? shownTab.path}`}
                  sessionId={sessionId}
                  workspaceId={workspaceId}
                  extraWorkspaceId={focusWorkspaceId}
                  root={shownTab.root}
                  path={leftPath ?? shownTab.path}
                  rootLabel={
                    tree.roots.find((r) => r.path === shownTab.root)?.label ?? pathTail(shownTab.root)
                  }
                  {...(leftPath === shownTab.path && shownTab.name !== undefined
                    ? { sentImage: { name: shownTab.name } }
                    : {})}
                  // 跳转只跟着它那份 PDF：用户在树里换了文件，旧跳转不该落到新文件上；
                  // 并排时的左块若换成了主文件，旧跳转也不属于它
                  jump={leftPath === shownTab.path && jump !== null && jump.citation.path === shownTab.path ? jump : null}
                  // 论文工作台：项目里的 PDF 走预览（不受「PDF 引用」实验开关管——
                  // 刚编出来的 PDF 是编译条的直接产物）；编译成功后按 mtime 重载。
                  // 比路径要用 samePath：树里拼的是 `/`，主进程给的是 `\`
                  pdfPreview={leftIsProjectPdf}
                  pdfReloadToken={leftIsProjectPdf ? latex.pdfReloadToken : 0}
                  editor={{
                    register: registerEditor,
                    onDirtyChange: handleEditorDirty,
                    onSaved: handleEditorSaved,
                    onError: handleEditorError,
                  }}
                />
              </div>
              {splitOn && splitPdfPath !== null && (
                <div className="files-panel-pane">
                  {/* 右块：项目的 PDF。它不属于标签队列（标签仍是用户打开的那些），
                      所以不接跳转、不接编辑器，只在编译成功后重载 */}
                  <FilePreviewPane
                    key={`pdf:${splitPdfPath}`}
                    sessionId={sessionId}
                    workspaceId={workspaceId}
                    extraWorkspaceId={focusWorkspaceId}
                    root={shownTab.root}
                    path={splitPdfPath}
                    rootLabel={
                      tree.roots.find((r) => r.path === shownTab.root)?.label ?? pathTail(shownTab.root)
                    }
                    pdfPreview
                    pdfReloadToken={latex.pdfReloadToken}
                  />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
        {latex.project !== null && (
          <LatexProblems
            groups={latexGroups}
            open={problemsOpen}
            onToggle={() => setProblemsOpen((open) => !open)}
            onHandToAgent={handProblemToAgent}
            onInstall={(command) => props.onRunInTerminal?.(command)}
          />
        )}
        {latex.error !== null && <p className="latex-error">{latex.error}</p>}
        {editorNotice !== null && <p className="latex-error">{editorNotice}</p>}
      </div>
    </RightPanelFrame>
  );
}

const failMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * 行尾悬停动作键的几何（树行 / 附件行共用）：22px 方块，在 32px 行（--list-item-compact）里上下各 5；
 * 最外一颗的右缘钉在行右内边距（= .file-row 的 padding-right，var(--space-2)）——
 * 血线规则的悬停组合：静止态尾部也钉在同一条线上，悬停时它让位、动作键补位。
 */
const ROW_ACT_SIZE = 22;
const ROW_ACT_TOP = 5;
const ROW_ACT_RIGHT = 8;

/**
 * 根分组头：右栏统一的 PanelGroupHead（小号半粗无衬线 + 浅灰补充，整行可折，组间只靠
 * 留白）。补充一律是根的显示名（会话标题 / 工作区名 / 附加目录末段），完整绝对路径
 * 在 title——原先在这里铺等宽绝对路径，窄栏里只剩 `/Users/guanhongli/Or…`。
 * 三组同样可折，包括还没有会话的 Session 占位组（2026-10-11 用户裁决）；
 * onToggle / collapsed 成对出现，占位组的折叠键用常量 PLACEHOLDER_SESSION_GROUP。
 * 行尾的排序 / Reveal / Detach 是悬停才出现的安静键（平时不占位）。
 */
function RootLabel(props: {
  kind: FileRootKind;
  detail: string;
  detailTitle: string;
  canReveal: boolean;
  /** 挂了但盘上找不到了：补充文字用 warning 色——颜色不是唯一信号，DimRow 那行的文字还在 */
  missing?: boolean;
  /** 该组当前是否折起；所有组头都可折（含 Session 占位组） */
  collapsed: boolean;
  onToggle: () => void;
  onReveal?: () => void;
  onDetach?: () => void;
  /** 排序切换（只 Session 组接）：当前档位；图标反映当前档、tooltip 说切换动作 */
  sort?: { mode: "name" | "type" };
  onSort?: () => void;
  /** 右键（目前只有 Session 根接）：与条目行同一份 ContextMenu 机制 */
  onContextMenu?: (position: { x: number; y: number }) => void;
}) {
  const t = useT();
  const actions: React.ReactNode[] = [];
  if (props.sort !== undefined && props.onSort !== undefined) {
    actions.push(
      <LabelAction
        key="sort"
        title={props.sort.mode === "name" ? t.files.sortByType : t.files.sortByName}
        onClick={props.onSort}
        icon={props.sort.mode === "name" ? "arrow-down-a-z" : "arrow-down-wide-narrow"}
      />,
    );
  }
  if (props.canReveal && props.onReveal !== undefined) {
    actions.push(
      <LabelAction key="reveal" title={t.files.revealInFileManager} onClick={props.onReveal} icon="folder-open" />,
    );
  }
  if (props.onDetach !== undefined) {
    actions.push(<LabelAction key="detach" title={t.files.detachTip} onClick={props.onDetach} icon="unlink" />);
  }
  return (
    <PanelGroupHead
      label={props.kind === "session" ? t.files.session : props.kind === "workspace" ? t.files.workspace : t.files.attached}
      detail={props.detail}
      detailTitle={props.detailTitle}
      detailWarn={props.missing === true}
      collapsed={props.collapsed}
      onToggle={props.onToggle}
      onContextMenu={
        props.onContextMenu === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              props.onContextMenu?.({ x: event.clientX, y: event.clientY });
            }
      }
      trailing={actions.length > 0 ? actions : undefined}
    />
  );
}

/** 组头行尾的 22px 安静键（悬停组头才出现，显隐在 .panel-group-acts） */
function LabelAction(props: { title: string; onClick: () => void; icon: IconName }) {
  return (
    <IconButton label={props.title} size={22} onClick={props.onClick}>
      <Icon name={props.icon} size={13} />
    </IconButton>
  );
}

/**
 * 30px 树行：chevron + 类型图标 + 名字 +（hover 时的 size · mtime，仅文件行）+
 * （AGENTS.md 的 `rules` 尾注）。目录行点击展开收起；文件行单击即打开 / 激活标签
 * （`aria-selected` + CSS 高亮，双击 / Enter 同一动作），不再单击 reveal——
 * Reveal 按钮是兄弟节点浮在行上（button 不能套 button），两个都 Tab 可达。
 */
function TreeRow(props: {
  name: string;
  kind: FileEntryKind;
  depth: number;
  open: boolean;
  /** 字节数；只有文件行带（目录 / symlink 不带），hover 行尾的 size 就靠它判定要不要出 */
  size?: number;
  modifiedAt: number;
  onToggle: () => void;
  onReveal: () => void;
  /** 非目录行的选中态；目录行恒为 false，不参与选中（目录照旧单击展开收起） */
  selected: boolean;
  /** 单击 / 双击 / Enter 非目录行：打开（或激活）这个文件的标签 */
  onOpen: () => void;
  /** 行尾 hover 的「添加文件引用」——引用是高频动作，升到与 Reveal 并排的一键入口 */
  onReference: () => void;
}) {
  const t = useT();
  const isDir = props.kind === "directory";
  const isSymlink = props.kind === "symlink";
  // dotfile：照列，但排在同层最后（orderEntries）且名字退灰——见 tree-view 的注释
  const dotted = props.name.startsWith(".");
  const isRules = props.name === "AGENTS.md";
  const iconName = fileIcon(props.name, props.kind, props.open);
  // 文档 / 演示 / 表格三族图标上色（fileIconTone），其余中性——名字文字仍正墨
  const tone = fileIconTone(props.name, props.kind);
  const hasMeta = props.size !== undefined;
  // hover 行尾把 size·mtime 缩成 `48 KB · 12m`，省略的完整信息（名字、完整时间戳）
  // 放回 title 里；symlink 没有 size，但契约里连目标路径都没有，title 只能如实说
  // 「这是一条符号链接」，不假装知道更多
  const title = isSymlink
    ? t.files.symlink
    : hasMeta
      ? `${props.name} · ${props.size !== undefined ? `${formatSize(props.size)} · ` : ""}${t.time.dateTime(props.modifiedAt)}`
      : undefined;
  return (
    <div className="file-hover-host" style={{ position: "relative" }}>
      <button
        type="button"
        className="file-row"
        aria-expanded={isDir ? props.open : undefined}
        aria-selected={isDir ? undefined : props.selected}
        title={title}
        onClick={isDir ? props.onToggle : props.onOpen}
        onDoubleClick={isDir ? undefined : props.onOpen}
        onKeyDown={
          isDir
            ? undefined
            : (event) => {
                if (event.key !== "Enter") return;
                // button 的 Enter 默认会再触发一次合成 click（= onOpen）——
                // preventDefault 掐掉那次合成 click，标签只由这里打开一次
                event.preventDefault();
                props.onOpen();
              }
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          height: "var(--list-item-compact)",
          paddingLeft: `calc(var(--space-2) + ${props.depth} * 16px)`,
          // 右内边距在 .file-row 的 CSS 里（= 行右血线）
          border: 0,
          font: "inherit",
          fontSize: "var(--font-size-base)",
          textAlign: "left",
          cursor: "pointer",
          color: "var(--color-text-primary)",
        }}
      >
        {isDir ? (
          <Icon
            name={props.open ? "chevron-down" : "chevron-right"}
            size={12}
            style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
          />
        ) : (
          <span style={{ width: 12, flex: "0 0 auto" }} />
        )}
        {isSymlink ? (
          // symlink：契约里没有目标路径、也不知道目标是文件还是目录——中性 file
          // 图标 + 右下角 8px arrow-up-right 角标（真身路径需要 FileEntry 加
          // target 字段，另开 shared PR，这里点到为止）
          <span className="file-icon-badge-wrap">
            <Icon name={iconName} size={14} style={{ color: "var(--color-text-tertiary)" }} />
            <Icon
              name="arrow-up-right"
              size={8}
              strokeWidth={2.6}
              className="file-symlink-badge"
              style={{ color: "var(--color-text-tertiary)" }}
            />
          </span>
        ) : (
          <Icon
            name={iconName}
            size={14}
            style={{
              color: tone === null ? "var(--color-text-tertiary)" : FILETYPE_TONE_COLOR[tone],
              flex: "0 0 auto",
            }}
          />
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            color: dotted ? "var(--color-text-tertiary)" : "var(--color-text-primary)",
          }}
        >
          {props.name}
        </span>
        {/* 行尾静止信息（size，AGENTS.md 再带一个 rules 尾注）：钉在行右血线上
            （.row-trailing），悬停时让位给绝对定位的引用 / Reveal 键（右栏统一） */}
        {(props.size !== undefined || isRules) && (
          <span className="row-trailing file-row-meta">
            {isRules && <span>{t.files.rules}</span>}
            {props.size !== undefined && <span>{formatSize(props.size)}</span>}
          </span>
        )}
      </button>
      {/* 引用（高频动作）与 Reveal 并排：同一套 hover 浮现语言，形态收进
          shell/RowHoverAction（Skills 行 / MCP 卡的「选用」键其后的两个消费者）。
          外侧 folder-open = 在文件管理器中显示；内侧 paperclip = 添加文件引用。
          图形与动作必须成对（2026-09-26 教训：只换图形不换动作，按钮就说谎了） */}
      <RowHoverAction
        icon="folder-open"
        title={t.files.revealInFileManager}
        onClick={props.onReveal}
        right={ROW_ACT_RIGHT}
        top={ROW_ACT_TOP}
        size={ROW_ACT_SIZE}
        iconSize={13}
        className="file-hover-act file-row-act"
      />
      <RowHoverAction
        icon="paperclip"
        title={t.files.reference}
        onClick={props.onReference}
        right={ROW_ACT_RIGHT + ROW_ACT_SIZE + 2}
        top={ROW_ACT_TOP}
        size={ROW_ACT_SIZE}
        iconSize={13}
        className="file-hover-act file-row-act"
      />
    </div>
  );
}

/** 附件列表吃同一条过滤词（按显示名：文件引用的末段 / 附图的合成名，与树同大小写口径） */
function filterAttachments(attachments: readonly SentAttachment[], query: string): SentAttachment[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [...attachments];
  return attachments.filter((item) => attachmentName(item).toLowerCase().includes(q));
}

/**
 * Session 分组下的「附件」小节：标题行 + 已发送清单（文件引用与附图，或空态一句）。
 * 文件引用的存在性由 facts 提供（fs:stat-kind 现问）；还没回来时按未知显示（不标不在）。
 */
function AttachmentSection(props: {
  attachments: readonly SentAttachment[];
  facts: ReadonlyMap<string, FsEntryFact>;
  roots: readonly FileRoot[];
  onSelectPreview: (root: FileRoot, path: string) => void;
  onOpenImage: (ref: string, name: string) => void;
  onReveal: (root: string, dir: string) => void;
  onReference: (ref: { path: string; name: string; kind: "file" | "dir" }) => void;
}) {
  const t = useT();
  // 附件是 Session 里的一个「虚拟子文件夹」（2026-10-11 用户验收：要能折叠、与树对齐）：
  // 头部就是一条深度 0 的目录行（chevron + 文件夹图标 + 名字 + 计数），条目是深度 1 的
  // 文件行——与树里目录及其子项同一几何
  const [open, setOpen] = useState(true);
  return (
    <section aria-label={t.files.attachments}>
      <button
        type="button"
        className="file-row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          height: "var(--list-item-compact)",
          paddingLeft: "var(--space-2)",
          border: 0,
          font: "inherit",
          fontSize: "var(--font-size-base)",
          textAlign: "left",
          cursor: "pointer",
          color: "var(--color-text-primary)",
        }}
      >
        <Icon
          name={open ? "chevron-down" : "chevron-right"}
          size={12}
          style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
        />
        <Icon name={open ? "folder-open" : "folder"} size={14} style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }} />
        <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {t.files.attachments}
        </span>
        <span className="row-trailing file-row-meta">{props.attachments.length}</span>
      </button>
      {open &&
        (props.attachments.length === 0 ? (
          <DimRow indent={1}>{t.files.attachmentsEmpty}</DimRow>
        ) : (
          props.attachments.map((item) =>
            item.kind === "image" ? (
              <ImageAttachmentRow key={item.ref} attachment={item} onOpen={props.onOpenImage} />
            ) : (
              <AttachmentRow
                key={item.path}
                path={item.path}
                declaredKind={item.fileKind}
                fact={props.facts.get(item.path)}
                roots={props.roots}
                onSelectPreview={props.onSelectPreview}
                onReveal={props.onReveal}
                onReference={props.onReference}
              />
            ),
          )
        ))}
    </section>
  );
}

/**
 * 一张已发送附图：图标吃 fileIcon（png → image 形状），名字是合成名，title 挂
 * 原图引用。点击走 session.attachment 的附图预览（标签身份 = 引用）。
 * **没有**行尾的 Reveal / 「添加文件引用」：原图只有相对引用、拿不到绝对路径，
 * 做出来就是假按钮（2026-10-11 裁决不给）；等有路径的通道再补。
 */
function ImageAttachmentRow(props: {
  attachment: Extract<SentAttachment, { kind: "image" }>;
  onOpen: (ref: string, name: string) => void;
}) {
  const name = props.attachment.name;
  return (
    <button
      type="button"
      className="file-row"
      title={props.attachment.ref}
      onClick={() => props.onOpen(props.attachment.ref, name)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        width: "100%",
        height: "var(--list-item-compact)",
        paddingLeft: `calc(var(--space-2) + 1 * 16px)`,
        border: 0,
        font: "inherit",
        fontSize: "var(--font-size-base)",
        textAlign: "left",
        cursor: "pointer",
        color: "var(--color-text-primary)",
      }}
    >
      <span style={{ width: 12, flex: "0 0 auto" }} />
      <Icon
        name={fileIcon(name, "file")}
        size={14}
        style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
      />
      <DirMarkName name={name} dir={false} wrapStyle={{ flex: "1 1 auto" }} />
    </button>
  );
}

/**
 * 一条已发送附件：图标吃 fileIcon（类型以盘上事实优先，转录里的 kind 兑底），
 * 名字是路径末段，title 挂模型实际拿到的那条完整路径。不在盘上的如实标出、
 * 不报错也不可点；文件点击走现有预览、目录点击 reveal——都要求落在某个在盘的
 * 根之内（副本在不进树的 attachments 根、workspace 引用在工作区根；超限未复制的
 * 原位置引用可能在根外，只展示）。行尾 hover 的「添加文件引用」把这条再引回输入框。
 */
function AttachmentRow(props: {
  path: string;
  declaredKind: "file" | "dir";
  fact: FsEntryFact | undefined;
  roots: readonly FileRoot[];
  onSelectPreview: (root: FileRoot, path: string) => void;
  onReveal: (root: string, dir: string) => void;
  onReference: (ref: { path: string; name: string; kind: "file" | "dir" }) => void;
}) {
  const t = useT();
  const name = pathTail(props.path) || props.path;
  // 类型以盘上事实优先；stat 还没回来（fact 未定义）时用转录里记的 kind 兑底
  const statKind = props.fact?.kind;
  const kind: FileEntryKind =
    statKind === "dir" || (statKind === undefined && props.declaredKind === "dir")
      ? "directory"
      : "file";
  const tone = fileIconTone(name, kind);
  const missing = props.fact !== undefined && props.fact.kind === null;
  const owner = props.roots.find((root) => root.exists && pathWithin(root.path, props.path)) ?? null;
  const clickable = !missing && owner !== null;
  return (
    <div className="file-hover-host" style={{ position: "relative" }}>
      <button
        type="button"
        className="file-row"
        title={props.path}
        disabled={!clickable}
        onClick={
          clickable && owner !== null && kind !== "directory"
            ? () => props.onSelectPreview(owner, props.path)
            : clickable && owner !== null
              ? () => props.onReveal(owner.path, props.path)
              : undefined
        }
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          height: "var(--list-item-compact)",
          paddingLeft: `calc(var(--space-2) + 1 * 16px)`,
          // 尾部（size / 已不在）是静止态元素：右缘钉在 .file-row 的右内边距（右血线，
          // 验收 M）；悬停动作键绝对定位盖上、尾部让位（styles.css）
          border: 0,
          font: "inherit",
          fontSize: "var(--font-size-base)",
          textAlign: "left",
          cursor: clickable ? "pointer" : "default",
          color: "var(--color-text-primary)",
        }}
      >
        <span style={{ width: 12, flex: "0 0 auto" }} />
        <Icon
          name={fileIcon(name, kind)}
          size={14}
          style={{
            color: tone === null ? "var(--color-text-tertiary)" : FILETYPE_TONE_COLOR[tone],
            flex: "0 0 auto",
          }}
        />
        {/* 名字 + 目录尾 `/`：共用组件 DirMarkName（胶囊 / 面板行 / 气泡三处同一段
            结构；2026-10 验收 I+K：斜杠紧跟名字，不再挂到行的另一头） */}
        <DirMarkName name={name} dir={kind === "directory"} wrapStyle={{ flex: "1 1 auto" }} />
        {/* 尾部（size / 已不在）：静止态钉在右血线上（.row-trailing，验收 M），
            悬停时让位给绝对定位的引用 / Reveal 动作键 */}
        <span className="row-trailing attachment-row-tail">
          {missing ? (
            <span className="attachment-missing-mark" title={t.files.attachmentMissing}>
              <Icon name="triangle-alert" size={11} strokeWidth={2} />
              {t.files.attachmentMissingShort}
            </span>
          ) : (
            props.fact?.size != null &&
            props.fact.kind === "file" && <span>{formatSize(props.fact.size)}</span>
          )}
        </span>
      </button>
      {clickable && owner !== null && (
        <RowHoverAction
          icon="folder-open"
          title={t.files.revealInFileManager}
          onClick={() => props.onReveal(owner.path, props.path)}
          right={ROW_ACT_RIGHT}
          top={ROW_ACT_TOP}
          size={ROW_ACT_SIZE}
          iconSize={13}
          className="file-hover-act file-row-act"
        />
      )}
      <RowHoverAction
        icon="paperclip"
        title={t.files.reference}
        onClick={() => props.onReference({ path: props.path, name, kind: kind === "directory" ? "dir" : "file" })}
        right={clickable ? ROW_ACT_RIGHT + ROW_ACT_SIZE + 2 : ROW_ACT_RIGHT}
        top={ROW_ACT_TOP}
        size={ROW_ACT_SIZE}
        iconSize={13}
        className="file-hover-act file-row-act"
      />
    </div>
  );
}

/** 灰字占位行（工作台为空 / 目录没了 / 还没有会话 / 加载中）——只占一行，不出空文件夹。
 *  ellipsis 包在内层 span 上：外层是 flex（spinner 行里有图标），flex 容器自己的
 * text-overflow 不作用于匿名子项，省略号根本不出来（树并排窄列实测被硬切） */
function DimRow(props: { children: React.ReactNode; title?: string; indent?: number }) {
  return (
    <p
      title={props.title}
      style={{
        margin: 0,
        height: "var(--list-item-compact)",
        display: "flex",
        alignItems: "center",
        padding: "0 var(--space-2)",
        // indent：挂在某一层目录下时与该层文件名对齐（chevron 12 + 图标 14 + 两个 gap）
        paddingLeft: `calc(var(--space-2) + ${(props.indent ?? 0) * 16}px + ${props.indent ? 32 : 0}px)`,
        fontSize: "var(--font-size-sm)",
        color: "var(--color-text-tertiary)",
      }}
    >
      <span
        style={{
          display: "block",
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {props.children}
      </span>
    </p>
  );
}

/**
 * missing attached 根那一行：DimRow 文字 + 常驻 Detach 按钮同一行。与别处 hover
 * 才浮现的 Detach 不同——这个状态需要用户处理，入口常驻现场（同 Skills 列表
 * missing 行的原则）。颜色（组头路径的 warning）不是唯一信号，这里的文字照旧。
 */
function MissingAttachedRow(props: { onDetach: () => void }) {
  const t = useT();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: "var(--space-2)" }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <DimRow title={t.files.missingTip}>{t.files.missing}</DimRow>
      </div>
      <button
        type="button"
        className="file-detach-btn"
        title={t.files.detachTip}
        onClick={props.onDetach}
      >
        <Icon name="unlink" size={10} />
        {t.files.detach}
      </button>
    </div>
  );
}

/**
 * 工作区没有 AGENTS.md 时的一行提示（右栏统一：不再是虚线卡，是一行浅灰可点行）：点击 reveal 工作区根（打开文件夹手建）。
 * 创建动作等写文件 IPC 落地，这一版不替用户碰盘。
 */
function AgentsMdHint(props: { onReveal: () => void }) {
  const t = useT();
  return (
    <button type="button" className="file-hint-row" title={t.files.createAgentsMdTip} onClick={props.onReveal}>
      <Icon name="book" size={13} style={{ flex: "0 0 auto" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {t.files.createAgentsMd}
      </span>
    </button>
  );
}
