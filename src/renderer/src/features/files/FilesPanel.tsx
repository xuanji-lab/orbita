import { Fragment, useEffect, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { ContextMenu } from "../../shell/ContextMenu";
import type { MenuItem } from "../../shell/Menu";
import { PanelIconButton, PanelLine, RightPanelFrame } from "../../shell/RightPanel";
import { api } from "../../api";
import type { ChatSession } from "../chat/useChatSession";
import {
  countLoadedEntries,
  countVisibleEntries,
  fileIcon,
  filterCountText,
  filterEntries,
  footerSummary,
  formatAge,
  formatSize,
  hasAgentsMd,
  orderEntries,
} from "./tree-view";
import { useFileTree } from "./useFileTree";
import { FilePreviewPane } from "./FilePreviewPane";
import {
  closeTab,
  fileTabName,
  openTab,
  panelLayoutAttrs,
  shouldCollapseOnNarrow,
  toggleGroupCollapsed,
  TREE_BREAKPOINT,
  type FileTab,
} from "./panel-layout.ts";
import type { FileEntryKind, FileRoot, FileRootKind } from "@shared/files";
import { useT } from "../../locale.ts";

/**
 * 文件面板（设计稿 files-panel (b) 形态）：三组根——Session（本会话工作台，唯一随
 * 会话变的根，用户最常来找 plan / handoff）→ Workspace → Attached，往下每层
 * 30px 树行懒加载。attach / detach 就地做（工作区级、可增可减，不进设置页）。
 *
 * 交互模型（2026-10-10 改版，HTML 原型 files-panel-prototype.html，用户逐条裁决）：
 * 打开的文件以标签页列在头部「文件」标题旁，单击文件行即打开 / 激活标签；
 * 「文件」标题本身是文件树开关——有打开文件时可切树的显隐（宽容器并排窄列，
 * 窄容器浮层），没有打开文件时树就是整个面板、开关禁用。缩窄跨过 640px 断点树
 * 自动折叠；拉宽永不反向展开。布局裁决纯函数在 panel-layout.ts，显示形态的
 * container query 在 styles.css——这里不量宽度做显示判定。
 */
export function FilesPanel(props: {
  session: ChatSession;
  onClose: () => void;
  /**
   * App 的全局 Esc 先问这里：有激活标签就只关它、回报「处理掉了」，面板不关——
   * 与子会话面板「Esc 先退一层」同一个台阶。不自己挂 window 监听：App 的监听注册
   * 更早、先执行，两个都挂的话一下 Esc 会连标签带面板一起关掉。
   */
  escapeRef: { current: (() => boolean) | null };
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
  const activeTab =
    activePath === null ? null : (tabs.find((tab) => tab.path === activePath) ?? null);
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
  const tree = useFileTree(sessionId, workspaceId, session.workspaces);

  // 会话 / 工作区切换 = 换一棵树：标签与分组折叠跟着清掉，treeOn 一并复位——旧
  // 会话的文件路径在新树里没有意义（同 useFileTree 清缓存 / 展开态的先例），树的
  // 展开理由也随最后一个文件消失；新会话从「树关」起步，点开文件不会突然顶着
  // 浮层 / 并排列（同 closeOne 关最后一个标签的复位逻辑）
  useEffect(() => {
    setTabs([]);
    setActivePath(null);
    setCollapsedGroups(new Set());
    setTreeOn(false);
  }, [sessionId, workspaceId]);

  // 面板主体的宽度感知：唯一 allowed 的 JS 宽度事实，来自这只 ResizeObserver——
  // 跨过 640px 断点且方向是缩窄时把 treeOn 折叠（拉宽永不反向展开）；窄侧事实
  // 缓存进 narrowRef 供「浮层里点了文件 → 收浮层」用。显示形态（并排 / 浮层）
  // 仍由 styles.css 的 container query 裁决，这里只更新状态
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const narrowRef = useRef(false);
  useEffect(() => {
    const el = bodyRef.current;
    if (el === null) return;
    let wasWide: boolean | null = null;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      const nowWide = width >= TREE_BREAKPOINT;
      // 首帧只记侧、不动作：面板挂载在窄侧不该把已经开着的树折掉
      if (wasWide !== null && shouldCollapseOnNarrow(wasWide, nowWide)) setTreeOn(false);
      wasWide = nowWide;
      narrowRef.current = !nowWide;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  /** 关闭一个标签；关掉最后一个 = 回纯树，treeOn 一并复位——之后从 solo 点开
   * 文件不会突然顶着浮层 / 并排列（树的展开理由随最后一个文件消失） */
  const closeOne = (path: string): void => {
    const next = closeTab(tabs, activePath, path);
    setTabs(next.tabs);
    setActivePath(next.activePath);
    if (next.activePath === null) setTreeOn(false);
  };

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
    setActivePath(path);
    if (narrowRef.current) setTreeOn(false);
  };

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
    const shown = filterEntries(orderEntries(entries), query);
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
  const missingAttached = tree.roots.filter((root) => root.kind === "attached" && !root.exists)
    .length;
  // sessionId 为 null 时 Session 分组仍在（占位行），照数进 footer
  const groupCount = tree.roots.length + (sessionId === null ? 1 : 0);
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

  const rootGroup = (root: FileRoot, index: number): React.ReactNode => {
    const collapsed = collapsedGroups.has(root.path);
    return (
      <div
        key={root.path}
        style={{
          padding: index === 0 ? "6px 0 4px" : "8px 0 4px",
          marginTop: index === 0 ? 0 : 2,
          borderTop: index === 0 ? "none" : "1px solid var(--color-border-subtle)",
        }}
      >
        <RootLabel
          kind={root.kind}
          detail={root.kind === "session" ? root.label : root.path}
          canReveal={root.exists}
          missing={root.kind === "attached" && !root.exists}
          collapsed={collapsed}
          onToggle={() => setCollapsedGroups((prev) => toggleGroupCollapsed(prev, root.path))}
          onReveal={root.exists ? () => tree.reveal(root.path, root.path) : undefined}
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
      header={
        <>
          {/* 「文件」标题本身就是文件树开关（原型裁决）：树开着时呈点亮态（选中行
              的 mode 淡底配方）；没有打开文件时禁用——那时树就是整个面板 */}
          <button
            type="button"
            className="files-title-toggle"
            aria-expanded={fileOpen && treeOn ? "true" : undefined}
            disabled={!fileOpen}
            title={t.files.treeToggleTip}
            onClick={() => setTreeOn((value) => !value)}
          >
            <Icon name="folder" size={16} style={{ flex: "0 0 auto" }} />
            <span>{t.files.title}</span>
            <Icon name="chevron-right" size={11} strokeWidth={2.2} className="files-title-chev" />
          </button>
          {tabs.length > 0 && (
            <>
              <span className="files-head-sep" aria-hidden="true" />
              <div className="files-head-tabs" role="tablist" aria-label={t.files.tabsAria}>
                {tabs.map((tab) => {
                  const name = fileTabName(tab.path);
                  const active = tab.path === activePath;
                  return (
                    <div
                      key={tab.path}
                      role="tab"
                      tabIndex={0}
                      aria-selected={active}
                      className="files-tab no-drag"
                      title={tab.path}
                      onClick={() => setActivePath(tab.path)}
                      onKeyDown={(event) => {
                        if (event.key !== "Enter") return;
                        event.preventDefault();
                        setActivePath(tab.path);
                      }}
                    >
                      <Icon
                        name={fileIcon(name, "file")}
                        size={13}
                        style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)" }}
                      />
                      <span className="files-tab-name">{name}</span>
                      {/* ✕ 停在标签内（button 不能套 button，标签本体是 div）：点击
                          只关这一个标签，不要顺带触发标签的激活 */}
                      <button
                        type="button"
                        className="files-tab-close"
                        title={t.files.closeTab}
                        aria-label={`${t.files.closeTab} ${name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          closeOne(tab.path);
                        }}
                      >
                        <Icon name="x" size={10} strokeWidth={2.4} />
                      </button>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </>
      }
      contentKey="files"
      onClose={props.onClose}
      headerExtra={
        <>
          {/* 面板是快照：agent 写了文件、外部改了盘，点这里重拉根与所有展开目录，
              展开态与滚动位置不动。图标用 folder-sync 而不是 refresh-cw：文件预览头上
              的 refresh-cw 是「重读这一个文件」，同屏时同一个图标不能干两件事。
              在途时换成面板里通用的 loader-circle——转一个文件夹不像在加载 */}
          <PanelIconButton
            title={tree.refreshing ? t.files.refreshing : t.files.refresh}
            onClick={tree.refresh}
            disabled={tree.refreshing}
          >
            <Icon name={tree.refreshing ? "loader-circle" : "folder-sync"} size={16} spin={tree.refreshing} />
          </PanelIconButton>
          <PanelIconButton title={t.files.attach} onClick={attach}>
            <Icon name="plus" size={16} />
          </PanelIconButton>
        </>
      }
      footer={<PanelLine>{footerSummary(groupCount, missingAttached, t)}</PanelLine>}
    >
      {/* 右键菜单（portal 到 body，位置在指针处）。只有 Session 根分组头接了右键，
          仅一项「添加文件引用」——把工作台目录整个递给模型。条目行不接右键：
          引用走行尾 hover 按钮，其余动作不值得一张菜单（2026-09-27 用户裁决） */}
      <ContextMenu
        position={menu === null ? null : { x: menu.x, y: menu.y }}
        onClose={() => setMenu(null)}
        items={menu === null ? [] : [referenceItem(menu)]}
      />
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
            <FilterRow
              value={query}
              onChange={setQuery}
              countText={filterCountText(shownCount, loadedCount, filtering)}
            />
            {/* 列宽钉死在容器宽度（minmax(0,1fr)）：隐式列默认按内容撑开，一条很长的附加目录
                路径（不换行）会把整列撑到几倍宽，整棵树横向溢出、居中的 Attach 文案与行尾的
                Detach 都被推出视野——省略号只有在列宽受约束时才会出现 */}
            <div
              style={{
                minHeight: 0,
                overflowY: "auto",
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr)",
                alignContent: "start",
              }}
            >
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
              {/* 还没有会话（新任务没发首条消息）：Session 分组留在最前，但只给一行灰字——
                  此刻工作台既不该请求也不存在，roots 里的 session 根已被 useFileTree 过滤 */}
              {sessionId === null && (
                <div style={{ padding: "6px 0 4px" }}>
                  <RootLabel kind="session" detail="" canReveal={false} />
                  <DimRow>{t.files.noWorkbench}</DimRow>
                </div>
              )}
              {tree.roots.map(rootGroup)}
              <AttachRow onAttach={attach} />
            </div>
          </div>
          {/* 浮层形态的遮罩：常驻渲染，显隐由 container query 管（与树同源） */}
          <div className="files-panel-backdrop" aria-hidden="true" onClick={() => setTreeOn(false)} />
          {activeTab !== null && (
            <FilePreviewPane
              key={activeTab.path}
              sessionId={sessionId}
              workspaceId={workspaceId}
              root={activeTab.root}
              path={activeTab.path}
            />
          )}
        </div>
      </div>
    </RightPanelFrame>
  );
}

const failMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 过滤行：本地过滤已加载的条目名（不递归拉取），右侧计数「命中 / 已加载总数」 */
function FilterRow(props: { value: string; onChange: (value: string) => void; countText: string }) {
  const t = useT();
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: 34,
        padding: "0 var(--space-3)",
        borderBottom: "1px solid var(--color-border-subtle)",
        color: "var(--color-text-tertiary)",
      }}
    >
      <Icon name="search" size={14} style={{ flex: "0 0 auto" }} />
      <input
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        placeholder={t.files.filter}
        aria-label={t.files.filterAria}
        style={{
          flex: 1,
          minWidth: 0,
          border: 0,
          outline: 0,
          background: "transparent",
          font: "inherit",
          fontSize: "var(--font-size-control)",
          color: "var(--color-text-primary)",
        }}
      />
      <span
        title={t.files.countTip}
        style={{
          flex: "0 0 auto",
          fontFamily: "var(--font-family-mono)",
          fontSize: "var(--font-size-micro)",
          color: "var(--color-text-tertiary)",
        }}
      >
        {props.countText}
      </span>
    </div>
  );
}

/**
 * 根分组标签：mono 小写大写化 + 灰色路径尾随。组头整行可点：折起 / 展开该组
 * （chevron 指示开合、aria-expanded 交给可达性，原型裁决）。hover 才浮现的
 * Reveal / Detach 是按钮的兄弟节点（button 不能套 button），浮在行尾。
 * onToggle 缺省 = 不可折叠（还没有会话的占位组），不出 chevron、不出手型。
 */
function RootLabel(props: {
  kind: FileRootKind;
  detail: string;
  canReveal: boolean;
  /** 挂了但盘上找不到了：路径用 warning 色而不是 tertiary——颜色不是唯一信号，DimRow 那行的文字还在 */
  missing?: boolean;
  /** 该组当前是否折起；与 onToggle 成对出现 */
  collapsed?: boolean;
  onToggle?: () => void;
  onReveal?: () => void;
  onDetach?: () => void;
  /** 右键（目前只有 Session 根接）：与条目行同一份 ContextMenu 机制 */
  onContextMenu?: (position: { x: number; y: number }) => void;
}) {
  const t = useT();
  const collapsible = props.onToggle !== undefined && props.collapsed !== undefined;
  const label = (
    <>
      {collapsible && (
        <Icon name="chevron-right" size={11} strokeWidth={2.2} className="files-root-chev" />
      )}
      {props.kind === "session" && (
        <Icon name="message-square" size={11} style={{ flex: "0 0 auto" }} />
      )}
      <span style={{ flex: "0 0 auto" }}>
        {props.kind === "session" ? t.files.session : props.kind === "workspace" ? t.files.workspace : t.files.attached}
      </span>
      <span className="files-root-detail" title={props.detail} data-missing={props.missing === true ? "true" : undefined}>
        {props.detail}
      </span>
    </>
  );
  return (
    <div
      className="file-hover-host file-root-label"
      onContextMenu={
        props.onContextMenu === undefined
          ? undefined
          : (event) => {
              event.preventDefault();
              props.onContextMenu?.({ x: event.clientX, y: event.clientY });
            }
      }
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        minHeight: 24,
        padding: "0 var(--space-3)",
      }}
    >
      {collapsible ? (
        <button
          type="button"
          className="files-root-toggle"
          aria-expanded={!props.collapsed}
          title={t.files.groupToggleTip}
          onClick={props.onToggle}
        >
          {label}
        </button>
      ) : (
        // 占位组头（还没有会话）：不是按钮，不出手型、不亮 hover（CSS 同款规则）
        <div className="files-root-toggle">{label}</div>
      )}
      {props.canReveal && props.onReveal !== undefined && (
        <LabelAction title={t.files.revealInFileManager} onClick={props.onReveal}>
          <Icon name="folder-open" size={12} />
        </LabelAction>
      )}
      {props.onDetach !== undefined && (
        <LabelAction title={t.files.detachTip} onClick={props.onDetach}>
          <Icon name="unlink" size={12} />
        </LabelAction>
      )}
    </div>
  );
}

/** 标签行尾的 20px 小方块（hover 才出现） */
function LabelAction(props: { title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      className="file-hover-act"
      title={props.title}
      onClick={props.onClick}
      style={{
        width: 20,
        height: 20,
        flex: "0 0 auto",
        // display 由 .file-hover-act 的 CSS 管（hover 才出现）；写在 inline 会压过 CSS 的 display:none
        alignItems: "center",
        justifyContent: "center",
        padding: 0,
        border: 0,
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
      }}
    >
      {props.children}
    </button>
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
  const hasMeta = props.size !== undefined;
  // hover 行尾把 size·mtime 缩成 `48 KB · 12m`，省略的完整信息（名字、完整时间戳）
  // 放回 title 里；symlink 没有 size，但契约里连目标路径都没有，title 只能如实说
  // 「这是一条符号链接」，不假装知道更多
  const title = isSymlink
    ? t.files.symlink
    : hasMeta
      ? `${props.name} · ${t.time.dateTime(props.modifiedAt)}`
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
          height: 30,
          paddingLeft: `calc(var(--space-3) + ${props.depth} * 16px)`,
          // 右侧给浮在行上的两个 hover 按钮（引用 + Reveal，各 20px + 4px 缝）留位：
          // 不留的话 AGENTS.md 的 rules 尾注会被它们压住
          paddingRight: "calc(var(--space-3) + 44px)",
          border: 0,
          font: "inherit",
          fontSize: "var(--font-size-control)",
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
            style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
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
        {props.size !== undefined && (
          <span className="file-row-meta">
            {formatSize(props.size)} · {formatAge(props.modifiedAt, Date.now(), t)}
          </span>
        )}
        {isRules && (
          <span
            style={{
              fontFamily: "var(--font-family-mono)",
              fontSize: "var(--font-size-micro)",
              color: "var(--color-text-tertiary)",
              flex: "0 0 auto",
            }}
          >
            {t.files.rules}
          </span>
        )}
      </button>
      {/* 引用（最外侧，高频动作优先够到）与 Reveal 并排：同一套 hover 浮现语言 */}
      {/* 外侧 folder-open = 在文件管理器中显示；内侧 paperclip = 添加文件引用。
          图形与动作必须成对（2026-09-26 教训：只换图形不换动作，按钮就说谎了） */}
      <button
        type="button"
        className="file-hover-act file-row-act"
        title={t.files.revealInFileManager}
        aria-label={t.files.revealInFileManager}
        onClick={props.onReveal}
        style={{
          position: "absolute",
          right: 2,
          top: 5,
          width: 20,
          height: 20,
          // display 由 .file-hover-act 的 CSS 管（hover 才出现）
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: 0,
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        <Icon name="folder-open" size={12} />
      </button>
      <button
        type="button"
        className="file-hover-act file-row-act"
        title={t.files.reference}
        aria-label={t.files.reference}
        onClick={props.onReference}
        style={{
          position: "absolute",
          right: 24,
          top: 5,
          width: 20,
          height: 20,
          // display 由 .file-hover-act 的 CSS 管（hover 才出现）
          alignItems: "center",
          justifyContent: "center",
          padding: 0,
          border: 0,
          borderRadius: "var(--radius-sm)",
          cursor: "pointer",
        }}
      >
        <Icon name="paperclip" size={12} />
      </button>
    </div>
  );
}

/** 灰字占位行（工作台为空 / 目录没了 / 还没有会话 / 加载中）——只占一行，不出空文件夹 */
function DimRow(props: { children: React.ReactNode; title?: string }) {
  return (
    <p
      title={props.title}
      style={{
        margin: 0,
        height: 30,
        display: "flex",
        alignItems: "center",
        paddingLeft: "var(--space-3)",
        fontSize: "var(--font-size-caption)",
        color: "var(--color-text-tertiary)",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {props.children}
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 12 }}>
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
 * 工作区没有 AGENTS.md 时的虚线提示行：点击 reveal 工作区根（打开文件夹手建）。
 * 创建动作等写文件 IPC 落地，这一版不替用户碰盘。
 */
function AgentsMdHint(props: { onReveal: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="file-hint-row"
      title={t.files.createAgentsMdTip}
      onClick={props.onReveal}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        margin: "4px 10px 6px",
        padding: "8px 10px",
        border: "1px dashed var(--color-border-strong)",
        borderRadius: "var(--radius-md)",
        font: "inherit",
        fontSize: "var(--font-size-caption)",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <Icon name="book" size={13} style={{ flex: "0 0 auto" }} />
      {t.files.createAgentsMd}
    </button>
  );
}

/** 底部「挂一个目录」虚线按钮（与面板头 + 同一动作）。Home 会话同样能挂，不禁用了 */
function AttachRow(props: { onAttach: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      className="file-attach-row"
      title={t.files.attach}
      onClick={props.onAttach}
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 7,
        margin: "8px 10px 4px",
        minHeight: 36,
        border: "1px dashed var(--color-border-strong)",
        borderRadius: "var(--radius-lg)",
        font: "inherit",
        fontSize: "var(--font-size-control)",
        cursor: "pointer",
      }}
    >
      <Icon name="plus" size={14} style={{ flex: "0 0 auto" }} /> {t.files.attach}
    </button>
  );
}
