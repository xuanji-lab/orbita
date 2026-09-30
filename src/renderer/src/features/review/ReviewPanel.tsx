import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { PanelIconButton, RightPanelFrame } from "../../shell/RightPanel";
import { DiffBody } from "../../shell/DiffView";
import { useT } from "../../locale.ts";
import { api } from "../../api";
import { REVIEW_SOURCES, type ReviewDiff, type ReviewEntry, type ReviewList, type ReviewSource } from "@shared/review";
import { reviewEmptyText, unifiedDiffEntries } from "./review-panel";

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
  onClose: () => void;
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
      setExpanded(null);
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
  }, [source, props.sessionId, refresh]);

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

  const toggle = useCallback(
    (entry: ReviewEntry) => {
      if (entry.binary || entry.restored === true || entry.noBaseline === true) return;
      setExpanded((current) => (current === entry.path ? null : entry.path));
      if (!diffs.has(entry.path)) {
        setDiffLoading(entry.path);
        void api.review
          .diff(props.sessionId ?? "", source, entry.path)
          .then((result) => setDiffs((current) => new Map(current).set(entry.path, result)))
          .catch(() => setDiffs((current) => new Map(current).set(entry.path, { diff: null, binary: false, restored: false })))
          .finally(() => setDiffLoading(null));
      }
    },
    [diffs, props.sessionId, source],
  );

  const sourceItems: MenuItem[] = useMemo(
    () =>
      REVIEW_SOURCES.map((item) => ({
        id: item,
        label: t.review.source(item),
        checked: item === source,
        onClick: () => setSource(item),
      })),
    [t, source],
  );

  return (
    <RightPanelFrame
      header={
        <>
          <Icon name="file-text" size={14} strokeWidth={1.8} />
          <span style={{ fontWeight: 650, fontSize: "var(--font-size-title)" }}>{t.review.title}</span>
          <Menu items={sourceItems} trigger={({ toggle: open }) => (
            <button
              type="button"
              onClick={open}
              title={t.review.source(source)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 4,
                marginLeft: "var(--space-2)",
                padding: "2px var(--space-2)",
                border: "1px solid var(--color-border-subtle)",
                borderRadius: "var(--radius-sm)",
                background: "transparent",
                color: "var(--color-text-secondary)",
                font: "inherit",
                fontSize: "var(--font-size-caption)",
                cursor: "pointer",
              }}
            >
              {t.review.source(source)}
              <Icon name="chevron-down" size={11} strokeWidth={1.8} />
            </button>
          )} />
        </>
      }
      headerExtra={
        <PanelIconButton title={t.review.refresh} onClick={() => refresh(source)} disabled={loading}>
          <Icon name="refresh-cw" size={14} spin={loading} />
        </PanelIconButton>
      }
      onClose={props.onClose}
      contentKey={`${source}:${props.sessionId ?? "none"}:${loading ? "loading" : "done"}`}
    >
      {props.sessionId === null ? (
        <EmptyLine>{t.review.noTask}</EmptyLine>
      ) : loading ? (
        <EmptyLine>{t.common.loading}</EmptyLine>
      ) : list === null ? (
        <EmptyLine>{t.review.emptyNoChanges}</EmptyLine>
      ) : list.kind !== "ok" ? (
        <EmptyLine>{reviewEmptyText(list, t)}</EmptyLine>
      ) : entries.length === 0 ? (
        <EmptyLine>{t.review.emptyNoChanges}</EmptyLine>
      ) : (
        <div style={{ display: "grid", padding: "var(--space-2) var(--space-3) var(--space-5)" }}>
          {source === "branch" && list.upstream !== undefined && (
            <p style={{ margin: "0 0 var(--space-2)", fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
              {t.review.againstUpstream(list.upstream)}
            </p>
          )}
          {entries.map((entry) => {
            const open = expanded === entry.path;
            const diff = diffs.get(entry.path);
            const expandable = !entry.binary && entry.restored !== true && entry.noBaseline !== true;
            return (
              <div key={entry.path} ref={open ? expandedRef : undefined} style={{ borderBottom: "1px solid var(--color-border-subtle)" }}>
                <button
                  type="button"
                  onClick={() => toggle(entry)}
                  aria-expanded={open}
                  disabled={!expandable}
                  title={entry.path}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "var(--space-2)",
                    width: "100%",
                    padding: "var(--space-2) 0",
                    border: 0,
                    background: "transparent",
                    color: "var(--color-text-primary)",
                    font: "inherit",
                    textAlign: "left",
                    cursor: expandable ? "pointer" : "default",
                  }}
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
                  <span style={{ minWidth: 0, display: "flex", gap: "var(--space-1)", flex: "1 1 auto" }}>
                    <span style={{ fontFamily: "var(--font-family-mono)", fontSize: "var(--font-size-caption)", whiteSpace: "nowrap" }}>
                      {entry.path.split("/").filter(Boolean).pop() ?? entry.path}
                    </span>
                    <span
                      style={{
                        fontFamily: "var(--font-family-mono)",
                        fontSize: "var(--font-size-caption)",
                        color: "var(--color-text-tertiary)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        direction: "rtl",
                        textAlign: "left",
                      }}
                    >
                      {entry.path}
                    </span>
                  </span>
                  {entry.restored === true ? (
                    <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)", display: "inline-flex", gap: 4, alignItems: "center" }}>
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
                    <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-caption)", fontVariantNumeric: "tabular-nums" }}>
                      <span style={{ color: "var(--color-success)" }}>+{entry.added}</span>{" "}
                      <span style={{ color: "var(--color-danger)" }}>−{entry.removed}</span>
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

function EmptyLine(props: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: 0,
        padding: "var(--space-4) var(--space-4)",
        fontSize: "var(--font-size-caption)",
        color: "var(--color-text-tertiary)",
      }}
    >
      {props.children}
    </p>
  );
}
