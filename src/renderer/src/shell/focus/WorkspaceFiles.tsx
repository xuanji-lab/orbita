import { useCallback, useEffect, useRef, useState } from "react";
import "./focus.css";
import { api } from "../../api";
import { Icon } from "../Icon";
import { IconButton } from "../IconButton";
import { useT } from "../../locale";
import { relativeTime } from "../relative-time";
import { useFileTree } from "../../features/files/useFileTree";
import { fileIcon, fileIconTone } from "../../features/files/tree-view";
import { childSessions, rootSessions, type SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import type { FileEntry } from "@shared/files";
import type { FocusChangeEntry, FocusChangeKind, FocusChanges } from "@shared/focus";
import type { ChatSession } from "../../features/chat/useChatSession";
import { runStateLabel, sessionRunState } from "../../features/notify/completion-notice";
import {
  ancestorsOf,
  changeIndexOf,
  changeSummary,
  dirChangeIndex,
  formatChangeLines,
  isHiddenEntry,
  joinRel,
  shouldPollChanges,
} from "./focus-files.ts";

/**
 * 左栏的工作区文件视图（原型的状态 4 与 6）：顶上一行「返回 · 工作区名 · 分支」，
 * 浏览态垫一条「只是浏览，不计时」；专注态多一节可折叠的「这个工作区的会话」。
 * 下面是文件树：改过的文件标 U / M，目录带小圆点，改动路径的祖先目录自动展开。
 *
 * 树的加载与刷新整棵复用 features/files 的 useFileTree（sessionId=null：不出会话
 * 工作台根；agent 任何一轮结束它自己会刷新）。U / M 走 focus:changes（git 只读），
 * 30 秒一拉——快照视图，不为一个状态机常驻推送。
 */
export function WorkspaceFiles(props: {
  /** browse = 不计时地看一眼；focus = 专注中（多「这个工作区的会话」一节） */
  mode: "browse" | "focus";
  workspace: Workspace;
  workspaces: readonly Workspace[];
  session: ChatSession;
  /** 打开的会话 id（会话节的高亮） */
  openId: string | null;
  onBack: () => void;
  /** 浏览态的「以此开始专注」 */
  onStartFocusHere: () => void;
  /**
   * 双击 / Enter 打开一个文件的预览（绝对路径；App 经 nonce 请求递给右栏文件面板，
   * 预览根 = 本工作区——见 shared/files.ts 的 extraWorkspaceId）
   */
  onOpenFile: (absPath: string) => void;
}) {
  const t = useT();
  const { session, workspace } = props;
  const tree = useFileTree(null, workspace.id, props.workspaces);
  const [changes, setChanges] = useState<FocusChanges | null>(null);
  const [sessionsOpen, setSessionsOpen] = useState(true);
  /** 单击选中的文件（相对路径）：只高亮不打开——打开走双击 / Enter（用户裁决） */
  const [selectedRel, setSelectedRel] = useState<string | null>(null);

  // —─ U / M：拉取 + 30 秒一拉（快照视图：agent 写盘由 useFileTree 的自动刷新盖住，
  //    U/M 的半分钟延迟可见不是问题）。**窗口藏起来时跳过这一拍**：后台没人看，
  //    每次 git 读 + IPC 都是纯烧电；回到前台由 visibilitychange 立刻补一拍。 ──
  const [changesGen, setChangesGen] = useState(0);
  const loadChanges = useCallback(async (): Promise<void> => {
    try {
      setChanges(await api.focus.changes(workspace.id));
      setChangesGen((current) => current + 1);
    } catch (cause) {
      setChanges({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
    }
  }, [workspace.id]);
  useEffect(() => {
    void loadChanges();
    const timer = window.setInterval(() => {
      if (!shouldPollChanges(document.visibilityState)) return;
      void loadChanges();
    }, 30_000);
    const onVisible = (): void => {
      if (shouldPollChanges(document.visibilityState)) void loadChanges();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [loadChanges]);

  // 只取工作区根这一个根（fs:roots 还会带附加目录；专注看的是工作区本身）
  const root = tree.roots.find((item) => item.kind === "workspace") ?? null;
  const rootPath = root?.path ?? null;

  // —─ 改动路径的祖先目录自动展开（每份快照只做一轮：做完就记代次，用户手动
  //    折叠不再被顶开；懒加载一层层落定，effect 随 expanded/dirs 变化接着铺） ──
  const autoDoneGenRef = useRef(0);
  useEffect(() => {
    if (changes?.kind !== "ok" || rootPath === null) return;
    if (autoDoneGenRef.current === changesGen) return;
    const wanted = new Set<string>();
    for (const entry of changes.entries) {
      for (const dir of ancestorsOf(entry.path)) wanted.add(dir);
    }
    let toggled = false;
    for (const rel of wanted) {
      const abs = `${rootPath}/${rel}`;
      if (!tree.expanded.has(abs)) {
        tree.toggle(rootPath, abs);
        toggled = true;
      }
    }
    if (!toggled) autoDoneGenRef.current = changesGen;
  }, [changes, changesGen, rootPath, tree.expanded, tree.dirs, tree.toggle]);

  const changeList = changes?.kind === "ok" ? changes.entries : [];
  const byPath = changeIndexOf(changeList);
  const dirDots = dirChangeIndex(changeList);
  const summary = changeSummary(changeList);
  const branch = changes?.kind === "ok" ? changes.branch : null;

  // 这个工作区的会话（根会话、未归档，最近的在前——侧栏主列表同一条管线）
  const wsSessions = rootSessions(session.sessions).filter(
    (meta) => meta.workspaceId === workspace.id && !meta.archived,
  );

  return (
    <>
      {/*
        头部：返回（浏览态）· 工作区名 · 当前分支。分支是 git 的事实（mono），
        不是仓库 / 拿不到就不标，不猜。
      */}
      <div className="focus-wshead">
        {props.mode === "browse" && (
          <IconButton
            label={t.focus.backToSessions}
            title={t.focus.backToSessions}
            size={20}
            onClick={props.onBack}
            style={{ borderRadius: "var(--radius-xs)", color: "var(--color-text-secondary)" }}
          >
            <Icon name="chevron-left" size={13} strokeWidth={1.8} />
          </IconButton>
        )}
        <span style={{ color: "var(--color-text-secondary)", display: "grid", flex: "0 0 auto" }}>
          <Icon name="folder" size={14} strokeWidth={1.8} />
        </span>
        <strong title={workspace.path}>{workspace.name}</strong>
        {branch !== null && (
          <span className="focus-wshead-branch" title={branch}>
            <Icon name="git-branch" size={12} strokeWidth={1.8} />
            <span style={{ fontFamily: "var(--font-family-business)" }}>{branch}</span>
          </span>
        )}
      </div>

      {props.mode === "browse" && (
        <div className="focus-hint">
          {t.focus.browseHint}
          <button type="button" className="quiet-control focus-hint-btn" onClick={props.onStartFocusHere}>
            <Icon name="zap" size={12} strokeWidth={2} />
            {t.focus.startHere}
          </button>
        </div>
      )}

      <div
        className="scroll"
        style={{
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          marginRight: "calc(-1 * var(--space-3))",
          paddingRight: "var(--space-3)",
        }}
      >
        {props.mode === "focus" && (
          <>
            <div className="focus-foldhead">
              <button
                type="button"
                className="focus-fold"
                aria-expanded={sessionsOpen}
                onClick={() => setSessionsOpen((open) => !open)}
              >
                <Icon
                  name="chevron-down"
                  size={12}
                  strokeWidth={2}
                  style={{
                    transform: sessionsOpen ? "rotate(0deg)" : "rotate(-90deg)",
                    transition: "transform var(--duration-fast) var(--ease-standard)",
                  }}
                />
                {t.focus.wsSessions}
                <span className="focus-fold-count">{wsSessions.length}</span>
              </button>
              <span style={{ marginLeft: "auto" }}>
                <IconButton
                  label={t.focus.newTaskHere}
                  size={20}
                  onClick={() => session.newTaskIn(workspace)}
                  style={{ borderRadius: "var(--radius-xs)" }}
                >
                  <Icon name="plus" size={13} />
                </IconButton>
              </span>
            </div>
            {sessionsOpen &&
              wsSessions.map((meta) => (
                <WsSessionRow key={meta.id} meta={meta} session={session} active={meta.id === props.openId} />
              ))}
          </>
        )}

        <div className="focus-foldhead" style={{ marginTop: "var(--space-3)" }}>
          <span>{t.focus.filesTitle}</span>
          <span className="focus-legend">
            <span>
              <b>U</b>
              {t.focus.legendU}
            </span>
            <span>
              <b className="focus-legend-m">M</b>
              {t.focus.legendM}
            </span>
          </span>
        </div>

        {changes === null ? null : changes.kind === "ok" ? (
          <div className="focus-changesum">
            {t.focus.changeSummary(summary.changed, summary.untracked)}
          </div>
        ) : changes.kind === "empty" ? (
          <div className="focus-changesum">
            {changes.reason === "no-git" ? t.focus.noGit : t.focus.notRepo}
          </div>
        ) : (
          <div className="focus-changesum" title={changes.message}>
            {changes.message}
          </div>
        )}

        {tree.rootsError !== null && <p style={{ margin: "var(--space-2) 0", fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>{tree.rootsError}</p>}
        {tree.actionError !== null && <p style={{ margin: "var(--space-2) 0", fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>{tree.actionError}</p>}
        {root === null ? (
          tree.rootsLoading ? null : <p style={{ margin: "var(--space-2) 0", fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>{t.focus.workspaceMissing}</p>
        ) : !root.exists ? (
          <p style={{ margin: "var(--space-2) 0", fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>{t.focus.workspaceMissing}</p>
        ) : (
          <FileRows
            rootPath={root.path}
            rel=""
            depth={0}
            dirs={tree.dirs}
            expanded={tree.expanded}
            onToggle={tree.toggle}
            byPath={byPath}
            dirDots={dirDots}
            selectedRel={selectedRel}
            onSelect={(rel) => setSelectedRel(rel)}
            onOpen={(abs) => props.onOpenFile(abs)}
          />
        )}
      </div>
    </>
  );
}

/** 一层目录的行（含递归的子目录）。dir 缓存没到（懒加载在途）这一层就不画，不摆 Loading 行 */
function FileRows(props: {
  rootPath: string;
  rel: string;
  depth: number;
  dirs: ReadonlyMap<string, readonly FileEntry[]>;
  expanded: ReadonlySet<string>;
  onToggle: (root: string, dir: string) => void;
  byPath: Map<string, FocusChangeEntry>;
  dirDots: Map<string, FocusChangeKind>;
  selectedRel: string | null;
  onSelect: (rel: string) => void;
  onOpen: (absPath: string) => void;
}) {
  const abs = props.rel === "" ? props.rootPath : `${props.rootPath}/${props.rel}`;
  const entries = props.dirs.get(abs);
  if (entries === undefined) return null;
  const visible = entries.filter((entry) => !isHiddenEntry(entry.name));
  const rows: React.ReactNode[] = [];
  for (const entry of visible) {
    const rel = joinRel(props.rel, entry.name);
    if (entry.kind === "directory") {
      // 子目录的展开态在 expanded 表里（根层永远直接展示，不在表里——useFileTree 的口径）
      const dirAbs = `${props.rootPath}/${rel}`;
      const open = props.expanded.has(dirAbs);
      rows.push(
        <FileDirRow
          key={rel}
          name={entry.name}
          depth={props.depth}
          open={open}
          dot={props.dirDots.get(rel) ?? null}
          onToggle={() => props.onToggle(props.rootPath, dirAbs)}
        />,
      );
      if (open) {
        rows.push(
          <FileRows
            key={`${rel}/`}
            rootPath={props.rootPath}
            rel={rel}
            depth={props.depth + 1}
            dirs={props.dirs}
            expanded={props.expanded}
            onToggle={props.onToggle}
            byPath={props.byPath}
            dirDots={props.dirDots}
            selectedRel={props.selectedRel}
            onSelect={props.onSelect}
            onOpen={props.onOpen}
          />,
        );
      }
      continue;
    }
    if (entry.kind !== "file") continue;
    rows.push(
      <FileRow
        key={rel}
        name={entry.name}
        depth={props.depth}
        change={props.byPath.get(rel) ?? null}
        selected={props.selectedRel === rel}
        onSelect={() => props.onSelect(rel)}
        onOpen={() => props.onOpen(`${props.rootPath}/${rel}`)}
      />,
    );
  }
  return <>{rows}</>;
}

/** 目录行：chevron + 文件夹 + 名字 +（里面有改动时的）小圆点 */
function FileDirRow(props: {
  name: string;
  depth: number;
  open: boolean;
  dot: FocusChangeKind | null;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <div className="file-hover-host">
    <button
      type="button"
      className="file-row focus-frow"
      style={{ paddingLeft: `calc(var(--space-2) + ${props.depth} * 16px)` }}
      onClick={props.onToggle}
      aria-expanded={props.open}
    >
      <span className="focus-frow-tw">
        <Icon
          name={props.open ? "chevron-down" : "chevron-right"}
          size={11}
          strokeWidth={2.2}
          style={{ transform: props.open ? "rotate(0deg)" : "rotate(0deg)", transition: "transform var(--duration-fast) var(--ease-out-quint)" }}
        />
      </span>
      <span className="focus-frow-icon">
        <Icon name={props.open ? "folder-open" : "folder"} size={14} strokeWidth={1.8} />
      </span>
      <span className="focus-frow-name dir">{props.name}</span>
      <span className="focus-frow-tail">
        {props.dot !== null && (
          <span
            className="focus-ddot"
            data-k={props.dot}
            title={props.dot === "U" ? t.focus.legendU : t.focus.legendM}
          />
        )}
      </span>
    </button>
    </div>
  );
}

/** 文件行：空转轴 + 类型图标 + 名字 +（悬停的）增删行数 + U / M。
 * 单击只选中（高亮），双击 / Enter 打开预览——与右栏文件树「单击即开」不同：
 * 左栏是文件导航不是标签页面板，误触不该开一排标签（用户裁决） */
function FileRow(props: {
  name: string;
  depth: number;
  change: FocusChangeEntry | null;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const t = useT();
  const change = props.change;
  const lines = change !== null ? formatChangeLines(change) : "";
  return (
    <div className="file-hover-host">
    <button
      type="button"
      className="file-row focus-frow"
      aria-selected={props.selected}
      style={{ paddingLeft: `calc(var(--space-2) + ${props.depth} * 16px)` }}
      title={change !== null ? `${props.name}${lines === "" ? "" : ` · ${lines}`}` : props.name}
      onClick={props.onSelect}
      onDoubleClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        // Enter 原生会触发 click（= 选中）；这里拦下换成打开，与双击同义
        event.preventDefault();
        props.onOpen();
      }}
    >
      <span className="focus-frow-tw" />
      <span className="focus-frow-icon" data-tone={fileIconTone(props.name, "file") ?? undefined}>
        <Icon name={fileIcon(props.name, "file")} size={14} strokeWidth={1.8} />
      </span>
      <span className="focus-frow-name">{props.name}</span>
      <span className="focus-frow-tail">
        {lines !== "" && <span className="focus-frow-lines">{lines}</span>}
        {change !== null && (
          <span
            className="focus-badge"
            data-k={change.kind}
            title={change.kind === "U" ? t.focus.badgeU : t.focus.badgeM}
          >
            {change.kind}
          </span>
        )}
      </span>
    </button>
    </div>
  );
}

/** 会话节里的一行：三节竖条（与主列表同一份推导）+ 标题 + 相对时间 */
function WsSessionRow(props: { meta: SessionMeta; session: ChatSession; active: boolean }) {
  const t = useT();
  const { meta, session } = props;
  const children = childSessions(session.sessions, meta.id);
  const bar = sessionRunState({
    slot: { phase: session.phaseOf(meta.id), approvals: session.approvalsOf(meta.id).length },
    children: children.map((child) => ({
      phase: session.phaseOf(child.id),
      approvals: session.approvalsOf(child.id).length,
    })),
    unread: meta.unread ?? null,
  });
  return (
    <button
      type="button"
      className="option-row focus-wsrow"
      data-active={props.active || undefined}
      onClick={() => session.openSession(meta.id)}
      style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", width: "100%", minHeight: "var(--control-height-md)", margin: "2px 0", padding: "var(--space-1) var(--space-2) var(--space-1) var(--space-1)", borderRadius: "var(--radius-sm)", fontFamily: "var(--font-family-base)", fontSize: "var(--font-size-base)", textAlign: "left" }}
    >
      {bar !== null && (
        <span className="status-bar option-row-bar" data-fill={bar} title={runStateLabel(bar, t)}>
          <i />
          <i />
          <i />
        </span>
      )}
      <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {meta.title === "" ? t.common.newTask : meta.title}
      </span>
      <span
        className="row-trailing"
        style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-tertiary)", fontVariantNumeric: "tabular-nums" }}
      >
        {relativeTime(meta.updatedAt, t)}
      </span>
    </button>
  );
}
