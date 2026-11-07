import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { ContextMenu } from "../../shell/ContextMenu";
import { RowHoverAction } from "../../shell/RowHoverAction";
import { PanelIconButton, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { DiffBody } from "../../shell/DiffView";
import { useT } from "../../locale.ts";
import { api } from "../../api";
import { REVIEW_SOURCES, type ReviewDiff, type ReviewEntry, type ReviewList, type ReviewSource } from "@shared/review";
import type { FileRoot } from "@shared/files";
import { pathWithin } from "../../../../shared/path.ts";
import {
  absoluteReviewPath,
  disambiguatedDirs,
  reviewDiffNotice,
  reviewEmptyText,
  reviewEmptyTitle,
  unifiedDiffEntries,
} from "./review-panel.ts";
import { pathParts } from "../chat/path-parts.ts";
import { Stats } from "../chat/FileTurnCard";
import { ExcerptsTab, type ExcerptJump } from "./ExcerptsTab";
import { MemoryTab } from "../memory/MemoryTab";
import { useExperimentalFeature } from "../../experimental";

/**
 * 悬停动作键的几何（与文件面板树行同一套 --list-item-compact 行配方：22px 方块、
 * 上下各留 5、右缘钉在行右内边距 var(--space-2)）
 */
const ROW_ACT_SIZE = 22;
const ROW_ACT_TOP = 5;
const ROW_ACT_RIGHT = 8;

/**
 * 审查面板（右栏新入口，与 Files / Skills / MCP 互斥）：四种来源——本任务改动
 * （默认，不依赖 git）、未暂存 / 已暂存 / 分支对比（git 只读）。列表行点击原地
 * 展开 diff；DiffBody 与聊天内 edit 的展开同一套视觉（行号列 + 整行 soft 底色 +
 * 词级高亮）。
 *
 * 数据全在主进程算（review:list / review:diff）；renderer 只收结果——git 的存在、
 * 仓库与否、upstream 与否都翻译成空态一句话（refusals explain the blocker）。
 *
 * 两个页签：「改动」（上面说的这些）与「摘抄」（用户划选存下的段落，见 ExcerptsTab）。
 * 摘抄不吃 git 来源，切过去时标题行的来源下拉与刷新键一起收起。
 */
export function ReviewPanel(props: {
  /** 正在看的会话；null = 还没开任务（task 来源没对象，git 来源也没 cwd） */
  sessionId: string | null;
  /** 会话的工作区（git 来源「在访达中显示」要拿 fs:roots 白名单找宿主根） */
  workspaceId: string | null;
  /** 轮尾卡 / 界碑卡的「在面板里看」请求：带 token 的一次性定位（展开 + 滚到） */
  focus: { path: string; token: number } | null;
  /**
   * 会话文件账的版本（轮尾账 / 回退 / 撤销的条数拼成的串）：变了就重拉当前来源。
   * 不接它的话，面板开着时 agent 又改了一轮文件，列表停在旧状态（实测）。
   */
  revision: string;
  /** 会话 cwd：cwd 之内显示相对路径 */
  cwd: string | null;
  /** 摘抄列表的版本（刚摘了一条就 +1）：变了就重拉摘抄页签 */
  excerptRevision: number;
  /** 摘抄页签点一条「回到原文」 */
  onJumpExcerpt: (jump: ExcerptJump) => void;
  /** 对话里记忆行的「在审查面板里看」：token 递增的一次性请求，切到记忆页签 */
  memoryFocus: number | null;
}) {
  const t = useT();
  const memoryOn = useExperimentalFeature("memory-system");
  const [tab, setTab] = useState<"changes" | "excerpts" | "memory">("changes");
  // 实验开关关掉时记忆页签整个不在：停在它上面的退回改动页签
  if (tab === "memory" && !memoryOn) setTab("changes");
  useEffect(() => {
    if (props.memoryFocus !== null) setTab("memory");
  }, [props.memoryFocus]);
  const [source, setSource] = useState<ReviewSource>("task");
  const [list, setList] = useState<ReviewList | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Map<string, ReviewDiff>>(new Map());
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);
  /** 右键菜单（复制路径）：并同 FilesPanel 的 ContextMenu 配方，位置在指针处 */
  const [menu, setMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  /** 行尾的一次性轻提示（已复制 / reveal 失败原因）：只落在触发它的那一行，短郎自灭 */
  const [hint, setHint] = useState<{ path: string; text: string; tone: "ok" | "bad" } | null>(null);
  const hintTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
  }, []);
  const flashHint = useCallback((path: string, text: string, tone: "ok" | "bad"): void => {
    if (hintTimerRef.current !== null) window.clearTimeout(hintTimerRef.current);
    setHint({ path, text, tone });
    hintTimerRef.current = window.setTimeout(() => {
      setHint(null);
      hintTimerRef.current = null;
    }, 1500);
  }, []);

  /**
   * 「在访达中显示」的宿主根（git 来源）：git 条目是仓库相对路径，拼成绝对路径后
   * 必须落在会话允许的某条根之内才能走 fs:reveal（白名单在主进程，同文件面板的
   * 纪律）。task 来源不走这里——它的白名单就是本任务文件账（session:reveal-artifact）。
   * 根没回来 / 都不收留：按钮不出现（同附件行「不在根内的只展示不可点」）。
   */
  const [revealRoots, setRevealRoots] = useState<readonly FileRoot[] | null>(null);
  useEffect(() => {
    if (source === "task" || props.sessionId === null) {
      setRevealRoots(null);
      return;
    }
    let alive = true;
    void api.files
      .roots({ sessionId: props.sessionId, workspaceId: props.workspaceId })
      .then((all) => {
        if (alive) setRevealRoots(all.filter((root) => root.kind !== "attachments" && root.exists));
      })
      .catch(() => {
        if (alive) setRevealRoots(null);
      });
    return () => {
      alive = false;
    };
  }, [source, props.sessionId, props.workspaceId]);

  const refresh = useCallback(
    (wanted: ReviewSource) => {
      if (props.sessionId === null) return;
      setLoading(true);
      void api.review
        .list(props.sessionId, wanted)
        .then((result) => {
          setList(result);
          setDiffs(new Map());
        })
        .catch((cause: unknown) =>
          setList({
            kind: "error",
            message: cause instanceof Error ? cause.message : String(cause),
            cwd: "",
          }),
        )
        .finally(() => setLoading(false));
    },
    [props.sessionId],
  );

  // 换来源 / 手动刷新 / 会话切换都重拉；会话空了清空
  useEffect(() => {
    if (props.sessionId === null) {
      setList(null);
      return;
    }
    refresh(source);
  }, [source, props.sessionId, props.revision, refresh]);

  // 一次性定位：展开目标路径并滚到它（「在面板里看」只发生在改动页签）
  useEffect(() => {
    if (props.focus === null) return;
    setTab("changes");
    setExpanded(props.focus.path);
    const timer = window.setTimeout(() => {
      expandedRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
    // token 每次请求都新——同一路径的第二次点击也能触发展开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.token]);

  const entries = list?.kind === "ok" ? list.entries : [];
  const listCwd = list?.kind === "ok" ? list.cwd : null;
  /** 重名文件补显的父目录（review-panel.ts 纯函数）：无重名的名字不补，行里只显文件名 */
  const disambig = useMemo(
    () => disambiguatedDirs(entries.map((entry) => entry.path), props.cwd),
    [entries, props.cwd],
  );

  /** 右键 → 复制路径：复制的是绝对路径（title 同源），成 / 败都在那一行闪一条轻提示 */
  const copyPath = useCallback(
    (path: string): void => {
      void navigator.clipboard.writeText(absoluteReviewPath(path, source, listCwd)).then(
        () => flashHint(path, t.chat.copied, "ok"),
        (cause: unknown) => {
          console.error("[review] 复制路径失败", cause);
          flashHint(path, String(cause instanceof Error ? cause.message : cause), "bad");
        },
      );
    },
    [source, listCwd, flashHint, t],
  );

  /**
   * 悬停键「在访达中显示」：task 来源走 session:reveal-artifact（白名单 = 本任务文件
   * 账，恰是这张列表的来源，账外的路径一概不碰），不需要找宿主根；git 来源拼绝对
   * 路径后找 fs:roots 白名单内的宿主根走 fs:reveal，拼出来的路径不在任何根内 →
   * 按钮本就不出现。
   */
  const gitRevealTarget = useCallback(
    (path: string): { root: string; dir: string } | null => {
      const dir = absoluteReviewPath(path, source, listCwd);
      const owner = revealRoots?.find((root) => pathWithin(root.path, dir)) ?? null;
      return owner === null ? null : { root: owner.path, dir };
    },
    [source, listCwd, revealRoots],
  );
  const revealEntry = useCallback(
    (path: string): void => {
      if (props.sessionId === null) return;
      if (source === "task") {
        void api.session.revealArtifact(props.sessionId, path).catch((cause: unknown) => {
          console.error("[review] 在访达中显示失败", cause);
          flashHint(path, cause instanceof Error ? cause.message : String(cause), "bad");
        });
        return;
      }
      const target = gitRevealTarget(path);
      if (target === null) return;
      void api.files
        .reveal({ sessionId: props.sessionId, workspaceId: props.workspaceId, root: target.root, dir: target.dir })
        .catch((cause: unknown) => {
          console.error("[review] 在访达中显示失败", cause);
          flashHint(path, cause instanceof Error ? cause.message : String(cause), "bad");
        });
    },
    [source, props.sessionId, props.workspaceId, gitRevealTarget, flashHint],
  );

  const toggle = useCallback((entry: ReviewEntry) => {
    if (entry.binary || entry.restored === true || entry.noBaseline === true) return;
    setExpanded((current) => (current === entry.path ? null : entry.path));
  }, []);

  /**
   * 展开着的文件缺 diff 就去取——点击展开、轮尾卡的定位请求、刷新后清了缓存，
   * 三条路都落到这里（以前只有点击会取，定位过来的会一直停在加载中）。
   */
  useEffect(() => {
    if (expanded === null || props.sessionId === null || diffs.has(expanded)) return;
    const path = expanded;
    let cancelled = false;
    setDiffLoading(path);
    void api.review
      .diff(props.sessionId, source, path)
      .then((result) => {
        if (!cancelled) setDiffs((current) => new Map(current).set(path, result));
      })
      .catch((cause: unknown) => {
        // 失败如实说：以前写成 { diff: null, binary: false }，正文区显示「二进制」
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!cancelled) {
          setDiffs((current) =>
            new Map(current).set(path, { diff: null, binary: false, restored: false, error: { reason: "failed", message } }),
          );
        }
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, diffs, props.sessionId, source]);

  const sourceItems: MenuItem[] = useMemo(
    () =>
      // 回调标注 MenuItem：不标的话 map 先推断字面量类型、再赋给 MenuItem[]，已不是新鲜字面量，
      // 不做多余属性检查——曾把 onSelect 写成 onClick 仍过 typecheck，点了没反应，git 三源切不过去
      REVIEW_SOURCES.map((item): MenuItem => ({
        id: item,
        label: t.review.source(item),
        checked: item === source,
        onSelect: () => {
          setExpanded(null);
          setSource(item);
        },
      })),
    [t, source],
  );

  return (
    <RightPanelFrame
      header={
        <div className="cap-review-head">
          <PanelTitle icon="file-diff" title={t.review.title} className="cap-slot-left" />
          {/* 「改动 / 摘抄」页签组：两个 1fr 轨道等宽 → 构造性落在胶囊中心
              （2026-10-19 两轮复测：grow 对称偏左、绝对居中压下拉，都不对）。
              放不下时轨道压缩，页签组顺排 + 横滚渐隐退化 */}
          <div className="cap-tabs" role="tablist" aria-label={t.review.title}>
            <button type="button" role="tab" className="cap-tab no-drag" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>
              <Icon name="file-diff" size={12} strokeWidth={1.8} />
              {t.review.tabChanges}
            </button>
            <button type="button" role="tab" className="cap-tab no-drag" aria-selected={tab === "excerpts"} onClick={() => setTab("excerpts")}>
              <Icon name="quote" size={12} strokeWidth={1.8} />
              {t.review.tabExcerpts}
            </button>
            {memoryOn && (
              <button type="button" role="tab" className="cap-tab no-drag" aria-selected={tab === "memory"} onClick={() => setTab("memory")}>
                <Icon name="brain-circuit" size={12} strokeWidth={1.8} />
                {t.review.tabMemory}
              </button>
            )}
          </div>
          <div className="cap-slot-right">
            {/* 审查来源（本任务 / 工作区 / 分支）：收成图标键（点开同一个菜单，tooltip
                报当前来源）——宽栏给页签组让出居中空间，窄栏更省；摘抄页签不吃 git
                来源，收起 */}
            {tab === "changes" && (
              <Menu items={sourceItems} trigger={({ toggle: open }) => (
                <button
                  type="button"
                  onClick={open}
                  title={t.review.source(source)}
                  aria-label={t.review.source(source)}
                  className="quiet-control cap-seg solo no-drag"
                >
                  <Icon name="git-branch" size={16} strokeWidth={1.8} />
                </button>
              )} />
            )}
            {tab === "changes" && (
              <PanelIconButton title={t.review.refresh} onClick={() => refresh(source)} disabled={loading}>
                <Icon name="refresh-cw" size={16} strokeWidth={1.8} spin={loading} />
              </PanelIconButton>
            )}
          </div>
        </div>
      }
      contentKey={`${tab}:${source}:${props.sessionId ?? "none"}`}
    >
      <ContextMenu
        position={menu === null ? null : { x: menu.x, y: menu.y }}
        onClose={() => setMenu(null)}
        items={
          menu === null
            ? []
            : [
                {
                  id: "copy-path",
                  label: t.review.copyPath,
                  icon: "copy",
                  onSelect: () => copyPath(menu.path),
                },
              ]
        }
      />
      {tab === "excerpts" ? (
        <ExcerptsTab sessionId={props.sessionId} revision={props.excerptRevision} onJump={props.onJumpExcerpt} />
      ) : tab === "memory" ? (
        <MemoryTab sessionId={props.sessionId} />
      ) : props.sessionId === null ? (
        <EmptyState title={t.review.noTask} />
      ) : loading && list === null ? (
        <EmptyState title={t.common.loading} />
      ) : list === null || (list.kind === "ok" && entries.length === 0) ? (
        <EmptyState title={t.review.emptyNoChanges} detail={t.review.emptyNoChangesDetail(source)} />
      ) : list.kind !== "ok" ? (
        <EmptyState
          title={reviewEmptyTitle(list, t)}
          detail={reviewEmptyText(list, t, source)}
          danger={list.kind === "error"}
        />
      ) : (
        // minmax(0,1fr)：grid 项默认 min-width:auto，长文件名会把行撑出面板、把右端统计挤出视野（实机）
        <div className="panel-list" style={{ paddingTop: "var(--space-2)" }}>
          {source === "branch" && list.upstream !== undefined && (
            <p className="panel-empty" style={{ padding: "0 var(--space-2) var(--space-2)" }}>
              {t.review.againstUpstream(list.upstream)}
            </p>
          )}
          {entries.map((entry) => {
            const open = expanded === entry.path;
            const diff = diffs.get(entry.path);
            // 正文区不是 diff 时说什么（拒绝 / 失败 / 链接 / 已还原 / 二进制）；null = 交给 DiffBody
            const notice = diff === undefined ? null : reviewDiffNotice(diff, t);
            // 符号链接可以展开：正文区说它指向哪（面板不读目标）。二进制 / 已还原没什么可展开的
            const expandable = !entry.binary && entry.restored !== true && entry.noBaseline !== true;
            // 悬停键「在访达中显示」：task 来源必有（白名单 = 本任务文件账）；git 来源
            // 要落在 fs:roots 白名单的某条根内，否则不出现（同附件行「根外只展示」）
            const revealable = source === "task" || gitRevealTarget(entry.path) !== null;
            // title / 复制 / reveal 用的都是绝对路径（absoluteReviewPath，与行里显示的
            // 去路径名字分开算）
            const absolute = absoluteReviewPath(entry.path, source, listCwd);
            const rowHint = hint !== null && hint.path === entry.path ? hint : null;
            return (
              <div key={entry.path} ref={open ? expandedRef : undefined}>
                {/* host 行包住行按钮与悬停动作键（button 不能套 button，同文件面板）；
                    title / 右键挂 host 而不是行按钮：disabled 行（二进制 / 已还原）
                    在浏览器里不发鼠标事件，挂按钮上这些行就右键不了、也没 tooltip */}
                <div
                  className={revealable ? "file-hover-host review-row-actable" : "file-hover-host"}
                  style={{ position: "relative" }}
                  title={absolute}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ x: event.clientX, y: event.clientY, path: entry.path });
                  }}
                >
                  <button
                    type="button"
                    onClick={() => toggle(entry)}
                    aria-expanded={open}
                    disabled={!expandable}
                    className="review-row"
                    style={{ cursor: expandable ? "pointer" : "default" }}
                  >
                    <span
                      style={{
                        color: "var(--color-text-tertiary)",
                        flex: "0 0 auto",
                        transition: "transform var(--duration-fast) var(--ease-out-quint)",
                        transform: open ? "rotate(90deg)" : "none",
                        visibility: expandable ? "visible" : "hidden",
                      }}
                    >
                      <Icon name="chevron-right" size={12} strokeWidth={1.8} />
                    </span>
                    <RowName path={entry.path} cwd={props.cwd} disambig={disambig.get(entry.path) ?? null} />
                    {/* 一次性轻提示与行尾并排（数字不被顶掉），只在触发它的那一行短郎闪现 */}
                    {rowHint !== null && (
                      <span
                        style={{
                          flex: "0 0 auto",
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 4,
                          fontSize: "var(--font-size-sm)",
                          color: rowHint.tone === "ok" ? "var(--color-success)" : "var(--color-danger)",
                        }}
                      >
                        <Icon name={rowHint.tone === "ok" ? "check" : "triangle-alert"} size={11} strokeWidth={2} />
                        {rowHint.text}
                      </span>
                    )}
                    {entry.restored === true ? (
                      <span
                        style={{
                          flex: "0 0 auto",
                          display: "inline-flex",
                          gap: 4,
                          alignItems: "center",
                          padding: "1px var(--space-2)",
                          borderRadius: "var(--radius-pill)",
                          background: "var(--color-bg-muted)",
                          fontSize: "var(--font-size-sm)",
                          color: "var(--color-text-tertiary)",
                        }}
                      >
                        <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
                        {t.review.restored}
                      </span>
                    ) : entry.noBaseline === true ? (
                      <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-sm)", color: "var(--color-text-tertiary)" }}>
                        {t.review.noBaseline}
                      </span>
                    ) : entry.symlink !== undefined ? (
                      // 链接不数行（面板不跟到目标读）：角标与文件面板的符号链接同一个箭头
                      <span
                        style={{
                          flex: "0 0 auto",
                          display: "inline-flex",
                          gap: 4,
                          alignItems: "center",
                          fontSize: "var(--font-size-sm)",
                          color: "var(--color-text-tertiary)",
                        }}
                      >
                        <Icon name="arrow-up-right" size={11} strokeWidth={2} />
                        {t.review.symlink}
                      </span>
                    ) : entry.binary ? (
                      <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-sm)", color: "var(--color-text-tertiary)" }}>
                        {t.review.binary}
                      </span>
                    ) : (
                      <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-sm)" }}>
                        <Stats added={entry.added} removed={entry.removed} />
                      </span>
                    )}
                  </button>
                  {revealable && (
                    <RowHoverAction
                      icon="folder-open"
                      title={t.files.revealInFileManager}
                      onClick={() => revealEntry(entry.path)}
                      right={ROW_ACT_RIGHT}
                      top={ROW_ACT_TOP}
                      size={ROW_ACT_SIZE}
                      iconSize={13}
                      className="file-hover-act review-row-act"
                    />
                  )}
                </div>
                {open && (
                  <div style={{ padding: "0 0 var(--space-2)", display: "grid" }}>
                    {diff === undefined || diffLoading === entry.path ? (
                      <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-tertiary)" }}>
                        {t.common.loading}
                      </span>
                    ) : notice !== null ? (
                      // 拒绝 / 失败用图标 + 文字说（颜色只是第二信号）；英文原句放悬停，排查用
                      <span
                        title={diff.error?.message}
                        style={{
                          display: "flex",
                          gap: 4,
                          alignItems: "flex-start",
                          fontSize: "var(--font-size-sm)",
                          color: notice.tone === "danger" ? "var(--color-danger)" : "var(--color-text-tertiary)",
                          overflowWrap: "anywhere",
                        }}
                      >
                        {notice.tone === "danger" && (
                          // 图标钉在第一行的行高里居中：原因折成两行时不悬在两行中间
                          <span style={{ display: "inline-flex", alignItems: "center", height: "1lh", flex: "0 0 auto" }}>
                            <Icon name="triangle-alert" size={11} strokeWidth={2} />
                          </span>
                        )}
                        <span>{notice.text}</span>
                      </span>
                    ) : (
                      <DiffBody entries={unifiedDiffEntries(diff.diff ?? "")} maxHeight={420} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </RightPanelFrame>
  );
}

/** 文件名（粗）+ 目录（淡、可截断，cwd 之内为相对路径）。截断落在目录上，文件名与统计永远可见。 */
/**
 * 文件名完整优先（粗体；过长截断名字本身，不再在行里铺路径——用户 2026-10-18：
 * 「它不优先显示完整的文件名，反而是去显示文件路径了，这就有点不可理喻了」）；
 * 重名时才用 tertiary 小字补最短区分父目录（disambiguatedDirs 算好，无重名不补）。
 * 悬停看整行 title = 完整路径，右键可复制。
 */
function RowName(props: { path: string; cwd: string | null; disambig: string | null }) {
  const { name } = pathParts(props.path, props.cwd);
  return (
    <span style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: "var(--space-1)", flex: "1 1 auto", overflow: "hidden" }}>
      <span
        style={{
          fontWeight: 600,
          fontSize: "var(--font-size-base)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
          flex: "1 1 auto",
        }}
      >
        {name}
      </span>
      {props.disambig !== null && props.disambig !== "" && (
        <span
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {props.disambig}
        </span>
      )}
    </span>
  );
}

/** 空态 / 提示：一行浅灰字（右栏统一：不居中、不放大图标、不加粗；出错时红字） */
function EmptyState(props: { title: string; detail?: string; danger?: boolean }) {
  return (
    <p
      className="panel-empty"
      role={props.danger === true ? "alert" : undefined}
      style={{ paddingTop: "var(--space-3)", color: props.danger === true ? "var(--color-danger)" : undefined }}
    >
      {props.title}
      {props.detail !== undefined && ` ${props.detail}`}
    </p>
  );
}
