import "./migration-view.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportDestination,
  ImportDetectResult,
  ImportRunReport,
  ImportScanReport,
  ImportSourceId,
  ImportSourceProbe,
} from "@shared/import";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import {
  DEFAULT_FILTERS,
  RANGE_LABEL,
  SOURCE_LABEL,
  abbreviateHome,
  allRows,
  defaultSelection,
  destinationChoices,
  destinationLabel,
  destinationOptions,
  effectiveDestination,
  formatBytes,
  formatDay,
  formatMoment,
  groupName,
  groupSessions,
  sameDestination,
  selectedSourceFiles,
  summarize,
  type GroupedSessions,
  type RangeFilter,
  type SessionFilters,
  type SessionGroup,
  type SessionRow,
} from "./migration-groups.ts";

/**
 * 设置 › Migration：把本机其他 agent 的会话迁进来。步骤铺在同一页（wafo 2026-09-24：
 * 设置里单开一个 tab，不学 zcode 的首启弹窗）——
 *
 *   1 Sources  固定清单 + 每行会读的路径（这张清单就是隐私声明）；默认一个都不勾，勾了并
 *              点 Scan 才读。打开页面只跑 import:detect（只 stat）。
 *   2 Sessions 按源侧文件夹分组、跨来源合并；每组一个去向菜单，可展开到单条会话逐条取舍；
 *              筛选默认全部（不限时间、含归档）。子会话不单列，跟着母会话走。
 *              再次导入时，已导入、Proma 里又有新消息的会话单独成一块排在最前（ChangedBlock）：
 *              追加进原会话的默认勾，两边都聊过、要另导一份的默认不勾；在 orbita 删过的留在
 *              文件夹组里、默认不勾。
 *   底栏       汇总 + 唯一的主操作 Import。执行在主进程：按同样的来源重扫，再按勾选与去向落盘。
 *
 * Skills / MCP 两段等各自那一刀落地再出现（暂不支持的东西不列，同来源的裁决）。
 */

type DetectState =
  | { kind: "loading" }
  | { kind: "ready"; result: ImportDetectResult }
  | { kind: "error"; message: string };

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  /** scannedAt 固定住「现在」：时间筛选按扫描那一刻算，不随每次渲染漂 */
  | { kind: "ready"; report: ImportScanReport; sources: ImportSourceId[]; scannedAt: number }
  | { kind: "error"; message: string };

type RunState =
  | { kind: "idle" }
  | { kind: "running"; sessions: number }
  | { kind: "done"; result: ImportRunReport }
  | { kind: "error"; message: string };

