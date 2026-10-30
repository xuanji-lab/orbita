import { useMemo, useState } from "react";
import {
  MEMORY_USER_TOKEN,
  type MemoryEntryType,
  type MemoryEntryView,
  type MemoryScopeSummary,
} from "@shared/memory";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { MEMORY_TYPE_ICON, MemoryEntryCard } from "./MemoryEntryCard";
import { VectorModelView } from "./VectorModelView";
import {
  filterMemoryEntries,
  groupMemoryEntries,
  manualDraftProblem,
  MEMORY_SOURCE_FILTERS,
  MEMORY_TYPE_ORDER,
  scopeNameOf,
  type MemoryNav,
  type MemorySourceFilter,
  type MemoryTypeFilter,
} from "./memory-view.ts";
import { mutateMemory, useMemoryEntries, useMemoryHistory } from "./useMemory.ts";
import { HistoryImport } from "./HistoryImport";
import { historyActive } from "./history-view.ts";
import "./memory.css";

/**
 * 记忆库（实验功能 memory-system）：和设置同一种整页形态——侧栏换成范围 / 管理导航，
 * 内容面按导航位置画两种页：某个范围的条目、向量模型。没有「待你确认」页（2026-10-29
 * 用户：「我不想去确认记忆」）——agent 判断的结果直接生效，撤销在各条目卡上。
 * 不是 Markdown 文件视图（2026-10-29 用户裁决：不要 Proma 那种）。
 */
export function MemoryLibraryView(props: {
  nav: MemoryNav;
  onNav: (next: MemoryNav) => void;
  scopes: readonly MemoryScopeSummary[] | null;
  /** 「回到原文」：退出记忆库、打开出处会话并滚到那一轮 */
  onJump: (view: MemoryEntryView) => void;
  /** 家务活模型的显示名；null = 没设置（向量模型页底部那一行） */
  choreLabel: string | null;
  onOpenGeneral: () => void;
}) {
  return (
    <div className="scroll" style={{ height: "100%", minHeight: 0, padding: "var(--space-6) var(--space-5)" }}>
      <div className="mem-page">
        {props.nav.kind === "vector" ? (
          <VectorModelView choreLabel={props.choreLabel} onOpenGeneral={props.onOpenGeneral} />
        ) : (
          <ScopePage token={props.nav.token} scopes={props.scopes} onJump={props.onJump} />
        )}
      </div>
    </div>
  );
}

