import { Fragment, useEffect, useState } from "react";
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
  relativePathOf,
} from "./tree-view";
import { useFileTree } from "./useFileTree";
import { FilePreviewPane } from "./FilePreviewPane";
import type { FileEntryKind, FileRoot, FileRootKind } from "@shared/files";
import { useT } from "../../locale.ts";

/**
 * 文件面板（设计稿 files-panel (b) 形态）：三组根——Session（本会话工作台，唯一随
 * 会话变的根，用户最常来找 plan / handoff）→ Workspace → Attached，往下每层
 * 30px 树行懒加载。attach / detach 就地做（工作区级、可增可减，不进设置页）。
 */
export function FilesPanel(props: {
  session: ChatSession;
  onClose: () => void;
  /**
   * App 的全局 Esc 先问这里：预览开着就只关预览、回报「处理掉了」，面板不关——
   * 与子会话面板「Esc 先退一层」同一个台阶。不自己挂 window 监听：App 的监听注册
   * 更早、先执行，两个都挂的话一下 Esc 会连预览带面板一起关掉。
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
  /** 选中的文件行（绝对路径）；目录行不参与选中 */
  const [selected, setSelected] = useState<string | null>(null);
  /** 打开的预览：root 是它所在分组的根路径，path 是文件绝对路径。null = 预览未打开 */
  const [preview, setPreview] = useState<{ root: string; path: string } | null>(null);
  /** 右键菜单：打开位置 + 被右键的那一行（root 用于相对路径与 fs 白名单）。
   * isRoot = 根分组头（目前只有 Session 根）：只有「添加文件引用」一项 */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    root: FileRoot;
    path: string;
    name: string;
    kind: FileEntryKind;
    isRoot?: boolean;
  } | null>(null);
  const tree = useFileTree(sessionId, workspaceId, session.workspaces);

  // 会话 / 工作区切换 = 换一棵树，选中与预览跟着清掉——旧会话的文件路径在新树里
  // 没有意义（同 useFileTree 清缓存 / 展开态的先例）
  useEffect(() => {
    setSelected(null);
    setPreview(null);
  }, [sessionId, workspaceId]);

  // 预览打开时 Esc 关闭：窄屏「回到目录」与宽屏「关闭预览」是同一个动作
  // （两者都只是 setPreview(null)，宽窄只影响头上按钮的图标与文案），所以
  // 不需要按宽度分支。Esc 由 App 的全局监听派发过来（见 props.escapeRef）
  const escapeRef = props.escapeRef;
  useEffect(() => {
    escapeRef.current = () => {
      if (preview === null) return false;
      setPreview(null);
      return true;
    };
    return () => {
      escapeRef.current = null;
    };
  }, [escapeRef, preview]);

  /** 单击文件行：选中；预览已经打开时同时把预览换成这一个（分栏模式的「像访达」行为） */
  const selectFile = (root: FileRoot, path: string): void => {
    setSelected(path);
    setPreview((prev) => (prev === null ? prev : { root: root.path, path }));
  };

  /** 双击 / Enter：选中并打开预览 */
  const openPreview = (root: FileRoot, path: string): void => {
    setSelected(path);
    setPreview({ root: root.path, path });
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
            selected={!isDir && selected === child}
            onSelect={() => selectFile(root, child)}
            onOpenPreview={() => openPreview(root, child)}
            onContextMenu={(position) =>
              setMenu({ ...position, root, path: child, name: entry.name, kind: entry.kind })
            }
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

  const rootGroup = (root: FileRoot, index: number): React.ReactNode => {
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
          onReveal={root.exists ? () => tree.reveal(root.path, root.path) : undefined}
          // missing 的 attached 根下面有常驻 Detach（见 MissingAttachedRow）——组头
          // 不再重复一个 hover 才出的 Detach，一个状态只留一个处理入口
          onDetach={root.kind === "attached" && root.exists ? () => detach(root.path) : undefined}
          // 会话根行也接右键：只有「添加文件引用」（把工作台目录整个递给模型）。
          // 工作台还没建（exists=false）时引用一条不存在的路径没有意义，不接
          onContextMenu={
            root.kind === "session" && root.exists
              ? (position) => setMenu({ ...position, root, path: root.path, name: root.label, kind: "directory", isRoot: true })
              : undefined
          }
        />
        {/* 「在 Proma 里找不到规则文件」的痛点落点：工作区没有 AGENTS.md 时给一条
            虚线提示行。点击只 reveal 工作区根（打开文件夹让用户手建）——创建动作
            等写文件 IPC 落地，这一版不碰盘。 */}
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
      </div>
    );
  };

  return (
    <RightPanelFrame
      header={
        <>
          <Icon name="folder" size={16} style={{ color: "var(--color-text-secondary)" }} />
          <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
            {t.files.title}
          </strong>
        </>
      }
      contentKey="files"
      onClose={props.onClose}
      headerExtra={
        <>
          {/* 面板是快照：agent 写了文件、外部改了盘，点这里重拉根与所有展开目录，
              展开态与滚动位置不动。图标用 folder-sync 而不是 refresh-cw：文件预览头上
              的 refresh-cw 是「重读这一个文件」，分栏时两者同屏，同一个图标不能干两件事。
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
      {/* 右键菜单（portal 到 body，位置在指针处）。条目行四项：打开 / 复制两个路径 /
          添加文件引用（origin workspace：原位置引用不复制）；「在文件管理器中显示」
          不进菜单——行尾的 hover Reveal 按钮就是它，放两处是重复。文件与目录都给——
          目录的「打开」就是文件管理器里打开它。打开走既有 fs:open 白名单，复制是纯
          renderer 剪贴板，零新契约。根分组头目前只有 Session 根接了右键，且只有
          「添加文件引用」（把工作台目录整个递给模型） */}
      <ContextMenu
        position={menu === null ? null : { x: menu.x, y: menu.y }}
        onClose={() => setMenu(null)}
        items={
          menu === null
            ? []
            : menu.isRoot === true
              ? [referenceItem(menu)]
              : [
                  {
                    id: "open",
                    label: t.files.openDefault,
                    icon: "external-link",
                    onSelect: () => {
                      if (menu === null) return;
                      void api.files
                        .open({ sessionId, workspaceId, root: menu.root.path, dir: menu.path })
                        .catch((cause: unknown) => setActionError(failMessage(cause)));
                    },
                  },
                  {
                    id: "copy-rel",
                    label: t.files.copyRelativePath,
                    icon: "copy",
                    onSelect: () => {
                      if (menu === null) return;
                      void navigator.clipboard.writeText(relativePathOf(menu.root.path, menu.path, api.platform === "win32"));
                    },
                  },
                  {
                    id: "copy-abs",
                    label: t.files.copyAbsolutePath,
                    icon: "copy",
                    onSelect: () => {
                      if (menu === null) return;
                      void navigator.clipboard.writeText(menu.path);
                    },
                  },
                  referenceItem(menu),
                ]
        }
      />
      {/* container query 分栏：容器 ≥600px 且预览打开 → 左目录右预览；<600px 且
          预览打开 → 只显示预览，目录用 CSS 隐藏（不卸载，展开态与滚动位置还在）；
          预览未打开 → 目录占满，与分栏前的版式一样。断点与显隐规则全在 styles.css，
          这里不量宽度（硬规则：container query 写，不用 JS 量）。
          body 是查询容器、split 是网格：@container 查不到容器自己，两层不能合并 */}
      <div className="files-panel-body">
        <div className="files-panel-split" data-preview={preview === null ? undefined : "open"}>
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
          {preview !== null && (
            <FilePreviewPane
              sessionId={sessionId}
              workspaceId={workspaceId}
              root={preview.root}
              path={preview.path}
              onClose={() => setPreview(null)}
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

/** 根分组标签：mono 小写大写化 + 灰色路径尾随，hover 才浮现 Reveal（attached 另有 Detach） */
function RootLabel(props: {
  kind: FileRootKind;
  detail: string;
  canReveal: boolean;
  /** 挂了但盘上找不到了：路径用 warning 色而不是 tertiary——颜色不是唯一信号，DimRow 那行的文字还在 */
  missing?: boolean;
  onReveal?: () => void;
  onDetach?: () => void;
  /** 右键（目前只有 Session 根接）：与条目行同一份 ContextMenu 机制 */
  onContextMenu?: (position: { x: number; y: number }) => void;
}) {
  const t = useT();
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
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-micro)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--color-text-secondary)",
      }}
    >
      {props.kind === "session" && <Icon name="message-square" size={11} style={{ flex: "0 0 auto" }} />}
      <span style={{ flex: "0 0 auto" }}>
        {props.kind === "session" ? t.files.session : props.kind === "workspace" ? t.files.workspace : t.files.attached}
      </span>
      <span
        title={props.detail}
        style={{
          color: props.missing === true ? "var(--color-warning)" : "var(--color-text-tertiary)",
          letterSpacing: 0,
          textTransform: "none",
          minWidth: 0,
          flex: 1,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {props.detail}
      </span>
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
 * （AGENTS.md 的 `rules` 尾注）。目录行点击展开收起；非目录行单击选中
 * （`aria-selected` + CSS 高亮），双击或 Enter 打开预览——不再单击 reveal，
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
  /** 单击非目录行：选中。若预览已打开，FilesPanel 会同时把预览换成这一个 */
  onSelect: () => void;
  /** 双击 / Enter 非目录行：选中并打开预览 */
  onOpenPreview: () => void;
  /** 右键：文件与目录都可「添加文件引用」，调用方拿指针位置与这一行的身份 */
  onContextMenu: (position: { x: number; y: number }) => void;
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
        onClick={isDir ? props.onToggle : props.onSelect}
        onDoubleClick={isDir ? undefined : props.onOpenPreview}
        onContextMenu={(event) => {
          // 右键同样是焦点动作：阻止浏览器默认菜单，弹我们的「引用到输入卡」
          event.preventDefault();
          props.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={
          isDir
            ? undefined
            : (event) => {
                if (event.key !== "Enter") return;
                // button 的 Enter 默认会再触发一次合成 click（= onSelect）——
                // preventDefault 掐掉那次合成 click，预览只由这里打开一次
                event.preventDefault();
                props.onOpenPreview();
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
