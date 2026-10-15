import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import type {
  MemoryConflictResolution,
  MemoryEntry,
  MemoryLibraryItem,
  MemoryScopeInfo,
} from "@shared/memory";
import { useT } from "../../locale.ts";
import { formatDay } from "./migration-groups.ts";
import {
  isPendingConflict,
  libraryGroups,
  libraryStats,
  matchesFilter,
  matchesQuery,
  MEMORY_FILTERS,
  type MemoryFilter,
} from "./memory-page.ts";
import "./memory-view.css";

/** 跳回摘抄／条目出处的请求：打开那条会话、滚到那一轮那段话。 */
export interface MemoryOriginJump {
  sessionId: string;
  turn: number;
  role: "user" | "assistant";
  text: string;
}

/**
 * 设置 › 记忆库（memory v2 的管理面）：左侧按作用域切换（工作区 / Home / 全局），
 * 右侧一个库——搜索、筛选、按「待处理冲突 / 我的摘抄 / 自动蒸馏」分组，行内编辑、
 * 多选批删 / 移到全局，冲突就地拍板。替换 v1 的「按工作区列条目 + 删一条」。
 *
 * 记忆是信任边界：用户要能看见 agent 替他记住了什么、用在哪，并能让任何一条
 * 不存在或不再注入。删除**不可恢复**（没有回收站），所以两段式确认的第二段
 * 是带文字的按钮（「确认删除」），不能只靠变色。
 *
 * 作用域按 token 寻址（sha1(scopeId) 的文件名）：作用域清单从主进程来，
 * 选中哪个就拿着它的 token 去 mutation——scopeId 单向哈希，管理面从头到尾
 * 不需要知道 cwd / workspaceId。
 */
