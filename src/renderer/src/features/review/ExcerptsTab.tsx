import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExcerptItem } from "@shared/excerpt";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { formatDay } from "../settings/migration-groups.ts";
import { filterExcerpts, type ExcerptMode } from "./excerpt-filter.ts";
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
                <button
                  type="button"
                  className="excerpts-text"
                  title={jumpable ? t.review.excerptJump : undefined}
                  disabled={!jumpable}
                  onClick={jump}
                >
                  {excerpt.text}
                </button>
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