function ScopePage(props: {
  token: string;
  scopes: readonly MemoryScopeSummary[] | null;
  onJump: (view: MemoryEntryView) => void;
}) {
  const t = useT();
  const entries = useMemoryEntries(props.token);
  const [type, setType] = useState<MemoryTypeFilter>("all");
  const [source, setSource] = useState<MemorySourceFilter>("all");
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const history = useMemoryHistory(true);
  const all = props.token === "all";
  const scope = all ? null : (props.scopes?.find((item) => item.token === props.token) ?? null);
  const items = entries.data?.items ?? null;
  const shown = useMemo(
    () => (items === null ? [] : filterMemoryEntries(items, { type, source, query })),
    [items, type, source, query],
  );
  const groups = groupMemoryEntries(shown);

  return (
    <>
      <header className="mem-page-head">
        <h2 className="mem-page-title">
          {scope === null ? t.memory.allTitle : scopeNameOf(props.scopes, scope.token, t.memory.scopeUser)}
        </h2>
        <span className="mem-page-hint">{t.memory.pageHint}</span>
        <span className="row-trailing mem-edit-row">
          <button
            type="button"
            className="mem-btn"
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((value) => !value)}
          >
            <Icon name="history" size={12} strokeWidth={1.8} />
            {t.memory.historyOpen}
          </button>
          <button type="button" className="mem-btn" onClick={() => setAdding((value) => !value)}>
            <Icon name="plus" size={12} strokeWidth={1.8} />
            {t.memory.add}
          </button>
        </span>
      </header>

      {(historyOpen || historyActive(history)) && (
        <HistoryImport token={props.token} status={history} onClose={() => setHistoryOpen(false)} />
      )}

      {adding && (
        <ManualForm
          token={all ? MEMORY_USER_TOKEN : props.token}
          scopeName={all ? t.memory.scopeUser : scopeNameOf(props.scopes, props.token, t.memory.scopeUser)}
          onDone={() => setAdding(false)}
        />
      )}

      <div className="mem-tools">
        <label className="mem-search">
          <Icon name="search" size={12} strokeWidth={1.8} />
          <input
            value={query}
            placeholder={t.memory.search}
            aria-label={t.memory.search}
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
            <button type="button" className="mem-icon-btn" aria-label={t.memory.clearSearch} onClick={() => setQuery("")}>
              <Icon name="x" size={11} strokeWidth={1.8} />
            </button>
          )}
        </label>
        <div className="mem-seg" role="group" aria-label={t.memory.title}>
          <button type="button" aria-pressed={type === "all"} onClick={() => setType("all")}>
            {t.memory.filterAll}
          </button>
          {MEMORY_TYPE_ORDER.map((each) => (
            <button key={each} type="button" aria-pressed={type === each} onClick={() => setType(each)}>
              <Icon name={MEMORY_TYPE_ICON[each]} size={12} strokeWidth={1.8} />
              {t.memory.typeName(each)}
            </button>
          ))}
        </div>
        <div className="mem-seg" role="group" aria-label={t.memory.sourceAll}>
          {MEMORY_SOURCE_FILTERS.map((each) => (
            <button key={each} type="button" aria-pressed={source === each} onClick={() => setSource(each)}>
              {each === "all" ? t.memory.sourceAll : t.memory.sourceName(each)}
            </button>
          ))}
        </div>
      </div>

      {entries.error !== null && items === null ? (
        <div className="mem-empty" role="alert">
          <span>{t.memory.loadFailed}</span>
          <button type="button" className="mem-btn" onClick={entries.reload}>
            {t.memory.retry}
          </button>
        </div>
      ) : items === null ? (
        <p className="mem-empty">{t.common.loading}</p>
      ) : shown.length === 0 ? (
        <div className="mem-empty">
          <Icon name="brain-circuit" size={16} strokeWidth={1.6} />
          <span>{items.length === 0 ? t.memory.empty : t.memory.noMatch}</span>
          {items.length === 0 && <span className="hint">{t.memory.emptyHint}</span>}
        </div>
      ) : (
        groups.map((group) => (
          <section key={group.type} className="mem-group">
            <header className="mem-group-head">
              <Icon name={MEMORY_TYPE_ICON[group.type]} size={14} strokeWidth={1.8} />
              <span className="mem-group-title">{t.memory.typeName(group.type)}</span>
              <span className="mem-group-hint">{t.memory.typeHint(group.type)}</span>
              <span className="mem-group-count row-trailing">{group.items.length}</span>
            </header>
            <ul className="mem-list">
              {group.items.map((view) => (
                <MemoryEntryCard
                  key={view.entry.id}
                  view={view}
                  scopeName={all ? scopeNameOf(props.scopes, view.token, t.memory.scopeUser) : null}
                  showOrigin
                  onJump={props.onJump}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  );
}

/** 手动添加：类型 + 一句话 + 理由（偏好 / 经验必填）。落在当前范围；「全部」下落在所有工作区层。 */
function ManualForm(props: { token: string; scopeName: string; onDone: () => void }) {
  const t = useT();
  const [type, setType] = useState<MemoryEntryType>("preference");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const submit = async (): Promise<void> => {
    const missing = manualDraftProblem({ type, text, reason });
    if (missing !== null) {
      setProblem(missing === "text" ? t.memory.manualTextMissing : t.memory.manualReasonMissing);
      return;
    }
    setBusy(true);
    setProblem(null);
    const outcome = await mutateMemory({
      op: "addManual",
      token: props.token,
      type,
      text: text.trim(),
      ...(reason.trim() !== "" ? { reason: reason.trim() } : {}),
    });
    setBusy(false);
    if (!outcome.ok) {
      setProblem(t.memory.failed(outcome.error));
      return;
    }
    props.onDone();
  };
  return (
    <div className="mem-form">
      <span className="mem-form-title">{t.memory.manualTitle}</span>
      <div className="mem-seg" role="group" aria-label={t.memory.manualTitle}>
        {MEMORY_TYPE_ORDER.map((each) => (
          <button key={each} type="button" aria-pressed={type === each} onClick={() => setType(each)}>
            <Icon name={MEMORY_TYPE_ICON[each]} size={12} strokeWidth={1.8} />
            {t.memory.typeOne(each)}
          </button>
        ))}
      </div>
      <textarea
        className="mem-edit"
        value={text}
        placeholder={t.memory.manualText}
        aria-label={t.memory.manualText}
        autoFocus
        onChange={(event) => setText(event.target.value)}
      />
      <input
        className="mem-input"
        value={reason}
        placeholder={type === "fact" ? t.memory.manualReasonOptional : t.memory.manualReason(type)}
        aria-label={type === "fact" ? t.memory.manualReasonOptional : t.memory.manualReason(type)}
        onChange={(event) => setReason(event.target.value)}
      />
      <span className="mem-edit-row">
        <span className="mem-page-hint">
          {t.memory.manualScope}
          {" "}
          {props.scopeName}
        </span>
        <span className="row-trailing mem-edit-row">
          <button type="button" className="mem-btn quiet" onClick={props.onDone}>
            {t.memory.cancel}
          </button>
          <button type="button" className="mem-btn primary" disabled={busy} onClick={() => void submit()}>
            {busy && <Icon name="loader-circle" size={12} spin />}
            {t.memory.save}
          </button>
        </span>
      </span>
      {problem !== null && <p className="mem-error">{problem}</p>}
    </div>
  );
}