export function MemorySettings(props: {
  onOpenOrigin?: (jump: MemoryOriginJump) => void;
  /** 直达的作用域（「去记忆库」带 token 进来时选中它；之后以用户自己的点击为准） */
  initialToken?: string | null;
}) {
  const t = useT();
  /** 日期格式只看「今年还是往年」，取一次钉住——删一条不让全页日期换一遍 */
  const [now] = useState(() => Date.now());
  const [scopes, setScopes] = useState<{ kind: "loading" } | { kind: "failed" } | { kind: "ready"; list: MemoryScopeInfo[] }>({
    kind: "loading",
  });
  const [token, setToken] = useState<string | null>(props.initialToken ?? null);
  useEffect(() => {
    if (props.initialToken !== undefined && props.initialToken !== null) setToken(props.initialToken);
  }, [props.initialToken]);
  const [items, setItems] = useState<MemoryLibraryItem[] | null>(null);
  const [itemsFailed, setItemsFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MemoryFilter>("all");
  /** 多选（行首 checkbox）；批量栏只在非空时出现 */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 行内编辑中的条目 id 与草稿；一次只有一条 */
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  /** 等二次确认的单行删除（带文字的「确认删除」）；批量删除的确认态单独一个布尔 */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [bulkConfirm, setBulkConfirm] = useState(false);
  /** 展开处理冲突的条目 id（一次一张冲突卡） */
  const [resolving, setResolving] = useState<string | null>(null);
  /** 手动添加的行内输入 */
  const [manual, setManual] = useState<string | null>(null);
  /** 最近一次写操作失败的行 id（错误留在那一行底下，下一次操作清掉）；"bulk" = 批量栏 */
  const [rowError, setRowError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 编辑框 autofocus 用：编辑态挂上后聚焦一次 */
  const editRef = useRef<HTMLTextAreaElement | null>(null);

  const loadScopes = useCallback(() => {
    setScopes({ kind: "loading" });
    void api.memory
      .scopes()
      .then((result) => {
        setScopes({ kind: "ready", list: result.scopes });
        setToken((current) => {
          if (current !== null && result.scopes.some((scope) => scope.token === current)) return current;
          // 默认选中第一个工作区；没有工作区记忆就 Home；再没有就全局
          const preferred =
            result.scopes.find((scope) => scope.kind === "workspace") ??
            result.scopes.find((scope) => scope.kind === "home") ??
            result.scopes[0];
          return preferred?.token ?? null;
        });
      })
      .catch(() => setScopes({ kind: "failed" }));
  }, []);

  useEffect(() => {
    loadScopes();
  }, [loadScopes]);

  const loadItems = useCallback(() => {
    if (token === null) return;
    setItems(null);
    setItemsFailed(false);
    setSelected(new Set());
    setConfirming(null);
    setBulkConfirm(false);
    setResolving(null);
    setEditing(null);
    void api.memory
      .entries({ token })
      .then((result) => setItems(result.items))
      .catch(() => setItemsFailed(true));
  }, [token]);

  useEffect(() => {
    loadItems();
  }, [loadItems]);

  useEffect(() => {
    if (editing !== null) editRef.current?.focus();
  }, [editing?.id]);

  const stanceWords = useMemo<Record<string, string>>(
    () => ({
      position: t.memoryLib.tagStancePosition,
      agree: t.memoryLib.tagStanceAgree,
      doubt: t.memoryLib.tagStanceDoubt,
      oppose: t.memoryLib.tagStanceOppose,
    }),
    [t],
  );

  const shown = useMemo(() => {
    if (items === null) return [];
    return items.filter(
      (item) => matchesFilter(item, filter, now) && matchesQuery(item, query, stanceWords),
    );
  }, [items, filter, query, now, stanceWords]);

  const { groups, pendingOldIds } = useMemo(() => libraryGroups(shown, now), [shown, now]);
  const stats = useMemo(() => libraryStats(items ?? [], now), [items, now]);
  const current = scopes.kind === "ready" ? scopes.list.find((scope) => scope.token === token) ?? null : null;
  const scopeName = current === null ? "" : current.kind === "workspace" ? current.name : current.kind === "home" ? t.memoryLib.home : t.memoryLib.global;

  /* ── 写操作：全部「乐观重拉」而不是本地改——记忆库是唯一的真源，重拉一次的
        代价可忽略，本地改一旦与主进程的口径有出入就是静默分叉 ── */

  const run = (id: string, action: () => Promise<unknown>): void => {
    setBusy(true);
    setRowError(null);
    void action()
      .then(
        () => loadItems(),
        () => setRowError(id),
      )
      .finally(() => setBusy(false));
  };

  const patch = (id: string, req: { text?: string; pinned?: boolean; status?: "active" | "superseded" | "muted" }) =>
    run(id, () => api.memory.patch({ token: token ?? "", entryId: id, ...req }));

  const removeOne = (id: string) => run(id, () => api.memory.removeBatch({ token: token ?? "", entryIds: [id] }));

  const resolve = (id: string, oldId: string, resolution: MemoryConflictResolution, undo = false) =>
    run(id, () =>
      api.memory.resolve({ token: token ?? "", newId: id, oldId, resolution, ...(undo ? { undo: true } : null) }),
    );

  const removeSelected = () => run("bulk", () => api.memory.removeBatch({ token: token ?? "", entryIds: [...selected] }));
  const moveSelected = () => run("bulk", () => api.memory.moveGlobal({ token: token ?? "", entryIds: [...selected] }));

  const addManual = () => {
    const text = manual ?? "";
    if (text.trim() === "") return;
    setBusy(true);
    setRowError(null);
    void api.memory
      .addManual({ token: token ?? "", text })
      .then(
        () => {
          setManual(null);
          loadItems();
        },
        () => setRowError("manual"),
      )
      .finally(() => setBusy(false));
  };

  const side = (
    <nav className="memlib-side" aria-label={t.memoryLib.sideWorkspaces}>
      {scopes.kind !== "ready" ? (
        <span className="memlib-side-hint">
          {scopes.kind === "loading" ? t.memoryLib.loading : t.memoryLib.failed}
        </span>
      ) : (
        <>
          <span className="section-label">{t.memoryLib.sideWorkspaces}</span>
          {scopes.list
            .filter((scope) => scope.kind === "workspace")
            .map((scope) => (
              <ScopeRow key={scope.token} scope={scope} label={scope.name} active={scope.token === token} onSelect={() => setToken(scope.token)} />
            ))}
          {scopes.list.some((scope) => scope.kind === "home") && (
            <>
              <span className="section-label">{t.memoryLib.home}</span>
              {scopes.list
                .filter((scope) => scope.kind === "home")
                .map((scope) => (
                  <ScopeRow key={scope.token} scope={scope} label={scope.name} active={scope.token === token} onSelect={() => setToken(scope.token)} />
                ))}
            </>
          )}
          {scopes.list
            .filter((scope) => scope.kind === "global")
            .map((scope) => (
              <ScopeRow key={scope.token} scope={scope} label={t.memoryLib.global} active={scope.token === token} onSelect={() => setToken(scope.token)} />
            ))}
        </>
      )}
    </nav>
  );

  const filterCounts = useMemo(() => {
    const counts = new Map<MemoryFilter, number>([
      ["all", items?.length ?? 0],
      ["distilled", items?.filter((item) => (item.entry.source ?? "distilled") === "distilled").length ?? 0],
      [
        "excerpt",
        items?.filter((item) => item.entry.source === "excerpt" || item.entry.source === "manual").length ?? 0,
      ],
      ["conflict", items?.filter((item) => isPendingConflict(item.entry)).length ?? 0],
      ["stale", items?.filter((item) => matchesFilter(item, "stale", now)).length ?? 0],
    ]);
    return counts;
  }, [items, now]);

  return (
    // 外层只做尺寸查询容器：设置内容区宽度随右栏开合变化很大（右栏开着时只剩六七百像素），
    // 两栏 / 单栏的切换按「这块地方有多宽」判断，不按窗口宽度
    <div className="memlib-frame">
    <div className="memlib">
      {side}
      <div className="memlib-main">
        <header className="memlib-head">
          <h1>{scopeName}</h1>
          <span className="memlib-stats">{t.memoryLib.stats(stats.total, stats.week, stats.conflicts)}</span>
          <span className="memlib-head-acts">
            <button
              type="button"
              className="mem-btn text"
              disabled={token === null || busy}
              onClick={() => {
                setManual("");
                setRowError(null);
              }}
            >
              <Icon name="plus" size={13} strokeWidth={1.8} />
              {t.memoryLib.addManual}
            </button>
          </span>
        </header>
        <div className="memlib-tools">
          <label className="memlib-search">
            <Icon name="search" size={13} strokeWidth={1.8} />
            <input
              value={query}
              placeholder={t.memoryLib.searchPlaceholder}
              onChange={(event) => setQuery(event.target.value)}
              spellCheck={false}
            />
          </label>
          {MEMORY_FILTERS.map((choice) => (
            <button
              key={choice}
              type="button"
              className="memlib-chip"
              aria-pressed={filter === choice}
              onClick={() => setFilter(choice)}
            >
              {filterLabel(t, choice)}
              <span className="memlib-chip-count">{filterCounts.get(choice) ?? 0}</span>
            </button>
          ))}
          <span className="memlib-sort">
            <Icon name="arrow-down-wide-narrow" size={12} strokeWidth={1.8} />
            {t.memoryLib.sortRecent}
          </span>
        </div>
        <div className="memlib-rows">
          {itemsFailed ? (
            <p className="mem-empty" role="alert">
              <Icon name="triangle-alert" size={13} />
              {t.memoryLib.failed}
              <button type="button" className="mem-btn text" onClick={loadItems}>
                {t.memoryLib.retry}
              </button>
            </p>
          ) : items === null ? (
            <p className="mem-hint">
              <Icon name="loader-circle" size={13} spin />
              {t.memoryLib.loading}
            </p>
          ) : manual !== null ? (
            <div className="memlib-manual">
              <textarea
                ref={editRef}
                value={manual}
                placeholder={t.memoryLib.manualPlaceholder}
                rows={2}
                onChange={(event) => setManual(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setManual(null);
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) addManual();
                }}
              />
              <span className="memlib-manual-acts">
                <button type="button" className="mem-btn accent" disabled={busy || manual.trim() === ""} onClick={addManual}>
                  {t.memoryLib.manualSave}
                </button>
                <button type="button" className="mem-btn text" onClick={() => setManual(null)}>
                  {t.memoryLib.manualCancel}
                </button>
                {rowError === "manual" && (
                  <span className="memlib-row-error" role="alert">
                    {t.memoryLib.errorAdd}
                  </span>
                )}
              </span>
            </div>
          ) : items.length === 0 ? (
            <p className="mem-empty">
              <Icon name="brain-circuit" size={16} />
              <span>{t.memoryLib.emptyScope}</span>
              <span className="memlib-empty-hint">{t.memoryLib.emptyScopeHint}</span>
            </p>
          ) : shown.length === 0 ? (
            <p className="mem-empty">
              <Icon name="search" size={16} />
              <span>{t.memoryLib.emptyFiltered}</span>
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.id} className="memlib-group">
                <span className="memlib-group-label">
                  <Icon name={group.id === "conflicts" ? "triangle-alert" : group.id === "excerpts" ? "quote" : "brain-circuit"} size={12} strokeWidth={1.8} />
                  {group.id === "conflicts" ? t.memoryLib.groupConflicts : group.id === "excerpts" ? t.memoryLib.groupExcerpts : t.memoryLib.groupDistilled}
                </span>
                {group.items.map((item) => (
                  <MemoryRow
                    key={item.entry.id}
                    item={item}
                    now={now}
                    pendingOld={pendingOldIds.has(item.entry.id)}
                    selected={selected.has(item.entry.id)}
                    editing={editing?.id === item.entry.id ? editing.draft : null}
                    confirming={confirming === item.entry.id}
                    resolving={resolving === item.entry.id}
                    resolvingOld={
                      resolving === item.entry.id
                        ? (items.find((other) => other.entry.id === item.entry.supersedes)?.entry ?? null)
                        : null
                    }
                    busy={busy}
                    error={rowError === item.entry.id}
                    onToggle={() =>
                      setSelected((current) => {
                        const next = new Set(current);
                        if (next.has(item.entry.id)) next.delete(item.entry.id);
                        else next.add(item.entry.id);
                        return next;
                      })
                    }
                    onOpenOrigin={props.onOpenOrigin}
                    onEdit={(draft) => setEditing(draft === null ? null : { id: item.entry.id, draft })}
                    onSaveEdit={(text) => {
                      setEditing(null);
                      patch(item.entry.id, { text });
                    }}
                    onDelete={() => {
                      setRowError(null);
                      if (confirming === item.entry.id) removeOne(item.entry.id);
                      else setConfirming(item.entry.id);
                    }}
                    onCancelConfirm={() => setConfirming(null)}
                    onResolve={() => {
                      setRowError(null);
                      setResolving((current) => (current === item.entry.id ? null : item.entry.id));
                    }}
                    onResolvePick={(resolution) => {
                      if (item.entry.supersedes !== undefined) {
                        resolve(item.entry.id, item.entry.supersedes, resolution);
                        setResolving(null);
                      }
                    }}
                    onPinToggle={() => patch(item.entry.id, { pinned: item.entry.pinned !== true })}
                    onMuteToggle={() =>
                      patch(item.entry.id, { status: (item.entry.status ?? "active") === "muted" ? "active" : "muted" })
                    }
                  />
                ))}
              </section>
            ))
          )}
        </div>
        {selected.size > 0 && (
          <footer className="memlib-bulk" data-confirming={bulkConfirm || undefined}>
            <span className="memlib-bulk-count">{t.memoryLib.actSelected(selected.size)}</span>
            <button
              type="button"
              className="mem-btn text"
              disabled={busy || current?.kind === "global"}
              title={current?.kind === "global" ? t.memoryLib.global : undefined}
              onClick={() => {
                setBulkConfirm(false);
                moveSelected();
              }}
            >
              <Icon name="globe" size={13} strokeWidth={1.8} />
              {t.memoryLib.actMoveGlobal}
            </button>
            {bulkConfirm ? (
              <>
                <button type="button" className="mem-btn danger solid" disabled={busy} onClick={removeSelected}>
                  {t.memoryLib.actConfirmDelete}
                </button>
                <button type="button" className="mem-btn text" onClick={() => setBulkConfirm(false)}>
                  {t.memoryLib.actCancel}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="mem-btn danger"
                disabled={busy}
                onClick={() => {
                  setRowError(null);
                  setBulkConfirm(true);
                }}
              >
                <Icon name="trash-2" size={13} strokeWidth={1.8} />
                {t.memoryLib.actDeleteSelected}
              </button>
            )}
            {rowError === "bulk" && (
              <span className="memlib-row-error" role="alert">
                {t.memoryLib.errorRemove}
              </span>
            )}
            <span className="row-trailing" />
            <button type="button" className="mem-btn text" onClick={() => setSelected(new Set())}>
              {t.memoryLib.actClearSelection}
            </button>
          </footer>
        )}
      </div>
    </div>
    </div>
  );
}

