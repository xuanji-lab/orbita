import "./migration-view.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ImportDestination,
  ImportDetectResult,
  ImportGreetingCheckPlan,
  ImportGreetingUnavailable,
  ImportPlanItem,
  ImportRunReport,
  ImportScanReport,
  ImportSkillItem,
  ImportSkillMode,
  ImportSkillScope,
  ImportSourceId,
  ImportSourceProbe,
} from "@shared/import";
import { IMPORT_GREETING_UNAVAILABLE_CODE } from "@shared/import";
import type { Workspace } from "@shared/workspace";
import type { ProviderDto } from "@shared/provider";
import type { ModelPair } from "@shared/settings";
import { api } from "../../api";
import { Chip } from "../../shell/Chip";
import { Icon, type IconName } from "../../shell/Icon";
import { Menu, type MenuItem } from "../../shell/Menu";
import { useSettingTip } from "./InfoTip";
import {
  DEFAULT_FILTERS,
  abbreviateHome,
  allRows,
  defaultSelection,
  destinationChoices,
  destinationLabel,
  destinationOptions,
  effectiveDestination,
  formatDay,
  groupName,
  groupSessions,
  dataRootCounts,
  sameDestination,
  selectedSourceFiles,
  summarize,
  type GroupedSessions,
  type RangeFilter,
  type SessionFilters,
  type SessionGroup,
  type SessionRow,
} from "./migration-groups.ts";
import {
  changeBadge,
  countLine,
  doneFacts,
  doneHeadline,
  footFacts,
  greetingSteps,
  headline,
  mixedSources,
  modelTip,
  pathGlyph,
  runningHeadline,
  sessionFacts,
  sourcePaths,
  sourceStatus,
  stepStates,
  duplicateSkips,
  unconvertibleSkips,
  type ChangeBadge,
  type FootFactKind,
  type GreetingStepsState,
  type PathGlyph,
  type SessionFactKind,
  type SourceCounts,
  type StepState,
} from "./migration-page.ts";
import { Fact, FootFact, Step, StepDot, TipBadge, Tipped } from "./MigrationStep.tsx";
import { SkillsSection } from "./MigrationSkills.tsx";
import { McpSection } from "./MigrationMcp.tsx";
import { defaultMcpSelection, mcpCountBySource, selectedMcpNames } from "./migration-mcp.ts";
import {
  countSelectedSkills,
  defaultSkillSelection,
  sameSkillScope,
  DEFAULT_SKILL_SCOPE,
  selectableSkills,
  selectedSkillDirs,
  skillCountBySource,
  skillScopeChoices,
} from "./migration-skills.ts";
import type { Messages } from "../../messages-en.ts";
import { useT } from "../../locale.ts";

/**
 * 设置 › Migration：把本机其他 agent 的会话、skills 与 MCP servers 迁进来。步骤铺在同一页
 * （wafo 2026-09-24：设置里单开一个 tab，不学 zcode 的首启弹窗），左侧圆点编号，做完的打勾：
 *
 *   1 Sources  固定清单 + 每个来源竖排列出会读的路径（这张清单就是隐私声明）；默认一个都不勾，
 *              勾了并点 Scan 才读。打开页面只跑 import:detect（只 stat）。扫描之后这一步折成
 *              一行摘要（扫了哪些来源 + 「N paths」悬停列出路径 + Rescan），点「N paths」再展开。
 *   2 Sessions 按源侧文件夹分组、跨来源合并；每组一个去向菜单（列头 Goes to），可展开到单条会话
 *              逐条取舍；筛选默认全部（不限时间、含归档）。子会话不单列，跟着母会话走。
 *              再次导入时，已导入、源里又有新消息的会话单独成一块排在最前（ChangedBlock）：
 *              追加进原会话的默认勾，两边都聊过、要另导一份的默认不勾；在 orbita 删过的留在
 *              文件夹组里、默认不勾。这些状态在单条行上是徽标（+16 / +3 · copy / Deleted here）。
 *   3 Skills   按源 skills 目录分组，重名先到先得；段头 Copy / Link（默认 Copy），每组一个作用域。
 *   4 MCP      一个名字一行，导进来一律停用（段头一枚 Off 徽标）。
 *   5 Import   底栏：汇总 + 唯一的主操作 Import。执行在主进程：按同样的来源重扫，再按勾选与去向落盘。
 *
 * 文字的纪律同 General / Providers（设计稿「中」档）：常驻的只有名词、数字和图标，整句进悬停。
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
  | { kind: "running"; sessions: number; skills: number; mcp: number }
  | { kind: "done"; result: ImportRunReport }
  | { kind: "error"; message: string };

/** 展开的组里先列这么多条，其余收进「Show N more」 */
const ROWS_BEFORE_MORE = 8;

