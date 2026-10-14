import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import type {
  MemoryConflictResolution,
  MemoryExcerptItem,
  MemorySessionTurnsResponse,
  MemoryStance,
} from "@shared/memory";
import { formatDay } from "../settings/migration-groups.ts";
import { filterExcerpts, type ExcerptMode } from "./excerpt-filter.ts";
import type { MemoryOriginJump } from "../settings/MemorySettings";

/**
 * 审查面板 › 记忆页签：这条会话每一轮「注入了什么、蒸出了什么」，倒序。
 * 冲突卡就地拍板（新的替换旧的 / 两条都留 / 丢掉新的），replace / keep-both
 * 处理完给一行可撤销的回执。任何写操作后整页重拉——账本是唯一真源。
 */
export function ReviewMemoryTab(props: {
  sessionId: string;
  /** 变了就重拉（轮落定 / 面板刷新） */
  revision: string;
  /** 「去记忆库」：打开设置 › 记忆（可带上作用域 token 直达那个作用域） */
  onOpenLibrary: (token?: string) => void;
}) {
  const t = useT();
  const [now] = useState(() => Date.now());
  const [data, setData] = useState<MemorySessionTurnsResponse | null>(null);
  const [failed, setFailed] = useState(false);
  /** 刚拍板的冲突（撤销行挂在那轮）；resolution 记得当初选了什么 */
  const [justResolved, setJustResolved] = useState<{ newId: string; oldId: string; resolution: MemoryConflictResolution } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    void api.memory
      .sessionTurns(props.sessionId)
      .then((result) => {
        setData(result);
        setJustResolved(null);
      })
      .catch(() => setFailed(true));
  }, [props.sessionId]);

  useEffect(() => {
    load();
  }, [load, props.revision]);

  /** 记忆条目的改动（撤一条新增 / 不再注入）落完重拉。 */
  const mutate = (action: () => Promise<unknown>, after?: () => void): void => {
    setBusy(true);
    void action()
      .then(() => {
        after?.();
        load();
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  if (failed) {
    return (
      <p className="panel-empty" role="alert" style={{ paddingTop: "var(--space-3)" }}>
        {t.memoryPanel.loadFailed}
      </p>
    );
  }
  if (data === null) {
    return (
      <p className="panel-empty" style={{ paddingTop: "var(--space-3)" }}>
        {t.common.loading}
      </p>
    );
  }
  if (data.turns.length === 0) {
    return (
      <p className="panel-empty" style={{ paddingTop: "var(--space-3)" }}>
        {t.memoryPanel.emptyTurns}
        <span className="memtab-empty-hint">{t.memoryPanel.emptyTurnsHint}</span>
      </p>
    );
  }
  return (
    <div className="memtab">
      {data.turns.map((turn) => (
        <section key={turn.turn} className="memtab-turn">
          <header className="memtab-turn-head">
            <b>{t.memoryPanel.turnLabel(turn.turn)}</b>
            <span className="mono">{formatDay(turn.at, now)}</span>
            <span className="memtab-rule" />
          </header>
          {turn.added
            .filter((added) => added.conflictWith !== null)
            .map((added) => (
              <ConflictCard
                key={added.entry.id}
                fresh={added.entry}
                old={added.conflictWith}
                busy={busy}
                resolved={justResolved?.newId === added.entry.id ? justResolved : null}
                onPick={(resolution) =>
                  mutate(
                    () =>
                      api.memory.resolve({
                        token: data.scopeToken,
                        newId: added.entry.id,
                        oldId: added.conflictWith?.id ?? "",
                        resolution,
                      }),
                    () => setJustResolved({ newId: added.entry.id, oldId: added.conflictWith?.id ?? "", resolution }),
                  )
                }
                onUndo={() =>
                  justResolved !== null &&
                  mutate(() =>
                    api.memory.resolve({
                      token: data.scopeToken,
                      newId: justResolved.newId,
                      oldId: justResolved.oldId,
                      resolution: justResolved.resolution,
                      undo: true,
                    }),
                  )
                }
              />
            ))}
          {turn.added
            .filter((added) => added.conflictWith === null)
            .map((added) => (
              <AddedEntry
                key={added.entry.id}
                entry={added.entry}
                busy={busy}
                now={now}
                onUndo={() =>
                  mutate(() => api.memory.removeBatch({ token: data.scopeToken, entryIds: [added.entry.id] }))
                }
                onEdit={(text) =>
                  mutate(() => api.memory.patch({ token: data.scopeToken, entryId: added.entry.id, text }))
                }
                onOpenLibrary={() => props.onOpenLibrary(data.scopeToken)}
              />
            ))}
          {turn.added.length === 0 && <p className="memtab-none">{t.memoryPanel.nothingAdded}</p>}
          <InjectedBlock
            injected={turn.injected}
            now={now}
            busy={busy}
            onMute={(id, token) => mutate(() => api.memory.patch({ token, entryId: id, status: "muted" }))}
            onOpenLibrary={props.onOpenLibrary}
          />
        </section>
      ))}
    </div>
  );
}

function ConflictCard(props: {
  fresh: { id: string; text: string; timestamp: number };
  old: { id: string; text: string; timestamp: number } | null;
  busy: boolean;
  resolved: { resolution: MemoryConflictResolution } | null;
  onPick: (resolution: MemoryConflictResolution) => void;
  onUndo: () => void;
}) {
  const t = useT();
  const [now] = useState(() => Date.now());
  if (props.old === null) return null;
  return (
    <div className="memtab-conflict">
      <div className="memtab-conflict-head">
        <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
        {t.memoryPanel.conflictTitle}
      </div>
      <s className="memtab-conflict-old">
        {props.old.text}
        <span className="mono memtab-conflict-day">{formatDay(props.old.timestamp, now)}</span>
      </s>
      <p className="memtab-conflict-new">{props.fresh.text}</p>
      {props.resolved === null ? (
        <div className="memtab-conflict-acts">
          <button type="button" className="mem-btn accent" disabled={props.busy} onClick={() => props.onPick("replace")}>
            <Icon name="check" size={12} strokeWidth={1.8} />
            {t.memoryLib.resolveReplace}
          </button>
          <button type="button" className="mem-btn" disabled={props.busy} onClick={() => props.onPick("keep-both")}>
            {t.memoryLib.resolveKeepBoth}
          </button>
          <button type="button" className="mem-btn danger" disabled={props.busy} onClick={() => props.onPick("drop-new")}>
            {t.memoryLib.resolveDropNew}
          </button>
        </div>
      ) : (
        <div className="memtab-conflict-resolved">
          <span>
            {props.resolved.resolution === "drop-new" ? t.memoryPanel.droppedNote : t.memoryPanel.resolvedNote}
          </span>
          {props.resolved.resolution !== "drop-new" && (
            <button type="button" className="mem-btn text" disabled={props.busy} onClick={props.onUndo}>
              <Icon name="undo-2" size={12} strokeWidth={1.8} />
              {t.memoryPanel.undoResolve}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function AddedEntry(props: {
  entry: { id: string; text: string; keywords: readonly string[]; timestamp: number; turn?: number };
  busy: boolean;
  now: number;
  onUndo: () => void;
  onEdit: (text: string) => void;
  onOpenLibrary: () => void;
}) {
  const t = useT();
  const [editing, setEditing] = useState<string | null>(null);
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (editing !== null) editRef.current?.focus();
  }, [editing !== null]);
  return (
    <div className="memtab-row">
      <span className="memtab-row-icon add">
        <Icon name="plus" size={12} strokeWidth={1.8} />
      </span>
      <div className="memtab-row-cell">
        {editing !== null ? (
          <span className="memlib-edit">
            <textarea
              ref={editRef}
              value={editing}
              rows={Math.min(4, Math.ceil(editing.length / 36))}
              onChange={(event) => setEditing(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setEditing(null);
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  props.onEdit(editing);
                  setEditing(null);
                }
              }}
            />
            <span className="memlib-edit-acts">
              <button
                type="button"
                className="mem-btn accent"
                disabled={props.busy || editing.trim() === ""}
                onClick={() => {
                  props.onEdit(editing);
                  setEditing(null);
                }}
              >
                {t.memoryLib.manualSave}
              </button>
              <button type="button" className="mem-btn text" onClick={() => setEditing(null)}>
                {t.memoryLib.actCancel}
              </button>
            </span>
          </span>
        ) : (
          <p className="memtab-row-text">{props.entry.text}</p>
        )}
        <span className="memtab-row-meta">
          {t.memoryPanel.added}
          {props.entry.keywords.length > 0 &&
            ` · ${t.memoryPanel.keywords} ${[...new Set(props.entry.keywords)].slice(0, 4).join("、")}`}
          <span className="mono">{formatDay(props.entry.timestamp, props.now)}</span>
        </span>
      </div>
      {editing === null && (
        <span className="memtab-row-acts">
          <button type="button" className="ib memlib-ib" title={t.memoryLib.actEdit} aria-label={t.memoryLib.actEdit} disabled={props.busy} onClick={() => setEditing(props.entry.text)}>
            <Icon name="pencil-line" size={12} strokeWidth={1.8} />
          </button>
          <button type="button" className="ib memlib-ib danger" title={t.memoryPanel.undoResolve} aria-label={t.memoryPanel.undoResolve} disabled={props.busy} onClick={props.onUndo}>
            <Icon name="undo-2" size={12} strokeWidth={1.8} />
          </button>
          <button type="button" className="ib memlib-ib" title={t.memoryPanel.gotoLibrary} aria-label={t.memoryPanel.gotoLibrary} disabled={props.busy} onClick={props.onOpenLibrary}>
            <Icon name="external-link" size={12} strokeWidth={1.8} />
          </button>
        </span>
      )}
    </div>
  );
}

function InjectedBlock(props: {
  injected: readonly { id: string; text: string; timestamp: number; score: number; pinned: boolean; token: string }[];
  now: number;
  busy: boolean;
  onMute: (id: string, token: string) => void;
  onOpenLibrary: (token?: string) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (props.injected.length === 0) {
    return (
      <details className="memtab-injected">
        <summary>
          <Icon name="history" size={12} strokeWidth={1.8} />
          {t.memoryPanel.injectedNone}
        </summary>
      </details>
    );
  }
  return (
    <details className="memtab-injected" open={open} onToggle={(event) => setOpen((event.target as HTMLDetailsElement).open)}>
      <summary>
        <span className="memtab-chevron">
          <Icon name="chevron-right" size={12} strokeWidth={1.8} />
        </span>
        <Icon name="history" size={12} strokeWidth={1.8} />
        {t.memoryPanel.injected(props.injected.length)}
      </summary>
      {props.injected.map((item) => (
        <div className="memtab-row muted" key={item.id}>
          <span className="memtab-row-icon used">
            <Icon name="arrow-right" size={12} strokeWidth={1.8} />
          </span>
          <div className="memtab-row-cell">
            <p className="memtab-row-text">{item.text}</p>
            <span className="memtab-row-meta">
              {item.pinned ? (
                <>
                  <Icon name="pin" size={11} strokeWidth={1.8} />
                  {t.memoryPanel.pinnedNote}
                </>
              ) : (
                <>
                  <span className="mono">{formatDay(item.timestamp, props.now)}</span>
                  {t.memoryPanel.score(item.score)}
                </>
              )}
            </span>
          </div>
          <span className="memtab-row-acts">
            <button
              type="button"
              className="ib memlib-ib"
              title={t.memoryPanel.gotoLibrary}
              aria-label={t.memoryPanel.gotoLibrary}
              disabled={props.busy}
              onClick={() => props.onOpenLibrary(item.token)}
            >
              <Icon name="external-link" size={12} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="ib memlib-ib danger"
              title={t.memoryPanel.muteHint}
              aria-label={t.memoryPanel.muteHint}
              disabled={props.busy}
              onClick={() => props.onMute(item.id, item.token)}
            >
              <Icon name="eye-off" size={12} strokeWidth={1.8} />
            </button>
          </span>
        </div>
      ))}
    </details>
  );
}

/**
 * 审查面板 › 摘抄页签：本会话 / 全部两档 + 关键词过滤；点一条回原会话那一轮。
 * 编辑（正文与态度）与删除都在行上，删除两段式带文字。
 */
export function ReviewExcerptsTab(props: {
  sessionId: string;
  revision: string;
  onOpenOrigin: (jump: MemoryOriginJump) => void;
}) {
  const t = useT();
  const [now] = useState(() => Date.now());
  const [mode, setMode] = useState<ExcerptMode>("session");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<MemoryExcerptItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; token: string; draft: string } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    setFailed(false);
    void api.memory
      .excerpts({ sessionId: props.sessionId })
      .then((result) => setItems(result.items))
      .catch(() => setFailed(true));
  }, [props.sessionId]);
  useEffect(() => {
    load();
  }, [load, props.revision]);

  const stanceWords = useMemo<Record<string, string>>(
    () => ({
      position: t.memoryLib.tagStancePosition,
      agree: t.memoryLib.tagStanceAgree,
      doubt: t.memoryLib.tagStanceDoubt,
      oppose: t.memoryLib.tagStanceOppose,
    }),
    [t],
  );
  const shown = useMemo(
    () => (items === null ? [] : filterExcerpts(items, mode, props.sessionId, query, stanceWords)),
    [items, mode, query, props.sessionId, stanceWords],
  );

  const mutate = (token: string, action: () => Promise<unknown>): void => {
    setBusy(true);
    void action()
      .then(() => load())
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div className="memtab">
      <div className="memtab-tools">
        <div className="memtab-seg" role="group" aria-label={t.memoryPanel.tabExcerpts}>
          <button type="button" aria-pressed={mode === "session"} onClick={() => setMode("session")}>
            {t.memoryPanel.segSession}
          </button>
          <button type="button" aria-pressed={mode === "all"} onClick={() => setMode("all")}>
            {t.memoryPanel.segAll}
          </button>
        </div>
        <label className="memtab-search">
          <Icon name="search" size={12} strokeWidth={1.8} />
          <input
            value={query}
            placeholder={t.memoryPanel.excerptSearch}
            onChange={(event) => setQuery(event.target.value)}
            spellCheck={false}
          />
        </label>
      </div>
      {failed ? (
        <p className="panel-empty" role="alert">
          {t.memoryLib.failed}
        </p>
      ) : items === null ? (
        <p className="panel-empty">{t.common.loading}</p>
      ) : shown.length === 0 ? (
        <p className="panel-empty">
          {items.length === 0
            ? t.memoryPanel.excerptEmpty
            : query.trim() !== "" || mode === "session"
              ? t.memoryPanel.excerptEmptyFiltered
              : t.memoryPanel.excerptEmpty}
          <span className="memtab-empty-hint">{t.memoryPanel.excerptEmptyHint}</span>
        </p>
      ) : (
        shown.map((item) => (
          <ExcerptRow
            key={item.entry.id}
            item={item}
            now={now}
            busy={busy}
            editing={editing?.id === item.entry.id ? editing.draft : null}
            confirming={confirming === item.entry.id}
            stanceWords={stanceWords}
            onEdit={(draft) => setEditing(draft === null ? null : { id: item.entry.id, token: item.token, draft })}
            onSaveEdit={(text) => {
              mutate(item.token, () => api.memory.patch({ token: item.token, entryId: item.entry.id, text }));
              setEditing(null);
            }}
            onSetStance={(stance) => mutate(item.token, () => api.memory.patch({ token: item.token, entryId: item.entry.id, stance }))}
            onDelete={() => {
              if (confirming === item.entry.id) {
                mutate(item.token, () => api.memory.removeBatch({ token: item.token, entryIds: [item.entry.id] }));
                setConfirming(null);
              } else setConfirming(item.entry.id);
            }}
            onCancelConfirm={() => setConfirming(null)}
            onOpenOrigin={() => {
              if (item.entry.origin === undefined) return;
              props.onOpenOrigin({
                sessionId: item.entry.sessionId,
                turn: item.entry.origin.turn,
                role: item.entry.origin.role,
                text: item.entry.origin.verbatim,
              });
            }}
          />
        ))
      )}
    </div>
  );
}

function ExcerptRow(props: {
  item: MemoryExcerptItem;
  now: number;
  busy: boolean;
  editing: string | null;
  confirming: boolean;
  stanceWords: Record<string, string>;
  onEdit: (draft: string | null) => void;
  onSaveEdit: (text: string) => void;
  onSetStance: (stance: MemoryStance) => void;
  onDelete: () => void;
  onCancelConfirm: () => void;
  onOpenOrigin: () => void;
}) {
  const t = useT();
  const { entry, sessionTitle } = props.item;
  const stance = entry.stance !== undefined ? props.stanceWords[entry.stance] : null;
  const draft = props.editing;
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (props.editing !== null) editRef.current?.focus();
  }, [props.editing !== null]);
  return (
    <div className="memtab-row excerpt">
      <span className="memtab-row-icon">
        <Icon name="quote" size={12} strokeWidth={1.8} />
      </span>
      <div className="memtab-row-cell">
        {draft !== null ? (
          <span className="memlib-edit">
            <textarea
              ref={editRef}
              value={draft}
              rows={Math.min(4, Math.ceil(draft.length / 36))}
              onChange={(event) => props.onEdit(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") props.onEdit(null);
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  props.onSaveEdit(draft);
                }
              }}
            />
            <span className="memlib-edit-acts">
              <button
                type="button"
                className="mem-btn accent"
                disabled={props.busy || draft.trim() === ""}
                onClick={() => props.onSaveEdit(draft)}
              >
                {t.memoryLib.manualSave}
              </button>
              <button type="button" className="mem-btn text" onClick={() => props.onEdit(null)}>
                {t.memoryLib.actCancel}
              </button>
            </span>
          </span>
        ) : (
          <button type="button" className="memtab-row-text excerpt" title={t.memoryLib.originHint} onClick={props.onOpenOrigin} disabled={entry.origin === undefined}>
            {entry.text}
          </button>
        )}
        <span className="memtab-row-meta">
          {stance !== null && <span className="memlib-tag">{stance}</span>}
          {sessionTitle !== null ? (
            <button type="button" className="memlib-origin" onClick={props.onOpenOrigin} disabled={entry.origin === undefined}>
              <Icon name="message-square" size={11} strokeWidth={1.8} />
              {entry.turn !== undefined ? t.memoryLib.originTurn(sessionTitle, entry.turn) : t.memoryLib.originNoTurn(sessionTitle)}
            </button>
          ) : (
            <span className="memlib-origin deleted">
              <Icon name="message-square-dashed" size={11} strokeWidth={1.8} />
              {t.memoryLib.originDeleted}
            </span>
          )}
          <span className="mono">{formatDay(entry.timestamp, props.now)}</span>
        </span>
      </div>
      <span className="memtab-row-acts">
        {props.confirming ? (
          <>
            <button type="button" className="mem-btn danger solid" disabled={props.busy} onClick={props.onDelete}>
              {t.memoryLib.actConfirmDelete}
            </button>
            <button type="button" className="mem-btn text" onClick={props.onCancelConfirm}>
              {t.memoryLib.actCancel}
            </button>
          </>
        ) : (
          <>
            <Menu
              items={(["position", "agree", "doubt", "oppose"] as const).map(
                (option): MenuItem => ({
                  id: option,
                  label: props.stanceWords[option] ?? option,
                  checked: option === entry.stance,
                  onSelect: () => props.onSetStance(option),
                }),
              )}
              trigger={({ toggle }) => (
                <button
                  type="button"
                  className="ib memlib-ib"
                  title={t.memoryPanel.excerptStanceEdit}
                  aria-label={t.memoryPanel.excerptStanceEdit}
                  disabled={props.busy}
                  onClick={toggle}
                >
                  <Icon name="refresh-cw" size={12} strokeWidth={1.8} />
                </button>
              )}
            />
            <button
              type="button"
              className="ib memlib-ib"
              title={t.memoryLib.actEdit}
              aria-label={t.memoryLib.actEdit}
              disabled={props.busy}
              onClick={() => props.onEdit(entry.text)}
            >
              <Icon name="pencil-line" size={12} strokeWidth={1.8} />
            </button>
            <button
              type="button"
              className="ib memlib-ib danger"
              title={t.memoryLib.actDelete}
              aria-label={t.memoryLib.actDelete}
              disabled={props.busy}
              onClick={props.onDelete}
            >
              <Icon name="trash-2" size={12} strokeWidth={1.8} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}