function ScopeRow(props: { scope: MemoryScopeInfo; label: string; active: boolean; onSelect: () => void }) {
  const t = useT();
  return (
    <button type="button" className={`memlib-scope option-row${props.active ? " on" : ""}`} aria-pressed={props.active} onClick={props.onSelect}>
      <Icon name={props.scope.kind === "global" ? "globe" : props.scope.kind === "home" ? "message-square" : "folder"} size={13} strokeWidth={1.8} />
      <span className="memlib-scope-name" title={props.label}>
        {props.label}
      </span>
      <span className="memlib-scope-count mono">{t.memoryLib.countShort(props.scope.count)}</span>
    </button>
  );
}

function filterLabel(t: ReturnType<typeof useT>, filter: MemoryFilter): string {
  if (filter === "all") return t.memoryLib.filterAll;
  if (filter === "distilled") return t.memoryLib.filterDistilled;
  if (filter === "excerpt") return t.memoryLib.filterExcerpt;
  if (filter === "conflict") return t.memoryLib.filterConflict;
  return t.memoryLib.filterStale;
}

function stanceTag(t: ReturnType<typeof useT>, entry: MemoryEntry): string | null {
  if (entry.stance === undefined) return null;
  if (entry.stance === "position") return t.memoryLib.tagStancePosition;
  if (entry.stance === "agree") return t.memoryLib.tagStanceAgree;
  if (entry.stance === "doubt") return t.memoryLib.tagStanceDoubt;
  return t.memoryLib.tagStanceOppose;
}