function toggled<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function MigrationView(props: {
  workspaces: readonly Workspace[];
  /** 全部厂商（含没填 key 的）——三步清单的状态每次按它现算 */
  providers: readonly ProviderDto[];
  /** 设置里的家务活模型（清单第②步与检查用的模型都取这份实时值） */
  choreModel: ModelPair | undefined;
  onImported: () => void;
  onOpenProviders: () => void;
  /** 招呼检查没选家务活模型时跳到通用设置（那里选，并高亮那一行） */
  onOpenGeneral: () => void;
}) {
  const t = useT();
  const [detect, setDetect] = useState<DetectState>({ kind: "loading" });
  const [ticked, setTicked] = useState<ReadonlySet<ImportSourceId>>(new Set());
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  /** 扫描之后第 1 步折成一行；点「N paths」再展开来改勾选 */
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [filters, setFilters] = useState<SessionFilters>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [overrides, setOverrides] = useState<ReadonlyMap<string | null, ImportDestination>>(new Map());
  const [expanded, setExpanded] = useState<ReadonlySet<string | null>>(new Set());
  const [showAll, setShowAll] = useState<ReadonlySet<string | null>>(new Set());
  /** 「有新消息」那一块默认展开：再次导入时用户要对照的就是它 */
  const [changedOpen, setChangedOpen] = useState(true);
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [skillSelected, setSkillSelected] = useState<ReadonlySet<string>>(new Set());
  const [skillMode, setSkillMode] = useState<ImportSkillMode>("copy");
  const [skillScopes, setSkillScopes] = useState<ReadonlyMap<string, ImportSkillScope>>(new Map());
  const [skillExpanded, setSkillExpanded] = useState<ReadonlySet<string>>(new Set());
  const [skillShowAll, setSkillShowAll] = useState<ReadonlySet<string>>(new Set());
  const [mcpSelected, setMcpSelected] = useState<ReadonlySet<string>>(new Set());
  const [greetings, setGreetings] = useState<GreetingState>({ kind: "off" });

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

  // 检查进行中也不能导：判中的还没从勾选里拿掉
  const busy = scan.kind === "scanning" || run.kind === "running" || greetings.kind === "checking";
  const home = detect.kind === "ready" ? detect.result.home : "";

  /** keepRun：执行完自动重扫时保住「Imported …」那一行，列表刷新成还剩下的 */
  const startScan = useCallback((sources: ImportSourceId[], keepRun: boolean) => {
    setScan({ kind: "scanning" });
    if (!keepRun) setRun({ kind: "idle" });
    void api.import
      .scan({ sources })
      .then((report) => {
        setScan({ kind: "ready", report, sources, scannedAt: Date.now() });
        setSourcesOpen(false);
        setSelected(defaultSelection(report));
        setChangedOpen(true);
        setOverrides(new Map());
        setExpanded(new Set());
        setShowAll(new Set());
        setSkillSelected(defaultSkillSelection(report.skills));
        setSkillScopes(new Map());
        setSkillExpanded(new Set());
        setSkillShowAll(new Set());
        setMcpSelected(defaultMcpSelection(report.mcp));
      })
      .catch((cause: unknown) => setScan({ kind: "error", message: errorText(cause) }));
  }, []);

  const grouped = useMemo<GroupedSessions | null>(
    () =>
      scan.kind === "ready"
        ? groupSessions(scan.report, filters, scan.scannedAt, greetings.kind === "on" ? greetings.leaveOut : undefined)
        : null,
    [scan, filters, greetings],
  );
  const summary = useMemo(
    () => (grouped === null ? null : summarize(grouped, selected, overrides)),
    [grouped, selected, overrides],
  );
  /** 计划里的数据根，按来源分组：有任何一组（组内目录必 >1）就出「按数据目录筛」的菜单 */
  const rootGroups = useMemo(() => (scan.kind === "ready" ? dataRootCounts(scan.report) : []), [scan]);
  const rootTotal = rootGroups.reduce((sum, group) => sum + group.roots.length, 0);
  const shownRoots = rootGroups.reduce(
    (sum, group) => sum + group.roots.filter((entry) => !filters.excludedRoots.has(entry.root)).length,
    0,
  );
  const skillCount = scan.kind === "ready" ? countSelectedSkills(scan.report.skills, skillSelected) : 0;
  const mcpCount = scan.kind === "ready" ? selectedMcpNames(scan.report.mcp, mcpSelected).length : 0;
  const nothingTicked = summary === null || summary.sessions + summary.updates + skillCount + mcpCount === 0;

  const steps = stepStates({
    scanned: scan.kind === "ready",
    imported: run.kind === "done",
    hasSessions: grouped !== null && grouped.total > 0,
    hasSkills: scan.kind === "ready" && scan.report.skills.some((group) => selectableSkills(group).length > 0),
    hasMcp: scan.kind === "ready" && scan.report.mcp.some((item) => item.status === "new"),
  });

  // 任何改选择的动作都让「Imported …」退场：那是上一次的结果，不是眼前这份勾选的
  const touch = useCallback(() => setRun((current) => (current.kind === "done" ? { kind: "idle" } : current)), []);

  /**
   * 「只随手发了一句」检查：勾上才调模型（花的是用户的额度），取消就把判中的放回列表。
   * 判的结果按 sourceFile 记，重扫之后仍然有效（执行完自动重扫时不用再花一次）。
   */
  const setGreetingCheck = (on: boolean): void => {
    touch();
    if (!on || scan.kind !== "ready") {
      setGreetings({ kind: "off" });
      return;
    }
    setGreetings({ kind: "checking" });
    void api.import
      .checkGreetings({ sources: scan.sources })
      .then((result) =>
        setGreetings((current) =>
          current.kind === "checking"
            ? {
                kind: "on",
                leaveOut: new Set(result.greetingOnly),
                checked: result.checked,
                asked: result.asked,
                model: result.model.modelId,
              }
            : current,
        ),
      )
      .catch((cause: unknown) =>
        setGreetings((current) => {
          if (current.kind !== "checking") return current;
          const message = errorText(cause);
          return { kind: "error", reason: greetingUnavailableOf(message), message };
        }),
      );
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

  const toggleIn = (set: ReadonlySet<string | null>, key: string | null): Set<string | null> => toggled(set, key);

  const setSkills = (skills: readonly ImportSkillItem[], on: boolean) => {
    touch();
    setSkillSelected((current) => {
      const next = new Set(current);
      for (const skill of skills) {
        if (on) next.add(skill.dir);
        else next.delete(skill.dir);
      }
      return next;
    });
  };

  const startRun = () => {
    if (scan.kind !== "ready" || grouped === null || summary === null || nothingTicked) return;
    const sources = scan.sources;
    setRun({
      kind: "running",
      sessions: summary.sessions + summary.updates + summary.subSessions,
      skills: skillCount,
      mcp: mcpCount,
    });
    void api.import
      .run({
        sources,
        sessions: selectedSourceFiles(grouped, selected),
        destinations: destinationChoices(grouped, overrides),
        skills: selectedSkillDirs(scan.report.skills, skillSelected),
        skillMode,
        skillScopes: skillScopeChoices(skillScopes),
        mcp: selectedMcpNames(scan.report.mcp, mcpSelected),
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
  const skillsBySource = useMemo(() => (scan.kind === "ready" ? skillCountBySource(scan.report.skills) : {}), [scan]);
  const mcpBySource = useMemo(() => (scan.kind === "ready" ? mcpCountBySource(scan.report.mcp) : {}), [scan]);
  const scannedCount = (id: ImportSourceId): SourceCounts | null => {
    if (scan.kind !== "ready" || !scan.sources.includes(id) || grouped === null) return null;
    return {
      sessions: grouped.totalBySource[id] ?? 0,
      skills: skillsBySource[id] ?? 0,
      mcp: mcpBySource[id] ?? 0,
    };
  };

  return (
    <div className="mg">
      <div className="mg-scroll scroll">
        <div className="mg-col">
          {/* ================= 1 Sources ================= */}
          <SourcesStep
            state={steps.sources}
            detect={detect}
            probes={probes}
            home={home}
            ticked={ticked}
            scanned={scan.kind === "ready" ? scan.sources : null}
            scanning={scan.kind === "scanning"}
            open={scan.kind !== "ready" || sourcesOpen}
            busy={busy}
            countOf={scannedCount}
            onToggleOpen={() => setSourcesOpen((open) => !open)}
            onToggle={(id) => setTicked((current) => toggled(current, id))}
            onTickAll={() => setTicked(new Set(probes.filter((probe) => probe.found).map((probe) => probe.id)))}
            onScan={() => startScan([...ticked], false)}
          />

          {/* ================= 2 Sessions ================= */}
          <Step
            n={2}
            title={t.migration.stepSessions}
            state={steps.sessions}
            tools={
              grouped !== null &&
              grouped.total > 0 && (
                <span className="mg-tools">
                  <Menu
                    items={(Object.keys(t.migration.ranges) as RangeFilter[]).map((range) => ({
                      id: range,
                      label: t.migration.ranges[range],
                      checked: filters.range === range,
                      onSelect: () => {
                        touch();
                        setFilters((current) => ({ ...current, range }));
                      },
                    }))}
                    panelMinWidth={140}
                    trigger={({ open, toggle }) => (
                      <Chip icon="clock" active={open} chevron onClick={toggle} title={t.migration.rangeTip}>
                        {t.migration.ranges[filters.range]}
                      </Chip>
                    )}
                  />
                  <Chip
                    icon="archive"
                    active={filters.includeArchived}
                    title={
                      filters.includeArchived
                        ? t.migration.archivedListedTip
                        : t.migration.archivedHiddenTip
                    }
                    onClick={() => {
                      touch();
                      setFilters((current) => ({ ...current, includeArchived: !current.includeArchived }));
                    }}
                  >
                    {t.migration.includeArchived}
                  </Chip>
                  {rootGroups.length > 0 && (
                    <Menu
                      items={rootGroups.flatMap((group) => [
                        // 分组头 = 来源名；Menu 的 header 项不可选、不抢焦点，样式同设置面节标题
                        {
                          id: `source:${group.source}`,
                          label: t.migration.sources[group.source],
                          header: true,
                        },
                        ...group.roots.map((entry) => ({
                          id: entry.root,
                          label: abbreviateHome(entry.root, home),
                          hint: t.migration.dataRootOnlyHere(entry.onlyHere),
                          checked: !filters.excludedRoots.has(entry.root),
                          // 多选：点一下切一个根，菜单不关
                          keepOpen: true,
                          onSelect: () => {
                            touch();
                            setFilters((current) => ({
                              ...current,
                              excludedRoots: toggled(current.excludedRoots, entry.root),
                            }));
                          },
                        })),
                      ])}
                      trigger={({ open, toggle }) => (
                        <Chip icon="folder-open" active={open} chevron onClick={toggle} title={t.migration.dataRootsTip}>
                          {shownRoots === rootTotal
                            ? t.migration.dataRootsAll
                            : t.migration.dataRootsSome(shownRoots, rootTotal)}
                        </Chip>
                      )}
                    />
                  )}
                  <span className="mg-sep" />
                  <SelectAllButton grouped={grouped} selected={selected} disabled={busy} onSet={setRows} />
                </span>
              )
            }
          >
            {scan.kind === "idle" && <SkeletonList scanning={false} caption={t.migration.sessionsCaption} />}
            {scan.kind === "scanning" && <SkeletonList scanning caption={t.migration.readingSessions} />}
            {scan.kind === "error" && (
              <p className="mg-caption mg-error">
                <Icon name="triangle-alert" size={12} />
                {t.migration.scanFailed} {scan.message}
              </p>
            )}
            {scan.kind === "ready" && grouped !== null && (
              <>
                {grouped.groups.length === 0 && grouped.changed.length === 0 ? (
                  <div className="mg-block mg-empty">
                    <Icon name={grouped.total === 0 ? "circle-check" : "eye-off"} size={15} />
                    {grouped.total === 0 ? t.migration.nothingToImport : t.migration.noSessionsMatch}
                  </div>
                ) : (
                  <>
                    <GreetingChecklist
                      plan={scan.report.greetingCheck}
                      state={greetings}
                      steps={greetingSteps(props.providers, props.choreModel)}
                      choreModel={props.choreModel}
                      disabled={scan.kind !== "ready" || run.kind === "running"}
                      onOpenProviders={props.onOpenProviders}
                      onOpenGeneral={props.onOpenGeneral}
                      onToggle={setGreetingCheck}
                    />
                    <div className="mg-colhead mg-grid-sessions" aria-hidden="true">
                      <span />
                      <span>{t.migration.colFolder}</span>
                      <span>{t.migration.colSelected}</span>
                      <span>
                        <Icon name="git-fork" size={11} strokeWidth={1.8} />
                      </span>
                      <span>{t.migration.colGoesTo}</span>
                    </div>
                    <div className="mg-block">
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
                  </>
                )}
                <SessionFacts
                  report={scan.report}
                  grouped={grouped}
                  now={scan.scannedAt}
                  home={home}
                  leftOut={
                    greetings.kind === "on" ? scan.report.plan.filter((item) => greetings.leaveOut.has(item.sourceFile)) : []
                  }
                  onKeep={(sourceFile) => {
                    touch();
                    setGreetings((current) => {
                      if (current.kind !== "on") return current;
                      const leaveOut = new Set(current.leaveOut);
                      leaveOut.delete(sourceFile);
                      return { ...current, leaveOut };
                    });
                  }}
                />
              </>
            )}
          </Step>

          {/* ================= 3 Skills ================= */}
          <SkillsSection
            state={steps.skills}
            groups={scan.kind === "ready" ? scan.report.skills : null}
            home={home}
            workspaces={props.workspaces}
            selected={skillSelected}
            mode={skillMode}
            scopes={skillScopes}
            expanded={skillExpanded}
            showAll={skillShowAll}
            disabled={busy}
            onMode={(mode) => {
              touch();
              setSkillMode(mode);
            }}
            onSet={setSkills}
            onScope={(dir, scope) => {
              touch();
              setSkillScopes((current) => {
                const next = new Map(current);
                if (sameSkillScope(scope, DEFAULT_SKILL_SCOPE)) next.delete(dir);
                else next.set(dir, scope);
                return next;
              });
            }}
            onToggleExpand={(dir) => setSkillExpanded((current) => toggled(current, dir))}
            onShowAll={(dir) => setSkillShowAll((current) => toggled(current, dir))}
          />

          {/* ================= 4 MCP servers ================= */}
          <McpSection
            state={steps.mcp}
            items={scan.kind === "ready" ? scan.report.mcp : null}
            home={home}
            selected={mcpSelected}
            disabled={busy}
            onSet={(names, on) => {
              touch();
              setMcpSelected((current) => {
                const next = new Set(current);
                for (const name of names) {
                  if (on) next.add(name);
                  else next.delete(name);
                }
                return next;
              });
            }}
          />
        </div>
      </div>

      {/* ================= 5 Import（底栏） ================= */}
      <ImportFooter
        state={steps.import}
        scanned={scan.kind === "ready"}
        run={run}
        summary={summary}
        skills={skillCount}
        mcp={mcpCount}
        skillMode={skillMode}
        disabled={busy || nothingTicked}
        onImport={startRun}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 Sources
// ---------------------------------------------------------------------------


const PATH_ICON: Record<PathGlyph, IconName> = { json: "file-json-2", file: "file", folder: "folder" };

/** 段头的 Read-only 徽标：代替原来导语里那句「the other apps' files are never changed」 */
function ReadOnlyBadge() {
  const t = useT();
  return (
    <TipBadge icon="lock" tip={t.migration.readOnlyTip} focusable>
      {t.migration.readOnly}
    </TipBadge>
  );
}

function SourcesStep(props: {
  state: StepState;
  detect: DetectState;
  probes: readonly ImportSourceProbe[];
  home: string;
  ticked: ReadonlySet<ImportSourceId>;
  /** 上一次扫描用的来源；还没扫出结果为 null */
  scanned: readonly ImportSourceId[] | null;
  scanning: boolean;
  /** 列表展开（扫描前恒展开；扫描后默认折成一行） */
  open: boolean;
  busy: boolean;
  countOf: (id: ImportSourceId) => SourceCounts | null;
  onToggleOpen: () => void;
  onToggle: (id: ImportSourceId) => void;
  onTickAll: () => void;
  onScan: () => void;
}) {
  const t = useT();
  const { probes } = props;
  const canTickMore = probes.some((probe) => probe.found && !props.ticked.has(probe.id));
  const scanButton = (
    <button
      type="button"
      className="quiet-control mg-btn"
      disabled={props.busy || props.ticked.size === 0}
      title={props.ticked.size === 0 ? t.migration.tickToScan : undefined}
      onClick={props.onScan}
    >
      <Icon
        name={props.scanning ? "loader-circle" : props.scanned !== null ? "refresh-cw" : "search"}
        size={12}
        spin={props.scanning}
      />
      {props.scanning ? t.migration.scanning : props.scanned !== null ? t.migration.rescan : t.migration.scan}
    </button>
  );
  const tickAll = props.open && canTickMore && (
    <button type="button" className="mg-textbtn" disabled={props.busy} onClick={props.onTickAll}>
      {t.migration.tickAllFound}
    </button>
  );

  return (
    <Step
      n={1}
      title={t.migration.stepSources}
      state={props.state}
      summary={
        <span className="mg-step-sum">
          {props.scanned !== null && <span>{props.scanned.map((id) => t.migration.sources[id]).join(" · ")}</span>}
          <ReadOnlyBadge />
        </span>
      }
      tools={
        <span className="mg-tools">
          {tickAll}
          {props.scanned !== null && (
            <PathsButton
              paths={sourcePaths(probes, props.scanned)}
              home={props.home}
              open={props.open}
              onClick={props.onToggleOpen}
            />
          )}
          {scanButton}
        </span>
      }
    >
      {props.open && (
        <>
          {props.detect.kind === "loading" && (
            <p className="mg-caption">
              <Icon name="loader-circle" size={12} spin /> {t.migration.checkingSources}
            </p>
          )}
          {props.detect.kind === "error" && (
            <p className="mg-caption mg-error">
              <Icon name="triangle-alert" size={12} />
              {t.migration.checkSourcesFailed} {props.detect.message}
            </p>
          )}
          {props.detect.kind === "ready" && (
            <>
              {/* 隐私声明常驻、不进悬停：它和下面的路径清单一起，说清扫描读什么、还碰什么 */}
              <p className="mg-caption mg-caption-lead">
                <Icon name="eye" size={12} strokeWidth={1.8} />
                {t.migration.pathsNote}
              </p>
              <div className="mg-block">
                {probes.map((probe) => (
                  <SourceRow
                    key={probe.id}
                    probe={probe}
                    home={props.home}
                    checked={props.ticked.has(probe.id)}
                    disabled={props.busy || !probe.found}
                    scanReady={props.scanned !== null}
                    counts={props.countOf(probe.id)}
                    onToggle={() => props.onToggle(probe.id)}
                  />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Step>
  );
}

/**
 * 折叠后的「N paths」：悬停竖排列出扫描读过的路径与那句隐私声明，点一下展开整张来源清单
 * （改勾选、看每个来源各自的路径）。
 */
function PathsButton(props: { paths: readonly string[]; home: string; open: boolean; onClick: () => void }) {
  const t = useT();
  const tip = useSettingTip<HTMLButtonElement>(
    <>
      <span className="mg-tip-paths">
        {props.paths.map((path) => (
          <span key={path}>{abbreviateHome(path, props.home)}</span>
        ))}
      </span>
      {t.migration.pathsNote}
    </>,
  );
  return (
    <>
      <button
        type="button"
        className="quiet-control mg-btn mg-btn-ghost"
        aria-expanded={props.open}
        onClick={props.onClick}
        {...tip.anchor}
      >
        <Icon name="eye" size={13} strokeWidth={1.8} />
        {t.migration.paths(props.paths.length)}
      </button>
      {tip.layer}
    </>
  );
}

function SourceRow(props: {
  probe: ImportSourceProbe;
  home: string;
  checked: boolean;
  disabled: boolean;
  scanReady: boolean;
  /** 扫过的来源给出能导的会话 / skill / MCP 数；没扫过为 null */
  counts: SourceCounts | null;
  onToggle: () => void;
}) {
  const t = useT();
  const { probe } = props;
  const status = sourceStatus(probe, props.checked, props.scanReady, props.counts);
  return (
    <div className="mg-src" data-disabled={!probe.found || undefined}>
      <label className="mg-src-head">
        <input type="checkbox" checked={props.checked} disabled={props.disabled} onChange={props.onToggle} />
        <span className="mg-line1">
          <span className="mg-name">{t.migration.sources[probe.id]}</span>
          <span className="mg-meta">{t.migration.kinds[probe.kind]}</span>
        </span>
        <span className="mg-trail">
          {status.kind === "not-found" && (
            <span className="mg-status">
              <Icon name="circle-off" size={12} strokeWidth={1.8} />
              {t.migration.notFound}
            </span>
          )}
          {status.kind === "found" && (
            <Tipped className="mg-status mg-found" tip={t.migration.foundTip}>
              <Icon name="circle-check" size={12} strokeWidth={1.8} />
              {t.migration.found}
            </Tipped>
          )}
          {status.kind === "not-scanned" && <span className="mg-status">{t.migration.notScanned}</span>}
          {status.kind === "scanned" &&
            (countLine(status.counts, t) === "" ? (
              <span className="mg-status">{t.migration.nothingNew}</span>
            ) : (
              <span className="mg-count">{countLine(status.counts, t)}</span>
            ))}
        </span>
      </label>
      {/* 路径清单竖排、常驻：这就是隐私声明，不收进悬停 */}
      <ul className="mg-paths" aria-label={t.migration.pathsReadFor(t.migration.sources[probe.id])}>
        {probe.paths.map((path) => (
          <li key={path} className="mg-path-line" title={path}>
            <Icon name={PATH_ICON[pathGlyph(path)]} size={11} strokeWidth={1.8} />
            <span>{abbreviateHome(path, props.home)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2 Sessions
// ---------------------------------------------------------------------------

/** 扫描前 / 扫描中的占位：三行虚线骨架，先把「按文件夹分组、每组一个去向」的形状摆出来。 */
function SkeletonList(props: { scanning: boolean; caption: string }) {
  return (
    <>
      <div className="mg-skel-list" data-scanning={props.scanning || undefined} aria-hidden="true">
        {(["folder", "folder", "list"] as const).map((icon, index) => (
          <div key={index} className="mg-skel">
            <span className="mg-skel-box" />
            <Icon name={icon} size={14} strokeWidth={1.8} />
            <span className="mg-skel-bar" data-w={index} />
            <span className="mg-skel-bar" />
          </div>
        ))}
      </div>
      <p className="mg-caption" role="status">
        <Icon name={props.scanning ? "loader-circle" : "folder"} size={12} spin={props.scanning} strokeWidth={1.8} />
        {props.caption}
      </p>
    </>
  );
}

function SelectAllButton(props: {
  grouped: GroupedSessions;
  selected: ReadonlySet<string>;
  disabled: boolean;
  onSet: (rows: readonly SessionRow[], on: boolean) => void;
}) {
  const t = useT();
  const rows = allRows(props.grouped);
  const all = rows.length > 0 && rows.every((row) => props.selected.has(row.item.sourceFile));
  return (
    <button type="button" className="mg-textbtn" disabled={props.disabled} onClick={() => props.onSet(rows, !all)}>
      {all ? t.migration.clearAll : t.migration.selectAll}
    </button>
  );
}

function sourceBreakdown(bySource: Partial<Record<ImportSourceId, number>>, t: Messages): string {
  return (Object.entries(bySource) as [ImportSourceId, number][])
    .map(([source, count]) => `${t.migration.sources[source]} ${count}`)
    .join(" · ");
}

/** 组行左端：复选框（全选 / 半选）+ 展开箭头。两者都不冒泡到整行的展开。 */
function GroupLead(props: {
  label: string;
  picked: number;
  total: number;
  expanded: boolean;
  disabled: boolean;
  onSet: (on: boolean) => void;
  onToggleExpand: () => void;
}) {
  const t = useT();
  const all = props.picked === props.total;
  return (
    <span className="mg-lead">
      <input
        type="checkbox"
        aria-label={props.label}
        checked={props.picked > 0}
        ref={(element) => {
          if (element !== null) element.indeterminate = props.picked > 0 && !all;
        }}
        disabled={props.disabled}
        onClick={(event) => event.stopPropagation()}
        onChange={() => props.onSet(!all)}
      />
      <button
        type="button"
        className="mg-chev"
        aria-expanded={props.expanded}
        aria-label={props.expanded ? t.migration.collapse : t.migration.expand}
        onClick={(event) => {
          event.stopPropagation();
          props.onToggleExpand();
        }}
      >
        <Icon name="chevron-right" size={12} />
      </button>
    </span>
  );
}

function PickedCount(props: { picked: number; total: number }) {
  const t = useT();
  return (
    <span className="mg-count mg-num">
      <b>{props.picked}</b>
      {props.picked === props.total ? "" : t.migration.ofTotal(props.total)}
    </span>
  );
}

/**
 * 已导入、源里又有新消息的会话。没有去向菜单：追加的留在原会话里，另导的一份放在
 * 原会话旁边——两者的落点都由既有的那条会话定。去向列写「Same session」，整句进悬停。
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
  const t = useT();
  const picked = props.rows.filter((row) => props.selected.has(row.item.sourceFile)).length;
  const bySource: Partial<Record<ImportSourceId, number>> = {};
  for (const row of props.rows) bySource[row.item.source] = (bySource[row.item.source] ?? 0) + 1;
  const showSource = mixedSources(props.rows.map((row) => row.item));
  return (
    <div className="mg-group">
      <div className="mg-grow mg-grid-sessions" onClick={props.onToggleExpand}>
        <GroupLead
          label={t.migration.changedLabel}
          picked={picked}
          total={props.rows.length}
          expanded={props.expanded}
          disabled={props.disabled}
          onSet={(on) => props.onSetRows(props.rows, on)}
          onToggleExpand={props.onToggleExpand}
        />
        <span className="mg-gcopy">
          <span className="mg-gname">
            <Icon name="refresh-cw" size={14} strokeWidth={1.8} />
            <span className="mg-name">{t.migration.updatedSinceImport}</span>
            <span className="mg-meta">{sourceBreakdown(bySource, t)}</span>
          </span>
        </span>
        <PickedCount picked={picked} total={props.rows.length} />
        <span />
        <span className="mg-dest" onClick={(event) => event.stopPropagation()}>
          <Tipped className="mg-fixed-dest" tip={t.migration.sameSessionTip} focusable>
            <Icon name="corner-down-left" size={12} />
            {t.migration.sameSession}
          </Tipped>
        </span>
      </div>
      {props.expanded && (
        <div className="mg-kids">
          {props.rows.map((row) => (
            <SessionLine
              key={row.item.sourceFile}
              row={row}
              now={props.now}
              showSource={showSource}
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
  const t = useT();
  const { group } = props;
  const picked = group.rows.filter((row) => props.selected.has(row.item.sourceFile)).length;
  const subSessions = group.rows.reduce((sum, row) => sum + row.subSessions, 0);
  const destinationItems: MenuItem[] = destinationOptions(group, props.workspaces, t).map((option, index) => ({
    id: `${index}`,
    label: option.label,
    ...(option.hint === undefined ? null : { hint: option.hint }),
    icon: option.destination.kind === "new-workspace" ? "folder-plus" : option.destination.kind === "tasks" ? "list" : "folder",
    checked: sameDestination(option.destination, props.destination),
    onSelect: () => props.onDestination(option.destination),
  }));
  const visibleRows = props.showAll ? group.rows : group.rows.slice(0, ROWS_BEFORE_MORE);
  const showSource = Object.keys(group.bySource).length > 1;

  return (
    <div className="mg-group">
      {/* 整行点开 / 收起；复选框与去向菜单各管各的，不冒泡到这里 */}
      <div className="mg-grow mg-grid-sessions" onClick={props.onToggleExpand}>
        <GroupLead
          label={t.migration.importSessionsFrom(groupName(group.folder, t))}
          picked={picked}
          total={group.rows.length}
          expanded={props.expanded}
          disabled={props.disabled}
          onSet={(on) => props.onSetRows(group.rows, on)}
          onToggleExpand={props.onToggleExpand}
        />
        <span className="mg-gcopy">
          <span className="mg-gname">
            <Icon name={group.folder === null ? "list" : "folder"} size={14} strokeWidth={1.8} />
            <span className="mg-name">{groupName(group.folder, t)}</span>
            <span className="mg-meta">{sourceBreakdown(group.bySource, t)}</span>
          </span>
          {group.folder !== null && (
            <span className="mg-gpath" title={group.folder}>
              {abbreviateHome(group.folder, props.home)}
            </span>
          )}
        </span>
        <PickedCount picked={picked} total={group.rows.length} />
        {subSessions > 0 ? (
          <Tipped className="mg-sub" tip={t.migration.subSessionsComeWithParents}>
            <Icon name="git-fork" size={11} strokeWidth={1.8} />
            {subSessions}
          </Tipped>
        ) : (
          <span />
        )}
        <span className="mg-dest" onClick={(event) => event.stopPropagation()}>
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
                title={t.migration.destinationTip}
                onClick={toggle}
              >
                {destinationLabel(props.destination, props.workspaces, t)}
              </Chip>
            )}
          />
        </span>
      </div>

      {props.expanded && (
        <div className="mg-kids">
          {visibleRows.map((row) => (
            <SessionLine
              key={row.item.sourceFile}
              row={row}
              now={props.now}
              showSource={showSource}
              checked={props.selected.has(row.item.sourceFile)}
              disabled={props.disabled}
              onToggle={(on) => props.onSetRows([row], on)}
            />
          ))}
          {group.rows.length > ROWS_BEFORE_MORE && (
            <div className="mg-more">
              <button type="button" className="mg-textbtn" onClick={props.onShowAll}>
                {props.showAll ? t.migration.showFewer : t.migration.showMore(group.rows.length - ROWS_BEFORE_MORE)}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const BADGE_ICON: Record<ChangeBadge["kind"], IconName> = {
  updated: "message-square",
  diverged: "git-branch",
  deleted: "trash-2",
};

function SessionLine(props: {
  row: SessionRow;
  now: number;
  /** 块里不止一个来源时写出本条的来源 */
  showSource: boolean;
  checked: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
}) {
  const t = useT();
  const { item, subSessions } = props.row;
  const badge = changeBadge(item, t);
  return (
    <label className="mg-kid" data-off={!props.checked || undefined}>
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
        {props.showSource && <span className="mg-kid-source">{t.migration.sources[item.source]}</span>}
        <span className="mg-day">{formatDay(item.updatedAt, props.now)}</span>
        {badge !== null && (
          <TipBadge icon={BADGE_ICON[badge.kind]} tip={badge.tip} mono={badge.kind !== "deleted"}>
            {badge.text}
          </TipBadge>
        )}
        {item.archived && <TipBadge icon="archive" tip={t.migration.archivedIn(t.migration.sources[item.source])} label={t.migration.archived} />}
      </span>
      <span className="mg-trail">
        {subSessions > 0 && (
          <Tipped className="mg-sub" tip={t.migration.subSessionsComeWithIt}>
            <Icon name="git-fork" size={11} strokeWidth={1.8} />
            {subSessions}
          </Tipped>
        )}
        <Tipped className="mg-model" tip={modelTip(t)}>
          {item.importedModel ?? t.migration.unknownModel}
        </Tipped>
      </span>
    </label>
  );
}

/** 「只随手发了一句」检查的状态：没开 / 在问模型 / 判完（判中的不列、不导）/ 失败 */
type GreetingState =
  | { kind: "off" }
  | { kind: "checking" }
  | { kind: "on"; leaveOut: ReadonlySet<string>; checked: number; asked: number; model: string }
  /** reason 非空 = 主进程抛的稳定错误码（模型不可用），按码翻文案 */
  | { kind: "error"; reason: ImportGreetingUnavailable | null; message: string };

/** 主进程错误文本里的稳定码 → 不可用原因；不认识的码返回 null（照原文显示） */
function greetingUnavailableOf(text: string): ImportGreetingUnavailable | null {
  if (!text.startsWith(IMPORT_GREETING_UNAVAILABLE_CODE)) return null;
  const reason = text.slice(IMPORT_GREETING_UNAVAILABLE_CODE.length);
  return reason === "no-provider" || reason === "no-chore-model" ? reason : null;
}

/**
 * 列表上方的三步清单：「① 配置服务商 → ② 选家务活模型 → ③ 不导只随手发了一句
 * hi / test 的会话」。①② 的状态**每次渲染按当下的服务商与设置现算**（migration-page.ts
 * 的 greetingSteps），不吃扫描报告的旧值——用户从别处配完回来要立刻看到打勾
 * （wafo 2026-09-28 原话：我们设计的很体贴，用户感知不到还觉得懵逼——为什么这个
 * 小功能要麻烦我跳转两次；直接在迁移页可视化地告诉用户，你需要跳转两次）。
 * ①②未完成时整行是跳转（ Providers / General）；①没完成时②置灰（没有服务商
 * 就选不了家务活模型）；③只有①②都完成才可勾，写明用的是哪个模型。
 */
function GreetingChecklist(props: {
  plan: ImportGreetingCheckPlan;
  state: GreetingState;
  steps: GreetingStepsState;
  choreModel: ModelPair | undefined;
  disabled: boolean;
  onOpenProviders: () => void;
  onOpenGeneral: () => void;
  onToggle: (on: boolean) => void;
}) {
  const t = useT();
  const { plan, state, steps } = props;
  const ready = steps.provider && steps.chore;
  const sessions = t.migration.sessions(plan.candidates);
  // 显示的模型取实时设置（steps.chore 为真时必有值），不取扫描报告里的旧值
  const modelId = steps.chore ? props.choreModel?.modelId ?? null : null;
  let sub: React.ReactNode;
  if (state.kind === "checking") {
    sub = (
      <>
        <Icon name="loader-circle" size={11} spin />
        {t.migration.greetingAsking(modelId ?? t.migration.theModel, sessions)}
      </>
    );
  } else if (state.kind === "on") {
    sub = t.migration.greetingResult(state.checked, state.asked, state.model, state.leaveOut.size);
  } else if (state.kind === "error" && state.reason !== null) {
    // 主进程抛的稳定错误码（模型在扫描与点击之间被删）：按码翻文案，不念英文原文
    sub = (
      <span className="mg-error">
        {state.reason === "no-provider" ? t.migration.greetingNeedsProvider : t.migration.greetingPickChore}
      </span>
    );
  } else if (state.kind === "error") {
    sub = (
      <span className="mg-error">
        {t.migration.greetingFailed} {state.message}
      </span>
    );
  } else if (ready && plan.candidates === 0) {
    sub = t.migration.greetingNothing;
  } else if (ready) {
    sub = t.migration.greetingUsesChore(sessions, modelId ?? t.migration.theModel);
  }
  return (
    <div className="mg-greet" data-ready={ready || undefined}>
      <ol className="mg-prereq">
        <GreetingStep
          done={steps.provider}
          label={t.migration.greetingStepProvider}
          onJump={steps.provider ? undefined : props.onOpenProviders}
        />
        <GreetingStep
          done={steps.chore}
          label={t.migration.greetingStepChore}
          locked={!steps.provider}
          lockedTip={t.migration.greetingStepLockedTip}
          onJump={steps.provider && !steps.chore ? props.onOpenGeneral : undefined}
        />
      </ol>
      <label className="mg-greet-main" data-disabled={!ready || undefined}>
        <input
          type="checkbox"
          checked={state.kind === "checking" || state.kind === "on"}
          disabled={props.disabled || !ready || state.kind === "checking"}
          onChange={(event) => props.onToggle(event.target.checked)}
        />
        <span className="mg-greet-copy">
          <span className="mg-greet-title">{t.migration.greetingTitle}</span>
          <span className="mg-greet-sub">{sub}</span>
        </span>
      </label>
    </div>
  );
}

/** 清单里的一步：完成的打勾（success 色）；未完成的是跳转；①没完成时②置灰。 */
function GreetingStep(props: {
  done: boolean;
  label: string;
  locked?: boolean;
  lockedTip?: string;
  onJump?: () => void;
}) {
  const locked = props.locked === true;
  return (
    <li className="mg-prereq-item" data-done={props.done || undefined} data-locked={locked || undefined} title={locked ? props.lockedTip : undefined}>
      <Icon
        name={props.done ? "circle-check" : locked ? "circle-off" : "circle-dot"}
        size={12}
        strokeWidth={1.8}
      />
      {props.onJump !== undefined ? (
        <button type="button" className="mg-prereq-link" onClick={props.onJump}>
          {props.label}
          <Icon name="arrow-right" size={10} strokeWidth={1.8} />
        </button>
      ) : (
        <span className="mg-prereq-label">{props.label}</span>
      )}
    </li>
  );
}

const FACT_ICON: Record<SessionFactKind, IconName> = {
  hidden: "eye-off",
  greeting: "message-square-dashed",
  duplicate: "copy",
  orphaned: "git-fork",
  already: "circle-check",
  cannot: "circle-off",
};

/** 列表下面一行图标事实（被筛掉的、建议剔除的、已导入的、导不了的），整句进悬停。 */
function SessionFacts(props: {
  report: ImportScanReport;
  grouped: GroupedSessions;
  now: number;
  /** 重复项的「留下哪一份」路径缩成 ~ */
  home: string;
  /** 「只随手发了一句」检查判中、不列的会话（Details 里逐条列出，可以单条放回） */
  leftOut: readonly ImportPlanItem[];
  onKeep: (sourceFile: string) => void;
}) {
  const t = useT();
  const [details, setDetails] = useState<"cannot" | "greeting" | "duplicate" | null>(null);
  const facts = sessionFacts(props.report, props.grouped, props.now, t);
  const unconvertible = unconvertibleSkips(props.report);
  const duplicates = duplicateSkips(props.report);
  const toggle = (which: "cannot" | "greeting" | "duplicate"): void =>
    setDetails((open) => (open === which ? null : which));
  if (facts.length === 0) return null;
  return (
    <>
      <div className="mg-facts">
        {facts.map((fact) => (
          <Fact key={fact.kind} icon={FACT_ICON[fact.kind]} tip={fact.tip}>
            <b>{fact.count}</b>
            {fact.label}
            {fact.kind === "cannot" && unconvertible.length > 0 && (
              <button type="button" className="mg-link" aria-expanded={details === "cannot"} onClick={() => toggle("cannot")}>
                {details === "cannot" ? t.migration.hide : t.migration.details}
              </button>
            )}
            {fact.kind === "greeting" && props.leftOut.length > 0 && (
              <button type="button" className="mg-link" aria-expanded={details === "greeting"} onClick={() => toggle("greeting")}>
                {details === "greeting" ? t.migration.hide : t.migration.review}
              </button>
            )}
            {fact.kind === "duplicate" && (
              <button type="button" className="mg-link" aria-expanded={details === "duplicate"} onClick={() => toggle("duplicate")}>
                {details === "duplicate" ? t.migration.hide : t.migration.review}
              </button>
            )}
          </Fact>
        ))}
      </div>
      {details === "greeting" && props.leftOut.length > 0 && (
        <ul className="mg-skips">
          {props.leftOut.map((item) => (
            <li key={item.sourceFile}>
              <span className="mg-skip-title">{item.title}</span>
              <span className="mg-skip-why">{t.migration.sources[item.source]}</span>
              <button type="button" className="mg-textbtn" onClick={() => props.onKeep(item.sourceFile)}>
                {t.migration.keep}
              </button>
            </li>
          ))}
        </ul>
      )}
      {details === "duplicate" && (
        <ul className="mg-skips">
          {duplicates.slice(0, 30).map((skip, index) => (
            // 同一个会话 id 可能有好几份重复（几个数据根各一份），id 不唯一
            <li key={`${skip.sourceId}-${index}`}>
              <span className="mg-skip-title">{skip.title ?? skip.sourceId}</span>
              <span className="mg-skip-why">
                {skip.detail === undefined ? "" : t.migration.duplicateKept(abbreviateHome(skip.detail, props.home))}
              </span>
            </li>
          ))}
          {duplicates.length > 30 && <li className="mg-skip-why">{t.migration.andMore(duplicates.length - 30)}</li>}
        </ul>
      )}
      {details === "cannot" && (
        <ul className="mg-skips">
          {unconvertible.slice(0, 30).map((skip) => (
            <li key={skip.sourceId}>
              <span className="mg-skip-title">{skip.title ?? skip.sourceId}</span>
              <span className="mg-skip-why">{skip.detail ?? skip.reason}</span>
            </li>
          ))}
          {unconvertible.length > 30 && <li className="mg-skip-why">{t.migration.andMore(unconvertible.length - 30)}</li>}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// 5 Import（底栏）
// ---------------------------------------------------------------------------

const FOOT_ICON: Record<FootFactKind, IconName> = {
  sub: "git-fork",
  workspaces: "folder-plus",
  bytes: "hard-drive",
  skills: "book-open",
  mcp: "power",
};

function ImportFooter(props: {
  state: StepState;
  scanned: boolean;
  run: RunState;
  summary: ReturnType<typeof summarize> | null;
  /** 勾选的 skill 数 */
  skills: number;
  /** 勾选的 MCP server 数 */
  mcp: number;
  skillMode: ImportSkillMode;
  disabled: boolean;
  onImport: () => void;
}) {
  const t = useT();
  const { run, summary } = props;
  const importButton = (label: string, busy: boolean) => (
    <button type="button" className="btn-accent mg-btn mg-btn-primary" disabled={props.disabled || busy} onClick={props.onImport}>
      <Icon name={busy ? "loader-circle" : "download"} size={13} spin={busy} />
      {label}
    </button>
  );

  let copy: React.ReactNode;
  let action: React.ReactNode = importButton(t.migration.import, false);
  if (run.kind === "running") {
    copy = (
      <>
        <span className="mg-foot-main">{runningHeadline(run.sessions, run.skills, run.mcp, t)}</span>
        <span className="mg-foot-sub">
          <FootFact icon="hard-drive" tip={t.migration.copyingTip}>
            {t.migration.copying}
          </FootFact>
        </span>
      </>
    );
    action = importButton(t.migration.importing, true);
  } else if (run.kind === "done") {
    const facts = doneFacts(run.result, t);
    copy = (
      <>
        <span className="mg-foot-main" role="status">
          <span className="mg-ok">
            <Icon name="circle-check" size={15} />
          </span>
          {doneHeadline(run.result, t)}
        </span>
        {facts.length > 0 && (
          <span className="mg-foot-sub">
            {facts.map((fact, index) => (
              <FootFact
                key={index}
                icon={fact.kind === "sidebar" ? "panel-left" : "triangle-alert"}
                tone={fact.kind === "failed" ? "danger" : undefined}
                tip={fact.tip}
              >
                {fact.text}
              </FootFact>
            ))}
          </span>
        )}
      </>
    );
    action = null;
  } else if (run.kind === "error") {
    copy = (
      <>
        <span className="mg-foot-main mg-error">
          <Icon name="triangle-alert" size={13} />
          {t.migration.importFailed}
        </span>
        <span className="mg-foot-sub mg-foot-msg">{run.message}</span>
      </>
    );
  } else if (!props.scanned || summary === null) {
    copy = <span className="mg-foot-main mg-dim">{t.migration.import}</span>;
  } else {
    const total = summary.sessions + summary.updates + props.skills + props.mcp;
    const facts = footFacts(summary, props.skills, props.skillMode, props.mcp, t);
    copy = (
      <>
        <span className={total === 0 ? "mg-foot-main mg-dim" : "mg-foot-main"}>
          {headline(summary.sessions, summary.updates, props.skills, props.mcp, t)}
        </span>
        {facts.length > 0 && (
          <span className="mg-foot-sub">
            {facts.map((fact) => (
              <FootFact key={fact.kind} icon={FOOT_ICON[fact.kind]} tip={fact.tip}>
                {fact.text}
              </FootFact>
            ))}
          </span>
        )}
      </>
    );
  }

  return (
    <footer className="mg-foot">
      <div className="mg-foot-inner">
        <StepDot n={5} state={props.state} />
        <span className="mg-foot-copy">{copy}</span>
        {action}
      </div>
    </footer>
  );
}