/** 展开的组里先列这么多条，其余收进「Show N more」 */
const ROWS_BEFORE_MORE = 8;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MigrationView(props: {
  workspaces: readonly Workspace[];
  onImported: () => void;
  onOpenProviders: () => void;
}) {
  const [detect, setDetect] = useState<DetectState>({ kind: "loading" });
  const [ticked, setTicked] = useState<ReadonlySet<ImportSourceId>>(new Set());
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [filters, setFilters] = useState<SessionFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [overrides, setOverrides] = useState<ReadonlyMap<string | null, ImportDestination>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string | null>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string | null>>(new Set());
  /** 「有新消息」那一块默认展开：再次导入时用户要对照的就是它 */
  const [changedOpen, setChangedOpen] = useState(true);
  const [run, setRun] = useState<RunState>({ kind: "idle" });

  useEffect(() => {
    let cancelled = false;
    void api.import
      .detect()
      .then((result) => {
        if (!cancelled) setDetect({ kind: "ready", result });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setDetect({ kind: "error", message: errorText(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const busy = scan.kind === "scanning" || run.kind === "running";
  const home = detect.kind === "ready" ? detect.result.home : "";

  /** keepRun：执行完自动重扫时保住「Imported …」那一行，列表刷新成还剩下的 */
  const startScan = useCallback((sources: ImportSourceId[], keepRun: boolean) => {
    setScan({ kind: "scanning" });
    if (!keepRun) setRun({ kind: "idle" });
    void api.import
      .scan({ sources })
      .then((report) => {
        setScan({ kind: "ready", report, sources, scannedAt: Date.now() });
        setSelected(defaultSelection(report));
        setChangedOpen(true);
        setOverrides(new Map());
        setExpanded(new Set());
        setShowAll(new Set());
      })
      .catch((cause: unknown) => setScan({ kind: "error", message: errorText(cause) }));
  }, []);

  const grouped = useMemo<GroupedSessions | null>(
    () => (scan.kind === "ready" ? groupSessions(scan.report, filters, scan.scannedAt) : null),
    [scan, filters],
  );
  const summary = useMemo(
    () => (grouped === null ? null : summarize(grouped, selected, overrides)),
    [grouped, selected, overrides],
  );

  // 任何改选择的动作都让「Imported …」退场：那是上一次的结果，不是眼前这份勾选的
  const touch = useCallback(() => setRun((current) => (current.kind === "done" ? { kind: "idle" } : current)), []);

  const toggleSource = (id: ImportSourceId) => {
    setTicked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const setRows = (rows: readonly SessionRow[], on: boolean) => {
    touch();
    setSelected((current) => {
      const next = new Set(current);
      for (const row of rows) {
        if (on) next.add(row.item.sourceFile);
        else next.delete(row.item.sourceFile);
      }
      return next;
    });
  };

  const toggleIn = (set: ReadonlySet<string | null>, key: string | null): Set<string | null> => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const startRun = () => {
    if (scan.kind !== "ready" || grouped === null || summary === null || summary.sessions + summary.updates === 0) return;
    const sources = scan.sources;
    setRun({ kind: "running", sessions: summary.sessions + summary.updates + summary.subSessions });
    void api.import
      .run({
        sources,
        sessions: selectedSourceFiles(grouped, selected),
        destinations: destinationChoices(grouped, overrides),
      })
      .then((result) => {
        setRun({ kind: "done", result });
        // 落了新会话 / 新工作区：主界面两张列表重读；本页重扫，剩下没导的留在列表里
        props.onImported();
        startScan(sources, true);
      })
      .catch((cause: unknown) => setRun({ kind: "error", message: errorText(cause) }));
  };

  const probes = detect.kind === "ready" ? detect.result.sources : [];
  const scannedCount = (id: ImportSourceId): number | null => {
    if (scan.kind !== "ready" || !scan.sources.includes(id) || grouped === null) return null;
    return grouped.total;
  };

  return (
    <div className="mg">
      <div className="mg-scroll scroll">
        <div className="mg-col">
          <p className="mg-intro">
            Bring sessions over from other agents on this Mac. Nothing is read until you tick a source and scan,
            and the other apps' files are never changed.
          </p>

          {/* ================= 1 Sources ================= */}
          <section className="mg-sec">
            <div className="mg-sec-head">
              <span className="section-label">1 · Sources</span>
              {probes.some((probe) => probe.found && !ticked.has(probe.id)) && (
                <button
                  type="button"
                  className="mg-textbtn"
                  disabled={busy}
                  onClick={() => setTicked(new Set(probes.filter((probe) => probe.found).map((probe) => probe.id)))}
                >
                  Tick all found
                </button>
              )}
            </div>
            {detect.kind === "loading" && <p className="mg-placeholder">Checking this Mac…</p>}
            {detect.kind === "error" && <p className="mg-placeholder">Couldn't check for sources: {detect.message}</p>}
            {detect.kind === "ready" && (
              <div className="mg-list">
                {probes.map((probe) => (
                  <SourceRow
                    key={probe.id}
                    probe={probe}
                    home={home}
                    checked={ticked.has(probe.id)}
                    disabled={busy || !probe.found}
                    scanned={scannedCount(probe.id)}
                    onToggle={() => toggleSource(probe.id)}
                  />
                ))}
              </div>
            )}
            <div className="mg-scanrow">
              <p className="mg-note">These are the only paths orbita checks. Before a scan it only looks at whether they exist.</p>
              <button
                type="button"
                className="quiet-control mg-btn"
                disabled={busy || ticked.size === 0}
                title={ticked.size === 0 ? "Tick a source to scan it" : undefined}
                onClick={() => startScan([...ticked], false)}
              >
                <Icon
                  name={scan.kind === "scanning" ? "loader-circle" : scan.kind === "ready" ? "refresh-cw" : "search"}
                  size={12}
                  spin={scan.kind === "scanning"}
                />
                {scan.kind === "scanning" ? "Scanning…" : scan.kind === "ready" ? "Rescan" : "Scan"}
              </button>
            </div>
          </section>

          {/* ================= 2 Sessions ================= */}
          <section className="mg-sec">
            <div className="mg-sec-head">
              <span className="section-label">2 · Sessions</span>
              {grouped !== null && grouped.total > 0 && (
                <span className="mg-sec-actions">
                  <Menu
                    items={(Object.keys(RANGE_LABEL) as RangeFilter[]).map((range) => ({
                      id: range,
                      label: RANGE_LABEL[range],
                      checked: filters.range === range,
                      onSelect: () => {
                        touch();
                        setFilters((current) => ({ ...current, range }));
                      },
                    }))}
                    panelMinWidth={140}
                    trigger={({ open, toggle }) => (
                      <Chip icon="clock" active={open} chevron onClick={toggle} title="Show sessions updated within">
                        {RANGE_LABEL[filters.range]}
                      </Chip>
                    )}
                  />
                  <Chip
                    icon="archive"
                    active={filters.includeArchived}
                    title={filters.includeArchived ? "Archived sessions are listed · click to hide them" : "Archived sessions are hidden · click to list them"}
                    onClick={() => {
                      touch();
                      setFilters((current) => ({ ...current, includeArchived: !current.includeArchived }));
                    }}
                  >
                    Include archived
                  </Chip>
                  <span className="mg-sep" />
                  <SelectAllButton grouped={grouped} selected={selected} disabled={busy} onSet={setRows} />
                </span>
              )}
            </div>

            {scan.kind === "idle" && (
              <p className="mg-placeholder">Scan to list sessions from the sources you ticked, grouped by the folder they ran in.</p>
            )}
            {scan.kind === "scanning" && (
              <p className="mg-placeholder">
                <Icon name="loader-circle" size={12} spin /> Reading session lists…
              </p>
            )}
            {scan.kind === "error" && <p className="mg-placeholder mg-error">Scan failed: {scan.message}</p>}
            {scan.kind === "ready" && grouped !== null && (
              <>
                {grouped.groups.length === 0 && grouped.changed.length === 0 ? (
                  <p className="mg-placeholder">
                    {grouped.total === 0 ? "Nothing new to import." : "No sessions match the filters."}
                  </p>
                ) : (
                  <div className="mg-list">
                    {grouped.changed.length > 0 && (
                      <ChangedBlock
                        rows={grouped.changed}
                        now={scan.scannedAt}
                        selected={selected}
                        expanded={changedOpen}
                        disabled={busy}
                        onToggleExpand={() => setChangedOpen((open) => !open)}
                        onSetRows={setRows}
                      />
                    )}
                    {grouped.groups.map((group) => (
                      <GroupBlock
                        key={group.folder ?? ""}
                        group={group}
                        home={home}
                        now={scan.scannedAt}
                        workspaces={props.workspaces}
                        selected={selected}
                        destination={effectiveDestination(group, overrides)}
                        expanded={expanded.has(group.folder)}
                        showAll={showAll.has(group.folder)}
                        disabled={busy}
                        onToggleExpand={() => setExpanded((current) => toggleIn(current, group.folder))}
                        onShowAll={() => setShowAll((current) => toggleIn(current, group.folder))}
                        onSetRows={setRows}
                        onDestination={(destination) => {
                          touch();
                          setOverrides((current) => {
                            const next = new Map(current);
                            if (sameDestination(destination, group.defaultDestination)) next.delete(group.folder);
                            else next.set(group.folder, destination);
                            return next;
                          });
                        }}
                      />
                    ))}
                  </div>
                )}
                <SessionNotes
                  report={scan.report}
                  grouped={grouped}
                  now={scan.scannedAt}
                  fallback={summary?.fallback ?? null}
                  onOpenProviders={props.onOpenProviders}
                />
              </>
            )}
          </section>
        </div>
      </div>

      {(scan.kind === "ready" || run.kind !== "idle") && (
        <ImportFooter
          run={run}
          summary={summary}
          disabled={busy || summary === null || summary.sessions + summary.updates === 0}
          onImport={startRun}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<ImportSourceProbe["kind"], string> = {
  app: "Desktop app",
  cli: "CLI",
  folder: "Folder used by several agents",
};

function SourceRow(props: {
  probe: ImportSourceProbe;
  home: string;
  checked: boolean;
  disabled: boolean;
  /** 扫过的来源给出会话数；没扫过为 null */
  scanned: number | null;
  onToggle: () => void;
}) {
  const { probe } = props;
  const status = !probe.found
    ? "Not found"
    : props.scanned !== null
      ? null
      : props.checked
        ? "Ticked · not scanned"
        : "Found";
  return (
    <label className="mg-row mg-row-source" data-disabled={!probe.found || undefined}>
      <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={props.onToggle} />
      <span className="mg-copy">
        <span className="mg-line1">
          <span className="mg-name">{probe.label}</span>
          <span className="mg-meta">{KIND_LABEL[probe.kind]}</span>
        </span>
        <span className="mg-path" title={probe.paths.join("\n")}>
          {probe.paths.map((path) => abbreviateHome(path, props.home)).join(", ")}
        </span>
      </span>
      <span className="mg-trail">
        {status !== null ? (
          <span className="mg-status">{status}</span>
        ) : (
          <span className="mg-count">
            <b>{props.scanned}</b> {props.scanned === 1 ? "session" : "sessions"}
          </span>
        )}
      </span>
    </label>
  );
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

function SelectAllButton(props: {
  grouped: GroupedSessions;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSet: (rows: readonly SessionRow[], on: boolean) => void;
}) {
  const rows = allRows(props.grouped);
  const all = rows.length > 0 && rows.every((row) => props.selected.has(row.item.sourceFile));
  return (
    <button type="button" className="mg-textbtn" disabled={props.disabled} onClick={() => props.onSet(rows, !all)}>
      {all ? "Clear all" : "Select all"}
    </button>
  );
}

function sourceBreakdown(group: SessionGroup): string {
  return (Object.entries(group.bySource) as [ImportSourceId, number][])
    .map(([source, count]) => `${SOURCE_LABEL[source]} ${count}`)
    .join(" · ");
}

/**
 * 已导入、Proma 里又有新消息的会话。没有去向菜单：追加的留在原会话里，另导的一份放在
 * 原会话旁边——两者的落点都由既有的那条会话定。尾部第三列放一句说明占住去向列的位置，
 * 与下面各文件夹组的列对齐。
 */
function ChangedBlock(props: {
  rows: readonly SessionRow[];
  now: number;
  selected: ReadonlySet<string>;
  expanded: boolean;
  disabled: boolean;
  onToggleExpand: () => void;
  onSetRows: (rows: readonly SessionRow[], on: boolean) => void;
}) {
  const picked = props.rows.filter((row) => props.selected.has(row.item.sourceFile)).length;
  const all = picked === props.rows.length;
  const bySource = new Map<ImportSourceId, number>();
  for (const row of props.rows) bySource.set(row.item.source, (bySource.get(row.item.source) ?? 0) + 1);
  return (
    <div className="mg-group">
      <div className="mg-row mg-row-group" onClick={props.onToggleExpand}>
        <span className="mg-lead">
          <input
            type="checkbox"
            aria-label="Bring over new messages in sessions imported before"
            checked={picked > 0}
            ref={(element) => {
              if (element !== null) element.indeterminate = picked > 0 && !all;
            }}
            disabled={props.disabled}
            onClick={(event) => event.stopPropagation()}
            onChange={() => props.onSetRows(props.rows, !all)}
          />
          <button
            type="button"
            className="mg-chev"
            aria-expanded={props.expanded}
            aria-label={props.expanded ? "Collapse" : "Expand"}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleExpand();
            }}
          >
            <Icon name="chevron-right" size={12} />
          </button>
          <span className="mg-glyph">
            <Icon name="refresh-cw" size={14} strokeWidth={1.8} />
          </span>
        </span>
        <span className="mg-copy">
          <span className="mg-line1">
            <span className="mg-name">Updated since import</span>
            <span className="mg-meta">
              {[...bySource.entries()].map(([source, count]) => `${SOURCE_LABEL[source]} ${count}`).join(" · ")}
            </span>
          </span>
          <span className="mg-where">New messages go into the same session here.</span>
        </span>
        <span className="mg-trail mg-cols" onClick={(event) => event.stopPropagation()}>
          <span className="mg-count">
            <b>{picked}</b>
            {all ? "" : ` of ${props.rows.length}`}
          </span>
          <span className="mg-sub" />
          <span className="mg-status">Stays where it is</span>
        </span>
      </div>
      {props.expanded && (
        <div className="mg-children">
          {props.rows.map((row) => (
            <SessionLine
              key={row.item.sourceFile}
              row={row}
              now={props.now}
              checked={props.selected.has(row.item.sourceFile)}
              disabled={props.disabled}
              onToggle={(on) => props.onSetRows([row], on)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** 行上「相对 orbita 的状态」那一截；没导过的不说。 */
function changeNote(row: SessionRow): string | null {
  const { change, newMessages } = row.item;
  const messages = `+${newMessages} ${newMessages === 1 ? "message" : "messages"}`;
  if (change === "updated") return messages;
  // 说明要短：它和标题挤在同一行，长了标题先被截断
  if (change === "diverged") return `${messages} · also continued here · comes in as a copy`;
  if (change === "deleted") return "deleted here";
  return null;
}

function GroupBlock(props: {
  group: SessionGroup;
  home: string;
  now: number;
  workspaces: readonly Workspace[];
  selected: ReadonlySet<string>;
  destination: ImportDestination;
  expanded: boolean;
  showAll: boolean;
  disabled: boolean;
  onToggleExpand: () => void;
  onShowAll: () => void;
  onSetRows: (rows: readonly SessionRow[], on: boolean) => void;
  onDestination: (destination: ImportDestination) => void;
}) {
  const { group } = props;
  const picked = group.rows.filter((row) => props.selected.has(row.item.sourceFile)).length;
  const all = picked === group.rows.length;
  const subSessions = group.rows.reduce((sum, row) => sum + row.subSessions, 0);
  const destinationItems: MenuItem[] = destinationOptions(group, props.workspaces).map((option, index) => ({
    id: `${index}`,
    label: option.label,
    ...(option.hint === undefined ? null : { hint: option.hint }),
    icon: option.destination.kind === "new-workspace" ? "folder-plus" : option.destination.kind === "tasks" ? "list" : "folder",
    checked: sameDestination(option.destination, props.destination),
    onSelect: () => props.onDestination(option.destination),
  }));
  const visibleRows = props.showAll ? group.rows : group.rows.slice(0, ROWS_BEFORE_MORE);

  return (
    <div className="mg-group">
      {/* 整行点开 / 收起；复选框与去向菜单各管各的，不冒泡到这里 */}
      <div className="mg-row mg-row-group" onClick={props.onToggleExpand}>
        <span className="mg-lead">
          <input
            type="checkbox"
            aria-label={`Import sessions from ${groupName(group.folder)}`}
            checked={picked > 0}
            ref={(element) => {
              if (element !== null) element.indeterminate = picked > 0 && !all;
            }}
            disabled={props.disabled}
            onClick={(event) => event.stopPropagation()}
            onChange={() => props.onSetRows(group.rows, !all)}
          />
          <button
            type="button"
            className="mg-chev"
            aria-expanded={props.expanded}
            aria-label={props.expanded ? "Collapse" : "Expand"}
            onClick={(event) => {
              event.stopPropagation();
              props.onToggleExpand();
            }}
          >
            <Icon name="chevron-right" size={12} />
          </button>
          <span className="mg-glyph">
            <Icon name={group.folder === null ? "list" : "folder"} size={14} strokeWidth={1.8} />
          </span>
        </span>
        <span className="mg-copy">
          <span className="mg-line1">
            <span className="mg-name">{groupName(group.folder)}</span>
            <span className="mg-meta">{sourceBreakdown(group)}</span>
          </span>
          {group.folder === null ? (
            <span className="mg-where">Sessions that didn't run in a project folder</span>
          ) : (
            <span className="mg-path" title={group.folder}>
              {abbreviateHome(group.folder, props.home)}
            </span>
          )}
        </span>
        <span className="mg-trail mg-cols" onClick={(event) => event.stopPropagation()}>
          <span className="mg-count">
            <b>{picked}</b>
            {all ? "" : ` of ${group.rows.length}`}
          </span>
          <span className="mg-sub" title="Sub-sessions come with their parents">
            {subSessions > 0 && (
              <>
                <Icon name="git-fork" size={11} strokeWidth={1.8} />
                {subSessions}
              </>
            )}
          </span>
          <Menu
            items={destinationItems}
            align="end"
            panelMinWidth={200}
            trigger={({ open, toggle }) => (
              <Chip
                icon={props.destination.kind === "new-workspace" ? "folder-plus" : undefined}
                active={open}
                chevron
                disabled={props.disabled}
                title="Where these sessions go"
                onClick={toggle}
              >
                {destinationLabel(props.destination, props.workspaces)}
              </Chip>
            )}
          />
        </span>
      </div>

      {props.expanded && (
        <div className="mg-children">
          {visibleRows.map((row) => (
            <SessionLine
              key={row.item.sourceFile}
              row={row}
              now={props.now}
              checked={props.selected.has(row.item.sourceFile)}
              disabled={props.disabled}
              onToggle={(on) => props.onSetRows([row], on)}
            />
          ))}
          {group.rows.length > ROWS_BEFORE_MORE && (
            <div className="mg-more">
              <button type="button" className="mg-textbtn" onClick={props.onShowAll}>
                {props.showAll ? "Show fewer" : `Show ${group.rows.length - ROWS_BEFORE_MORE} more`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SessionLine(props: {
  row: SessionRow;
  now: number;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const { item, subSessions } = props.row;
  return (
    <label className="mg-child">
      <input
        type="checkbox"
        checked={props.checked}
        disabled={props.disabled}
        onChange={(event) => props.onToggle(event.target.checked)}
      />
      <span className="mg-line1">
        <span className="mg-title" title={item.title}>
          {item.title}
        </span>
        <span className="mg-meta">
          {[SOURCE_LABEL[item.source], formatDay(item.updatedAt, props.now), item.archived ? "archived" : null, changeNote(props.row)]
            .filter((part): part is string => part !== null)
            .join(" · ")}
        </span>
      </span>
      <span className="mg-trail">
        {subSessions > 0 && (
          <span className="mg-sub" title="Sub-sessions come with it">
            <Icon name="git-fork" size={11} strokeWidth={1.8} />
            {subSessions}
          </span>
        )}
        <span
          className="mg-model"
          title={item.modelMatched ? "Continues on this model" : "The original model isn't set up here — it opens on the default model"}
        >
          {item.modelMatched ? (
            item.modelId
          ) : (
            <>
              <span className="mg-model-was">{item.importedModel ?? "unknown model"}</span>
              <Icon name="arrow-right" size={10} />
              {item.modelId}
            </>
          )}
        </span>
      </span>
    </label>
  );
}

function SessionNotes(props: {
  report: ImportScanReport;
  grouped: GroupedSessions;
  now: number;
  fallback: { count: number; models: string[]; fallbackModel: string | null } | null;
  onOpenProviders: () => void;
}) {
  const [details, setDetails] = useState(false);
  const alreadyImported = props.report.skipped.filter((skip) => skip.reason === "already-imported").length;
  const unconvertible = props.report.skipped.filter((skip) => skip.reason !== "already-imported");
  const cannot = unconvertible.length + props.report.withoutPiSession;
  const fallback = props.fallback;
  const models = fallback === null ? [] : fallback.models.slice(0, 3);
  return (
    <div className="mg-notes">
      {props.grouped.hidden > 0 && (
        <span className="mg-noteline">
          <Icon name="eye-off" size={12} />
          <span>{props.grouped.hidden} hidden by the filters. Only listed sessions are imported.</span>
        </span>
      )}
      {fallback !== null && fallback.count > 0 && (
        <span className="mg-noteline">
          <Icon name="cpu" size={12} />
          <span>
            {fallback.count} of the ticked sessions ran models you haven't set up here
            {models.length > 0 ? ` (${models.join(", ")}${fallback.models.length > models.length ? ", …" : ""})` : ""}. They open
            on <b>{fallback.fallbackModel}</b> and keep a record of the original.{" "}
            <button type="button" className="mg-link" onClick={props.onOpenProviders}>
              Set up providers
            </button>
          </span>
        </span>
      )}
      {props.report.orphanedSubSessions > 0 && (
        <span className="mg-noteline">
          <Icon name="git-fork" size={12} />
          <span>
            {props.report.orphanedSubSessions} sub-sessions have no importable parent, so they're listed on their own.
          </span>
        </span>
      )}
      {alreadyImported > 0 && (
        <span className="mg-noteline">
          <Icon name="circle-check" size={12} />
          <span>
            {alreadyImported} already imported and unchanged since, not listed.
            {props.report.lastImportAt !== null ? ` Last import ${formatMoment(props.report.lastImportAt, props.now)}.` : ""}
          </span>
        </span>
      )}
      {cannot > 0 && (
        <span className="mg-noteline">
          <Icon name="circle-off" size={12} />
          <span>
            {cannot} can't be imported: an older format with no transcript, or a file that's missing or unreadable.{" "}
            {unconvertible.length > 0 && (
              <button type="button" className="mg-link" onClick={() => setDetails((open) => !open)}>
                {details ? "Hide details" : "Details"}
              </button>
            )}
          </span>
        </span>
      )}
      {details && (
        <ul className="mg-skips">
          {unconvertible.slice(0, 30).map((skip) => (
            <li key={skip.sourceId}>
              <span className="mg-skip-title">{skip.title ?? skip.sourceId}</span>
              <span className="mg-skip-why">{skip.detail ?? skip.reason}</span>
            </li>
          ))}
          {unconvertible.length > 30 && <li className="mg-skip-why">… and {unconvertible.length - 30} more</li>}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 底栏
// ---------------------------------------------------------------------------

function ImportFooter(props: {
  run: RunState;
  summary: ReturnType<typeof summarize> | null;
  disabled: boolean;
  onImport: () => void;
}) {
  const { run, summary } = props;
  if (run.kind === "running") {
    return (
      <footer className="mg-foot">
        <span className="mg-foot-copy">
          <span className="mg-foot-main">
            <Icon name="loader-circle" size={13} spin />
            Importing {run.sessions} {run.sessions === 1 ? "session" : "sessions"}…
          </span>
          <span className="mg-foot-sub">Copying session files into orbita. Large histories take a minute.</span>
        </span>
        <button type="button" className="btn-accent mg-btn mg-btn-primary" disabled>
          Importing…
        </button>
      </footer>
    );
  }
  if (run.kind === "done") {
    const { result } = run;
    const first = result.failed[0];
    return (
      <footer className="mg-foot">
        <span className="mg-foot-copy">
          <span className="mg-foot-main">
            <span className="mg-ok">
              <Icon name="circle-check" size={14} />
            </span>
            {[
              result.imported > 0 || result.updated === 0
                ? `Imported ${result.imported} ${result.imported === 1 ? "session" : "sessions"}`
                : null,
              result.updated > 0
                ? `${result.imported > 0 ? "updated" : "Updated"} ${result.updated} ${result.updated === 1 ? "session" : "sessions"}`
                : null,
              result.createdWorkspaces.length > 0
                ? `${result.createdWorkspaces.length} new ${result.createdWorkspaces.length === 1 ? "workspace" : "workspaces"}`
                : null,
            ]
              .filter((part): part is string => part !== null)
              .join(" · ")}
          </span>
          <span className="mg-foot-sub" title={result.failed.map((item) => `${item.sourceId}: ${item.error ?? ""}`).join("\n")}>
            {first === undefined
              ? result.imported === 0
                ? "The new messages are in those sessions now. Anything left below wasn't ticked."
                : "They're in the sidebar now. Anything left below wasn't ticked."
              : `${result.failed.length} failed — ${first.error ?? "unknown error"}. Import again to retry.`}
          </span>
        </span>
      </footer>
    );
  }
  return (
    <footer className="mg-foot">
      <span className="mg-foot-copy">
        {run.kind === "error" ? (
          <>
            <span className="mg-foot-main mg-error">
              <Icon name="triangle-alert" size={13} />
              Import failed
            </span>
            <span className="mg-foot-sub">{run.message}</span>
          </>
        ) : summary === null || summary.sessions + summary.updates === 0 ? (
          <span className="mg-foot-sub">Tick the sessions you want to bring over.</span>
        ) : (
          <>
            <span className="mg-foot-main">
              {[
                summary.sessions > 0 ? `Import ${summary.sessions} ${summary.sessions === 1 ? "session" : "sessions"}` : null,
                summary.updates > 0
                  ? `${summary.sessions > 0 ? "update" : "Update"} ${summary.updates} ${summary.updates === 1 ? "session" : "sessions"}`
                  : null,
              ]
                .filter((part): part is string => part !== null)
                .join(" · ")}
            </span>
            <span className="mg-foot-sub">
              {[
                summary.subSessions > 0
                  ? `${summary.subSessions} ${summary.subSessions === 1 ? "sub-session comes" : "sub-sessions come"} with ${summary.subSessions === 1 ? "its parent" : "their parents"}`
                  : null,
                summary.newWorkspaces > 0
                  ? `${summary.newWorkspaces} new ${summary.newWorkspaces === 1 ? "workspace" : "workspaces"}`
                  : null,
                `about ${formatBytes(summary.bytes)} copied`,
              ]
                .filter((part): part is string => part !== null)
                .join(" · ")}
            </span>
          </>
        )}
      </span>
      <button type="button" className="btn-accent mg-btn mg-btn-primary" disabled={props.disabled} onClick={props.onImport}>
        <Icon name="download" size={13} />
        Import
      </button>
    </footer>
  );
}