/**
 * 一行记忆：正文（可原地编辑）、状态标签、出处（可点回原会话）、使用统计、悬停操作。
 * 删除两段式：第一段换出**带文字**的「确认删除 / 取消」——只靠变色过不了用户的眼。
 */
function MemoryRow(props: {
  item: MemoryLibraryItem;
  now: number;
  pendingOld: boolean;
  selected: boolean;
  editing: string | null;
  confirming: boolean;
  resolving: boolean;
  resolvingOld: MemoryEntry | null;
  busy: boolean;
  error: boolean;
  onToggle: () => void;
  onOpenOrigin?: (jump: MemoryOriginJump) => void;
  onEdit: (draft: string | null) => void;
  onSaveEdit: (text: string) => void;
  onDelete: () => void;
  onCancelConfirm: () => void;
  onResolve: () => void;
  onResolvePick: (resolution: MemoryConflictResolution) => void;
  onPinToggle: () => void;
  onMuteToggle: () => void;
}) {
  const t = useT();
  const { entry, usage, sessionTitle } = props.item;
  const draft = props.editing;
  const editRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (props.editing !== null) editRef.current?.focus();
  }, [props.editing]);
  const source = entry.source ?? "distilled";
  const muted = (entry.status ?? "active") === "muted";
  const superseded = entry.status === "superseded";
  const isExcerpt = source === "excerpt" || source === "manual";
  const stance = stanceTag(t, entry);
  const tags: { key: string; label: string; tone?: "warn" }[] = [];
  if (isPendingConflict(entry)) tags.push({ key: "cf-new", label: t.memoryLib.tagConflictNew, tone: "warn" });
  if (props.pendingOld) tags.push({ key: "cf-old", label: t.memoryLib.tagConflictOld, tone: "warn" });
  if (superseded) tags.push({ key: "sup", label: t.memoryLib.tagSuperseded });
  if (muted) tags.push({ key: "muted", label: t.memoryLib.tagMuted });
  if (stance !== null) tags.push({ key: `stance-${entry.stance}`, label: stance });
  if (entry.pinned === true) tags.push({ key: "pin", label: t.memoryLib.tagPinned });
  if (entry.editedAt !== undefined) tags.push({ key: "edited", label: t.memoryLib.tagEdited });
  const origin =
    sessionTitle !== null ? (
      <button
        type="button"
        className="memlib-origin"
        title={t.memoryLib.originHint}
        onClick={() => {
          if (entry.origin === undefined || props.onOpenOrigin === undefined) return;
          props.onOpenOrigin({
            sessionId: entry.sessionId,
            turn: entry.origin.turn,
            role: entry.origin.role,
            text: entry.origin.verbatim,
          });
        }}
        disabled={entry.origin === undefined || props.onOpenOrigin === undefined}
      >
        <Icon name="message-square" size={11} strokeWidth={1.8} />
        {entry.turn !== undefined
          ? t.memoryLib.originTurn(sessionTitle, entry.turn)
          : t.memoryLib.originNoTurn(sessionTitle)}
      </button>
    ) : (
      <span className="memlib-origin deleted">
        <Icon name="message-square-dashed" size={11} strokeWidth={1.8} />
        {t.memoryLib.originDeleted}
      </span>
    );
  const when = formatDay(entry.timestamp, props.now);
  const used =
    usage.count === 0
      ? t.memoryLib.statNever
      : t.memoryLib.statUsed(usage.count, formatDay(usage.lastAt ?? entry.timestamp, props.now));
  return (
    <div
      className="memlib-row"
      data-selected={props.selected || undefined}
      data-muted={muted || superseded || undefined}
    >
      <input
        type="checkbox"
        className="memlib-check"
        checked={props.selected}
        onChange={props.onToggle}
        aria-label={t.memoryLib.actSelect}
      />
      <div className="memlib-cell">
        {draft !== null ? (
          <span className="memlib-edit">
            <textarea
              ref={editRef}
              value={draft}
              rows={Math.min(4, Math.ceil(draft.length / 40))}
              onChange={(event) => props.onEdit(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") props.onEdit(null);
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) props.onSaveEdit(draft);
              }}
            />
            <span className="memlib-edit-acts">
              <button type="button" className="mem-btn accent" disabled={props.busy || draft.trim() === ""} onClick={() => props.onSaveEdit(draft)}>
                {t.memoryLib.manualSave}
              </button>
              <button type="button" className="mem-btn text" onClick={() => props.onEdit(null)}>
                {t.memoryLib.actCancel}
              </button>
            </span>
          </span>
        ) : (
          <p className="memlib-text" title={entry.text}>
            {entry.text}
          </p>
        )}
        <span className="memlib-src">
          {tags.map((tag) => (
            <span key={tag.key} className="memlib-tag" data-tone={tag.tone}>
              {tag.label}
            </span>
          ))}
          {origin}
        </span>
        {props.resolving && props.resolvingOld !== null && (
          <span className="memlib-conflict">
            <span className="memlib-conflict-old">
              <span className="memlib-conflict-label">{t.memoryLib.resolveOldLabel}</span>
              <s>{props.resolvingOld.text}</s>
            </span>
            <span className="memlib-conflict-acts">
              <button type="button" className="mem-btn accent" disabled={props.busy} onClick={() => props.onResolvePick("replace")}>
                <Icon name="check" size={12} strokeWidth={1.8} />
                {t.memoryLib.resolveReplace}
              </button>
              <button type="button" className="mem-btn" disabled={props.busy} onClick={() => props.onResolvePick("keep-both")}>
                {t.memoryLib.resolveKeepBoth}
              </button>
              <button type="button" className="mem-btn danger" disabled={props.busy} onClick={() => props.onResolvePick("drop-new")}>
                {t.memoryLib.resolveDropNew}
              </button>
            </span>
          </span>
        )}
        {props.error && (
          <span className="memlib-row-error" role="alert">
            {t.memoryLib.errorPatch}
          </span>
        )}
      </div>
      <span className="memlib-stat">
        {isExcerpt ? t.memoryLib.statExcerpted(when) : t.memoryLib.statAdded(when)}
        <span aria-hidden="true"> · </span>
        {used}
      </span>
      <span className="memlib-acts">
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
            {isPendingConflict(entry) && (
              <button type="button" className="ib memlib-ib" title={t.memoryLib.actResolve} aria-label={t.memoryLib.actResolve} disabled={props.busy} onClick={props.onResolve}>
                <Icon name="git-pull-request" size={13} strokeWidth={1.8} />
              </button>
            )}
            <button type="button" className="ib memlib-ib" title={t.memoryLib.actEdit} aria-label={t.memoryLib.actEdit} disabled={props.busy} onClick={() => props.onEdit(entry.text)}>
              <Icon name="pencil-line" size={13} strokeWidth={1.8} />
            </button>
            {isExcerpt && (
              <button
                type="button"
                className="ib memlib-ib"
                title={entry.pinned === true ? t.memoryLib.actUnpin : t.memoryLib.actPin}
                aria-label={entry.pinned === true ? t.memoryLib.actUnpin : t.memoryLib.actPin}
                disabled={props.busy}
                onClick={props.onPinToggle}
              >
                <Icon name="pin" size={13} strokeWidth={1.8} />
              </button>
            )}
            <button
              type="button"
              className="ib memlib-ib"
              title={muted ? t.memoryLib.actUnmute : t.memoryLib.actMute}
              aria-label={muted ? t.memoryLib.actUnmute : t.memoryLib.actMute}
              disabled={props.busy}
              onClick={props.onMuteToggle}
            >
              <Icon name={muted ? "eye" : "eye-off"} size={13} strokeWidth={1.8} />
            </button>
            <button type="button" className="ib memlib-ib danger" title={t.memoryLib.actDelete} aria-label={t.memoryLib.actDelete} disabled={props.busy} onClick={props.onDelete}>
              <Icon name="trash-2" size={13} strokeWidth={1.8} />
            </button>
          </>
        )}
      </span>
    </div>
  );
}
