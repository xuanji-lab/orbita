import { Fragment, useState } from "react";
import { Icon } from "../../shell/Icon";
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
import type { FileEntryKind, FileRoot, FileRootKind } from "@shared/files";

/**
 * 文件面板（设计稿 files-panel (b) 形态）：三组根——Session（本会话工作台，唯一随
 * 会话变的根，用户最常来找 plan / handoff）→ Workspace → Attached，往下每层
 * 30px 树行懒加载。attach / detach 就地做（工作区级、可增可减，不进设置页）。
 */
export function FilesPanel(props: { session: ChatSession; onClose: () => void }) {
  const session = props.session;
  /** 与 App 的 mainSessionId 同口径：活会话优先，退盘上打开的那条 */
  const sessionId = session.sessionId ?? session.opened?.id ?? null;
  const workspaceId = session.workspaceId;
  const [query, setQuery] = useState("");
  const [actionError, setActionError] = useState<string | null>(null);
  const tree = useFileTree(sessionId, workspaceId, session.workspaces);

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
          Loading…
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
          <DimRow>工作台为空 — agent 第一次写入时创建</DimRow>
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
            Files
          </strong>
        </>
      }
      contentKey="files"
      onClose={props.onClose}
      headerExtra={
        <PanelIconButton title="Attach a directory" onClick={attach}>
          <Icon name="plus" size={16} />
        </PanelIconButton>
      }
      footer={<PanelLine>{footerSummary(groupCount, missingAttached)}</PanelLine>}
    >
      <div
        style={{
          height: "100%",
          display: "grid",
          gridTemplateRows: "auto minmax(0, 1fr)",
        }}
      >
        {/* 过滤行钉在面板头顶部不随树滚动（设计稿的位置）：壳的内容区是一个滚动层，
            这里在内部分「固定过滤行 + 滚动树」两块，不动 RightPanelFrame */}
        <FilterRow
          value={query}
          onChange={setQuery}
          countText={filterCountText(shownCount, loadedCount, filtering)}
        />
        <div style={{ minHeight: 0, overflowY: "auto", display: "grid", alignContent: "start" }}>
          {error !== null && (
            <div style={{ padding: "var(--space-3)" }}>
              <PanelLine danger>{error}</PanelLine>
            </div>
          )}
          {tree.rootsError !== null && (
            <div style={{ padding: "var(--space-3)" }}>
              <PanelLine danger>Couldn’t read roots. {tree.rootsError}</PanelLine>
            </div>
          )}
          {tree.rootsLoading && tree.roots.length === 0 && sessionId !== null && (
            <div style={{ padding: "var(--space-3)" }}>
              <PanelLine>Loading…</PanelLine>
            </div>
          )}
          {/* 还没有会话（新任务没发首条消息）：Session 分组留在最前，但只给一行灰字——
              此刻工作台既不该请求也不存在，roots 里的 session 根已被 useFileTree 过滤 */}
          {sessionId === null && (
            <div style={{ padding: "6px 0 4px" }}>
              <RootLabel kind="session" detail="" canReveal={false} />
              <DimRow>Send the first message to get a workbench</DimRow>
            </div>
          )}
          {tree.roots.map(rootGroup)}
          <AttachRow onAttach={attach} />
        </div>
      </div>
    </RightPanelFrame>
  );
}

const failMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** 过滤行：本地过滤已加载的条目名（不递归拉取），右侧计数「命中 / 已加载总数」 */
function FilterRow(props: { value: string; onChange: (value: string) => void; countText: string }) {
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
        placeholder="Filter files…"
        aria-label="Filter files"
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
        title="Counts loaded entries only — the filter doesn't fetch collapsed folders"
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
}) {
  return (
    <div
      className="file-hover-host file-root-label"
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
        {props.kind === "session" ? "Session" : props.kind === "workspace" ? "Workspace" : "Attached"}
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
        <LabelAction title="Reveal in Finder" onClick={props.onReveal}>
          <Icon name="external-link" size={12} />
        </LabelAction>
      )}
      {props.onDetach !== undefined && (
        <LabelAction title="Detach this directory" onClick={props.onDetach}>
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
        background: "transparent",
        color: "var(--color-text-secondary)",
        cursor: "pointer",
      }}
    >
      {props.children}
    </button>
  );
}

/**
 * 30px 树行：chevron + 类型图标 + 名字 +（hover 时的 size · mtime，仅文件行）+
 * （AGENTS.md 的 `rules` 尾注）。目录行点击展开收起，文件行点击直接 reveal；
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
}) {
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
    ? "Symbolic link"
    : hasMeta
      ? `${props.name} · ${new Date(props.modifiedAt).toLocaleString()}`
      : undefined;
  return (
    <div className="file-hover-host" style={{ position: "relative" }}>
      <button
        type="button"
        className="file-row"
        aria-expanded={isDir ? props.open : undefined}
        title={title}
        onClick={isDir ? props.onToggle : props.onReveal}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          width: "100%",
          height: 30,
          paddingLeft: `calc(var(--space-3) + ${props.depth} * 16px)`,
          // 右侧给浮在行上的 Reveal（20px）留位：不留的话 AGENTS.md 的 rules 尾注会被它压住
          paddingRight: "calc(var(--space-3) + 20px)",
          border: 0,
          background: "transparent",
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
            {formatSize(props.size)} · {formatAge(props.modifiedAt, Date.now())}
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
            rules
          </span>
        )}
      </button>
      <button
        type="button"
        className="file-hover-act"
        title="Reveal in Finder"
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
          background: "var(--color-bg-panel)",
          color: "var(--color-text-secondary)",
          cursor: "pointer",
        }}
      >
        <Icon name="external-link" size={12} />
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
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, paddingRight: 12 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <DimRow title="Directory not found — moved or renamed outside orbita">
          Directory not found — moved or renamed
        </DimRow>
      </div>
      <button
        type="button"
        className="file-detach-btn"
        title="Detach this directory"
        onClick={props.onDetach}
      >
        <Icon name="unlink" size={10} />
        Detach
      </button>
    </div>
  );
}

/**
 * 工作区没有 AGENTS.md 时的虚线提示行：点击 reveal 工作区根（打开文件夹手建）。
 * 创建动作等写文件 IPC 落地，这一版不替用户碰盘。
 */
function AgentsMdHint(props: { onReveal: () => void }) {
  return (
    <button
      type="button"
      className="file-hint-row"
      title="Create AGENTS.md in the workspace folder"
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
      这个工作区还没有 AGENTS.md — 创建规则文件
    </button>
  );
}

/** 底部「挂一个目录」虚线按钮（与面板头 + 同一动作）。Home 会话同样能挂，不禁用了 */
function AttachRow(props: { onAttach: () => void }) {
  return (
    <button
      type="button"
      className="file-attach-row"
      title="Attach a directory"
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
      <Icon name="plus" size={14} style={{ flex: "0 0 auto" }} /> Attach a directory
    </button>
  );
}
