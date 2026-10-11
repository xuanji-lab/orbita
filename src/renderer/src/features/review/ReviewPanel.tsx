import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { PanelIconButton, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { DiffBody } from "../../shell/DiffView";
import { useT } from "../../locale.ts";
import { api } from "../../api";
import { REVIEW_SOURCES, type ReviewDiff, type ReviewEntry, type ReviewList, type ReviewSource } from "@shared/review";
import { reviewEmptyText, reviewEmptyTitle, unifiedDiffEntries } from "./review-panel";
import { pathParts, Stats } from "../chat/FileTurnCard";

/**
 * 审查面板（右栏新入口，与 Files / Skills / MCP 互斥）：四种来源——本任务改动
 * （默认，不依赖 git）、未暂存 / 已暂存 / 分支对比（git 只读）。列表行点击原地
 * 展开 diff；DiffBody 与聊天内 edit 的展开同一套视觉（行号列 + 整行 soft 底色 +
 * 词级高亮）。
 *
 * 数据全在主进程算（review:list / review:diff）；renderer 只收结果——git 的存在、
 * 仓库与否、upstream 与否都翻译成空态一句话（refusals explain the blocker）。
 */
export function ReviewPanel(props: {
  /** 正在看的会话；null = 还没开任务（task 来源没对象，git 来源也没 cwd） */
  sessionId: string | null;
  /** 轮尾卡 / 界碑卡的「在面板里看」请求：带 token 的一次性定位（展开 + 滚到） */
  focus: { path: string; token: number } | null;
  /**
   * 会话文件账的版本（轮尾账 / 回退 / 撤销的条数拼成的串）：变了就重拉当前来源。
   * 不接它的话，面板开着时 agent 又改了一轮文件，列表停在旧状态（实测）。
   */
  revision: string;
  /** 会话 cwd：cwd 之内显示相对路径 */
  cwd: string | null;
}) {
  const t = useT();
  const [source, setSource] = useState<ReviewSource>("task");
  const [list, setList] = useState<ReviewList | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Map<string, ReviewDiff>>(new Map());
  const [diffLoading, setDiffLoading] = useState<string | null>(null);
  const expandedRef = useRef<HTMLDivElement | null>(null);

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

  // 一次性定位：展开目标路径并滚到它
  useEffect(() => {
    if (props.focus === null) return;
    setExpanded(props.focus.path);
    const timer = window.setTimeout(() => {
      expandedRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 80);
    return () => window.clearTimeout(timer);
    // token 每次请求都新——同一路径的第二次点击也能触发展开
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.token]);

  const entries = list?.kind === "ok" ? list.entries : [];

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
      .catch(() => {
        if (!cancelled) setDiffs((current) => new Map(current).set(path, { diff: null, binary: false, restored: false }));
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
        <>
          <PanelTitle icon="file-diff" title={t.review.title} />
          {/* 审查范围（本任务 / 工作区未提交 / 分支）：标题行中段的安静下拉（右栏统一） */}
          <Menu items={sourceItems} trigger={({ toggle: open }) => (
            <button type="button" onClick={open} title={t.review.source(source)} className="quiet-control panel-head-select no-drag">
              {t.review.source(source)}
              <Icon name="chevron-down" size={11} strokeWidth={1.8} />
            </button>
          )} />
        </>
      }
      headerExtra={
        <PanelIconButton title={t.review.refresh} onClick={() => refresh(source)} disabled={loading}>
          <Icon name="refresh-cw" size={15} spin={loading} />
        </PanelIconButton>
      }
      contentKey={`${source}:${props.sessionId ?? "none"}`}
    >
      {props.sessionId === null ? (
        <EmptyState title={t.review.noTask} />
      ) : loading && list === null ? (
        <EmptyState title={t.common.loading} />
      ) : list === null || (list.kind === "ok" && entries.length === 0) ? (
        <EmptyState title={t.review.emptyNoChanges} detail={t.review.emptyNoChangesDetail(source)} />
      ) : list.kind !== "ok" ? (
        <EmptyState
          title={reviewEmptyTitle(list, t)}
          detail={reviewEmptyText(list, t)}
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
            const expandable = !entry.binary && entry.restored !== true && entry.noBaseline !== true;
            return (
              <div key={entry.path} ref={open ? expandedRef : undefined}>
                <button
                  type="button"
                  onClick={() => toggle(entry)}
                  aria-expanded={open}
                  disabled={!expandable}
                  title={entry.path}
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
                  <RowName path={entry.path} cwd={props.cwd} />
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
                        fontSize: "var(--font-size-caption)",
                        color: "var(--color-text-tertiary)",
                      }}
                    >
                      <Icon name="rotate-ccw" size={11} strokeWidth={1.8} />
                      {t.review.restored}
                    </span>
                  ) : entry.noBaseline === true ? (
                    <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
                      {t.review.noBaseline}
                    </span>
                  ) : entry.binary ? (
                    <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
                      {t.review.binary}
                    </span>
                  ) : (
                    <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-caption)" }}>
                      <Stats added={entry.added} removed={entry.removed} />
                    </span>
                  )}
                </button>
                {open && (
                  <div style={{ padding: "0 0 var(--space-2)", display: "grid" }}>
                    {diff === undefined || diffLoading === entry.path ? (
                      <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
                        {t.common.loading}
                      </span>
                    ) : diff.diff === null ? (
                      <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
                        {diff.restored ? t.review.restoredEmpty : t.review.binary}
                      </span>
                    ) : (
                      <DiffBody entries={unifiedDiffEntries(diff.diff)} maxHeight={420} />
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
function RowName(props: { path: string; cwd: string | null }) {
  const { name, dir } = pathParts(props.path, props.cwd);
  return (
    <span style={{ minWidth: 0, display: "flex", alignItems: "baseline", gap: "var(--space-1)", flex: "1 1 auto", overflow: "hidden" }}>
      <span
        style={{
          fontWeight: 600,
          fontSize: "var(--font-size-body)",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          minWidth: 0,
          flex: "0 1 auto",
        }}
      >
        {name}
      </span>
      {dir !== "" && (
        <span
          style={{
            minWidth: 0,
            fontSize: "var(--font-size-caption)",
            color: "var(--color-text-tertiary)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {dir}
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
