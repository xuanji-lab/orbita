import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ExcerptItem } from "@shared/excerpt";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { formatDay } from "../settings/migration-groups.ts";
import { filterExcerpts, type ExcerptMode } from "./excerpt-filter.ts";
import {
  isClipped,
  readExpandedExcerpts,
  showToggle,
  toggleExpanded,
  writeExpandedExcerpts,
} from "./excerpt-expand.ts";
import "./excerpts-tab.css";

/** 跳回摘抄原文的请求：打开那条会话、滚到那一轮那段话（App 消费）。 */
export interface ExcerptJump {
  sessionId: string;
  turn?: number;
  role: "user" | "assistant";
  text: string;
}

/**
 * 审查面板 ›「摘抄」页签：用户在对话里划选存下的段落。
 *
 * - 顶部两档「本任务 / 全部」+ 搜索（正文与出处任务标题，纯前端过滤——量小，一次拉全）。
 * - 点一条回到原文：别的任务先切过去，等转录加载到那一轮再滚到并闪一下（App + ChatView
 *   消费）。不在正文里常驻高亮——跳转时闪一下就够（用户裁决）。
 * - 删除两段式，第二段是带文字的「确认删除」，不能只靠变色。
 * - 出处任务被删时那条摘抄仍保留（摘下的话本身有价值），只是不能跳转。
 * - 正文默认三行截断，被截断的条目多一个独立的「展开 / 收起」键（ExcerptBody 量
 *   scrollHeight 判断有没有藏内容）；展开状态按摘抄 id 记在模块级单例里，切页签 /
 *   切面板 / 切会话回来都还在，重启即失，不落盘。
 */
export function ExcerptsTab(props: {
  /** 正在看的任务；null = 还没开任务（「本任务」档为空，「全部」照常） */
  sessionId: string | null;
  /** 变了就重拉：刚摘了一条、面板重新打开等（App 维护的计数） */
  revision: number;
  onJump: (jump: ExcerptJump) => void;
}) {
  const t = useT();
  /** 日期格式只看「今年还是往年」，取一次钉住 */
  const [now] = useState(() => Date.now());
  const [mode, setMode] = useState<ExcerptMode>(props.sessionId === null ? "all" : "session");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ExcerptItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  /** 展开着的摘抄 id（本次运行内记忆，见 excerpt-expand.ts；初始化自模块单例） */
  const [expandedIds, setExpandedIds] = useState<ReadonlySet<string>>(() => readExpandedExcerpts());

  const toggleExcerpt = useCallback((id: string): void => {
    // 模块单例是真源（setExpandedIds 只作镜像）：updater 里写副作用在 StrictMode 下会双调
    const next = toggleExpanded(readExpandedExcerpts(), id);
    writeExpandedExcerpts(next);
    setExpandedIds(next);
  }, []);

  const load = useCallback(() => {
    setFailed(false);
    void api.excerpt
      .list()
      .then((result) => setItems(result.items))
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    load();
  }, [load, props.revision]);

  const shown = useMemo(
    () => (items === null ? [] : filterExcerpts(items, mode, props.sessionId, query)),
    [items, mode, props.sessionId, query],
  );

  const remove = (id: string): void => {
    setRemoving(id);
    void api.excerpt
      .remove({ id })
      .then(
        () => {
          // 删掉的那条直接从列表消失（removed=false 是幂等语义，同样当作已删）
          setItems((current) => (current === null ? current : current.filter((item) => item.excerpt.id !== id)));
          setConfirming(null);
        },
        () => load(),
      )
      .finally(() => setRemoving(null));
  };

  const emptyText =
    items !== null && items.length === 0
      ? t.review.excerptsEmpty
      : query.trim() !== ""
        ? t.review.excerptsNoMatch
        : t.review.excerptsEmptyTask;

  return (
    <div className="excerpts">
      <div className="excerpts-tools">
        <div className="excerpts-seg" role="group" aria-label={t.review.tabExcerpts}>
          <button
            type="button"
            aria-pressed={mode === "session"}
            disabled={props.sessionId === null}
            onClick={() => setMode("session")}
          >
            {t.review.excerptsThisTask}
          </button>
          <button type="button" aria-pressed={mode === "all"} onClick={() => setMode("all")}>
            {t.review.excerptsAll}
          </button>
        </div>
        <label className="excerpts-search">
          <Icon name="search" size={12} strokeWidth={1.8} />
          <input
            value={query}
            placeholder={t.review.excerptsSearch}
            aria-label={t.review.excerptsSearch}
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query !== "") {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
          {query !== "" && (
            <button type="button" className="excerpts-clear" aria-label={t.review.excerptCancel} onClick={() => setQuery("")}>
              <Icon name="x" size={11} strokeWidth={1.8} />
            </button>
          )}
        </label>
      </div>

      {failed ? (
        <p className="panel-empty excerpts-empty" role="alert">
          {t.review.excerptsFailed}
        </p>
      ) : items === null ? (
        <p className="panel-empty excerpts-empty">{t.common.loading}</p>
      ) : shown.length === 0 ? (
        <div className="panel-empty excerpts-empty">
          <Icon name="quote" size={16} strokeWidth={1.6} />
          <span>{emptyText}</span>
          {items.length === 0 && <span className="excerpts-hint">{t.review.excerptsEmptyHint}</span>}
        </div>
      ) : (
        <ul className="excerpts-list">
          {shown.map((item) => {
            const { excerpt, sessionTitle } = item;
            const confirmingThis = confirming === excerpt.id;
            const jumpable = sessionTitle !== null;
            const jump = (): void => {
              if (!jumpable) return;
              props.onJump({
                sessionId: excerpt.sessionId,
                role: excerpt.role,
                text: excerpt.text,
                ...(excerpt.turn !== undefined ? { turn: excerpt.turn } : {}),
              });
            };
            return (
              <li key={excerpt.id} className="excerpts-row" data-confirming={confirmingThis || undefined}>
                <ExcerptBody
                  id={excerpt.id}
                  text={excerpt.text}
                  jumpTitle={jumpable ? t.review.excerptJump : undefined}
                  jumpDisabled={!jumpable}
                  expanded={expandedIds.has(excerpt.id)}
                  onToggle={toggleExcerpt}
                  onJump={jump}
                  expandLabel={t.review.excerptExpand}
                  collapseLabel={t.review.excerptCollapse}
                />
                <span className="excerpts-meta">
                  <span>{excerpt.role === "user" ? t.review.excerptMine : t.review.excerptAgent}</span>
                  <span aria-hidden="true">·</span>
                  {jumpable ? (
                    <span className="excerpts-origin" title={sessionTitle}>
                      {t.review.excerptOrigin(sessionTitle, excerpt.turn)}
                    </span>
                  ) : (
                    <span className="excerpts-origin gone">{t.review.excerptOriginDeleted}</span>
                  )}
                  <span aria-hidden="true">·</span>
                  <span className="mono">{formatDay(excerpt.createdAt, now)}</span>
                  <span className="excerpts-acts">
                    {confirmingThis ? (
                      <>
                        <button
                          type="button"
                          className="excerpts-btn danger"
                          disabled={removing === excerpt.id}
                          onClick={() => remove(excerpt.id)}
                        >
                          {removing === excerpt.id ? <Icon name="loader-circle" size={12} spin /> : null}
                          {t.review.excerptConfirmDelete}
                        </button>
                        <button type="button" className="excerpts-btn" onClick={() => setConfirming(null)}>
                          {t.review.excerptCancel}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="excerpts-icon"
                        title={t.review.excerptDelete}
                        aria-label={t.review.excerptDelete}
                        onClick={() => setConfirming(excerpt.id)}
                      >
                        <Icon name="trash-2" size={12} strokeWidth={1.8} />
                      </button>
                    )}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * 摘抄正文：整段仍是「回到原文」的按钮；被截断时下方多一个独立的「展开 / 收起」键。
 *
 * 是否截断只在收起态量（展开态 scrollHeight == clientHeight，量了必是 false）：
 * line-clamp 元素的 scrollHeight 不受封顶影响（Menu.tsx 量自然高度同款）。窗口 /
 * 右栏拖宽变窄会改行数，ResizeObserver 盯着元素尺寸重算；展开过的条目靠 expanded
 * 兜底留键（否则收不回去），重新收起后置测。短摘抄从未截断，全程不出键。
 */
function ExcerptBody(props: {
  id: string;
  text: string;
  jumpTitle: string | undefined;
  jumpDisabled: boolean;
  expanded: boolean;
  onToggle: (id: string) => void;
  onJump: () => void;
  expandLabel: string;
  collapseLabel: string;
}) {
  const textRef = useRef<HTMLButtonElement | null>(null);
  const [clipped, setClipped] = useState(false);
  const expanded = props.expanded;

  useLayoutEffect(() => {
    const el = textRef.current;
    if (el === null || expanded) return;
    const measure = (): void => setClipped(isClipped(el.scrollHeight, el.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, props.text]);

  return (
    <>
      <button
        ref={textRef}
        type="button"
        className="excerpts-text"
        data-expanded={expanded || undefined}
        title={props.jumpTitle}
        disabled={props.jumpDisabled}
        onClick={props.onJump}
      >
        {props.text}
      </button>
      {showToggle(clipped, expanded) && (
        <button
          type="button"
          className="excerpts-toggle"
          aria-expanded={expanded}
          onClick={() => props.onToggle(props.id)}
        >
          <Icon name="chevron-down" size={11} strokeWidth={1.8} />
          {expanded ? props.collapseLabel : props.expandLabel}
        </button>
      )}
    </>
  );
}
