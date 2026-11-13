import "./migration-view.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExternalSourceInfo, ExternalSourcesResult } from "@shared/external-sources";
import type {
  ImportConfigProbe,
  ImportDetectResult,
  ImportRunReport,
  ImportScanReport,
  ImportSkillItem,
  ImportSkillMode,
  ImportSkillScope,
  ImportSourceId,
} from "@shared/import";
import type { SettingsPatch } from "@shared/settings";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { Icon, type IconName } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { CustomRootsSection } from "./CustomRootsSection.tsx";
import { abbreviateHome, middleEllipsis } from "./display-format.ts";
import {
  doneFacts,
  doneHeadline,
  footFacts,
  headline,
  noneFound,
  runningHeadline,
  sourceRowState,
  stepStates,
  switchesAfter,
  type FootFactKind,
  type StepState,
} from "./external-sources-page.ts";
import { McpSection } from "./MigrationMcp.tsx";
import { SkillsSection } from "./MigrationSkills.tsx";
import { FootFact, Step, TipBadge } from "./MigrationStep.tsx";
import { defaultMcpSelection, isSelectableMcp, selectedMcpNames } from "./migration-mcp.ts";
import {
  countSelectedSkills,
  DEFAULT_SKILL_SCOPE,
  defaultSkillSelection,
  sameSkillScope,
  selectableSkills,
  selectedSkillDirs,
  skillScopeChoices,
} from "./migration-skills.ts";
import { Switch } from "./SettingControls";

/**
 * 设置 › 外部来源（原「迁移」页，2026-11 聊天记录导入退场后改成这样）。两块，各管各的：
 *
 * 1. 「别的工具里的聊天记录」：常驻的状态清单，不编号。八个支持的工具各一行（没发现的也列，写明
 *    去哪里找过），每行名字、会话数、数据目录、开关。**只读**——read_task 在原位读，不复制进来；
 *    开关只管智能体能不能读这个工具的聊天记录。下面是手动加数据目录。
 * 2. 「从别的工具导入技能与 MCP」：配置复制一次就对，照 origin/main 迁移页的做法——
 *    1 来源（勾选；先列出扫描会读的全部路径，没勾的一个字节都不读）→ 2 技能 → 3 MCP → 4 导入。
 *    导入键在这一块里面，不粘在整页底栏（看聊天记录清单时视野里不该有「导入」）。
 */

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; result: ExternalSourcesResult }
  | { kind: "error"; message: string };

type DetectState =
  | { kind: "loading" }
  | { kind: "ready"; result: ImportDetectResult }
  | { kind: "error"; message: string };

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "ready"; report: ImportScanReport; sources: ImportSourceId[] }
  | { kind: "error"; message: string };

type RunState =
  | { kind: "idle" }
  | { kind: "running"; skills: number; mcp: number }
  | { kind: "done"; result: ImportRunReport }
  | { kind: "error"; message: string };

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function toggled<T>(set: ReadonlySet<T>, key: T): Set<T> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

export function ExternalSourcesView(props: {
  workspaces: readonly Workspace[];
  /** 开关写进设置（与别的设置页同一条路，App 的设置状态随之更新） */
  onSettingsChange: (patch: SettingsPatch) => void;
}) {
  const t = useT();
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [detect, setDetect] = useState<DetectState>({ kind: "loading" });
  const [ticked, setTicked] = useState<ReadonlySet<ImportSourceId>>(new Set());
  const [scan, setScan] = useState<ScanState>({ kind: "idle" });
  const [run, setRun] = useState<RunState>({ kind: "idle" });
  const [skillSelected, setSkillSelected] = useState<ReadonlySet<string>>(new Set());
  const [skillMode, setSkillMode] = useState<ImportSkillMode>("copy");
  const [skillScopes, setSkillScopes] = useState<ReadonlyMap<string, ImportSkillScope>>(new Map());
  const [skillExpanded, setSkillExpanded] = useState<ReadonlySet<string>>(new Set());
  const [skillShowAll, setSkillShowAll] = useState<ReadonlySet<string>>(new Set());
  const [mcpSelected, setMcpSelected] = useState<ReadonlySet<string>>(new Set());

  /** first = 首次打开（出 loading 态）；之后的刷新（开关、加 / 删目录）保留旧结果，避免整页闪 */
  const load = useCallback((first: boolean) => {
    if (first) {
      setList({ kind: "loading" });
      setDetect({ kind: "loading" });
    }
    let cancelled = false;
    void api.externalSources
      .list()
      .then((result) => {
        if (!cancelled) setList({ kind: "ready", result });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setList({ kind: "error", message: errorText(cause) });
      });
    // 技能 / MCP 的来源与会读的路径：只 stat（自定义目录变了也要重探）
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
  useEffect(() => load(true), [load]);

  const home = list.kind === "ready" ? list.result.home : detect.kind === "ready" ? detect.result.home : "";
  const busy = scan.kind === "scanning" || run.kind === "running";
  // 任何改选择的动作都让「已导入 …」退场：那是上一次的结果，不是眼前这份勾选的
  const touch = useCallback(() => setRun((current) => (current.kind === "done" ? { kind: "idle" } : current)), []);

  const setSourceEnabled = (source: ExternalSourceInfo, enabled: boolean): void => {
    if (list.kind !== "ready") return;
    const sources = list.result.sources;
    // 先在页面上翻过去（开关即时响应），再落设置
    setList({ kind: "ready", result: { ...list.result, sources: sources.map((item) => (item.id === source.id ? { ...item, enabled } : item)) } });
    props.onSettingsChange({ externalSources: switchesAfter(sources, source.id, enabled) });
  };

  const startScan = useCallback((sources: ImportSourceId[], keepRun: boolean) => {
    setScan({ kind: "scanning" });
    if (!keepRun) setRun({ kind: "idle" });
    void api.import
      .scan({ sources })
      .then((report) => {
        setScan({ kind: "ready", report, sources });
        setSkillSelected(defaultSkillSelection(report.skills));
        setSkillScopes(new Map());
        setSkillExpanded(new Set());
        setSkillShowAll(new Set());
        setMcpSelected(defaultMcpSelection(report.mcp));
      })
      .catch((cause: unknown) => setScan({ kind: "error", message: errorText(cause) }));
  }, []);

  const skillCount = scan.kind === "ready" ? countSelectedSkills(scan.report.skills, skillSelected) : 0;
  const mcpCount = scan.kind === "ready" ? selectedMcpNames(scan.report.mcp, mcpSelected).length : 0;
  const importable =
    scan.kind === "ready"
      ? scan.report.skills.reduce((sum, group) => sum + selectableSkills(group).length, 0) + scan.report.mcp.filter(isSelectableMcp).length
      : 0;
  const steps = stepStates({
    scanned: scan.kind === "ready",
    imported: run.kind === "done",
    hasSkills: scan.kind === "ready" && scan.report.skills.some((group) => selectableSkills(group).length > 0),
    hasMcp: scan.kind === "ready" && scan.report.mcp.some(isSelectableMcp),
  });

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
    if (scan.kind !== "ready" || skillCount + mcpCount === 0) return;
    const sources = scan.sources;
    setRun({ kind: "running", skills: skillCount, mcp: mcpCount });
    void api.import
      .run({
        sources,
        skills: selectedSkillDirs(scan.report.skills, skillSelected),
        skillMode,
        skillScopes: skillScopeChoices(skillScopes),
        mcp: selectedMcpNames(scan.report.mcp, mcpSelected),
      })
      .then((result) => {
        setRun({ kind: "done", result });
        // 导进来的不再列：按同样的来源重扫，保住「已导入 …」那一行
        startScan(sources, true);
      })
      .catch((cause: unknown) => setRun({ kind: "error", message: errorText(cause) }));
  };

  const probes = detect.kind === "ready" ? detect.result.sources : [];

  return (
    <div className="mg">
      <div className="mg-scroll scroll">
        <div className="mg-col">
          <ChatSources list={list} home={home} busy={busy} onToggle={setSourceEnabled} onCustomRootsChanged={() => load(false)} />

          <section className="ext-block" aria-label={t.externalSources.configTitle}>
            <header className="ext-block-head">
              <h2 className="ext-block-title">{t.externalSources.configTitle}</h2>
            </header>
            <p className="mg-caption mg-caption-lead">
              <Icon name="eye" size={12} strokeWidth={1.8} />
              {t.externalSources.configLead}
            </p>
            <div className="ext-steps">
              <ConfigSourcesStep
                state={steps.sources}
                detect={detect}
                probes={probes}
                home={home}
                ticked={ticked}
                scanning={scan.kind === "scanning"}
                scanned={scan.kind === "ready"}
                busy={busy}
                onToggle={(id) => {
                  touch();
                  setTicked((current) => toggled(current, id));
                }}
                onTickAll={() => setTicked(new Set(probes.filter((probe) => probe.found).map((probe) => probe.id)))}
                onScan={() => startScan([...ticked], false)}
                error={scan.kind === "error" ? scan.message : null}
              />
              <SkillsSection
                n={2}
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
              <McpSection
                n={3}
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
              <ImportStep
                state={steps.import}
                scanned={scan.kind === "ready"}
                importable={importable}
                run={run}
                skills={skillCount}
                mcp={mcpCount}
                skillMode={skillMode}
                disabled={busy || skillCount + mcpCount === 0}
                onImport={startRun}
              />
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 上块：别的工具里的聊天记录（常驻清单，不编号）
// ---------------------------------------------------------------------------

function ChatSources(props: {
  list: ListState;
  home: string;
  busy: boolean;
  onToggle: (source: ExternalSourceInfo, enabled: boolean) => void;
  onCustomRootsChanged: () => void;
}) {
  const t = useT();
  const { list } = props;
  return (
    <section className="ext-block" aria-label={t.externalSources.stepTitle}>
      <header className="ext-block-head">
        <h2 className="ext-block-title">{t.externalSources.stepTitle}</h2>
        <TipBadge icon="lock" tip={t.externalSources.readOnlyTip} focusable>
          {t.migration.readOnly}
        </TipBadge>
      </header>
      {list.kind === "loading" && (
        <p className="mg-caption">
          <Icon name="loader-circle" size={12} spin /> {t.externalSources.loading}
        </p>
      )}
      {list.kind === "error" && (
        <p className="mg-caption mg-error">
          <Icon name="triangle-alert" size={12} />
          {t.externalSources.loadFailed} {list.message}
        </p>
      )}
      {list.kind === "ready" && (
        <>
          <p className="mg-caption mg-caption-lead">
            <Icon name="eye" size={12} strokeWidth={1.8} />
            {t.externalSources.lead} {t.externalSources.chatSwitchNote}
          </p>
          {noneFound(list.result.sources) && (
            <p className="mg-caption">
              <Icon name="circle-off" size={12} strokeWidth={1.8} />
              {t.externalSources.noneFound} {t.externalSources.noneFoundHint}
            </p>
          )}
          {/* 没发现的也列：用户要知道支持哪些工具、各自去哪里找过 */}
          <div className="mg-block ext-list">
            {list.result.sources.map((source) => (
              <SourceRow key={source.id} source={source} home={props.home} disabled={props.busy} onToggle={props.onToggle} />
            ))}
          </div>
          <CustomRootsSection
            roots={list.result.customRoots}
            home={props.home}
            disabled={props.busy}
            onChanged={props.onCustomRootsChanged}
          />
        </>
      )}
    </section>
  );
}

function SourceRow(props: {
  source: ExternalSourceInfo;
  home: string;
  disabled: boolean;
  onToggle: (source: ExternalSourceInfo, enabled: boolean) => void;
}) {
  const t = useT();
  const { source } = props;
  const state = sourceRowState(source);
  const name = t.externalSources.sources[source.id];
  return (
    <div className="ext-src" data-missing={state.kind !== "found" || undefined} data-off={!source.enabled || undefined}>
      <div className="ext-src-head">
        <span className="mg-line1">
          <span className="mg-name">{name}</span>
          {state.kind === "found" && (
            <span className="mg-count">
              {source.enabled ? t.externalSources.sessions(state.sessions) : t.externalSources.offNote(state.sessions)}
            </span>
          )}
        </span>
        {state.kind === "found" ? (
          <span className="row-trailing">
            <Switch
              label={t.externalSources.switchLabel(name)}
              checked={source.enabled}
              disabled={props.disabled}
              onChange={(next) => props.onToggle(source, next)}
            />
          </span>
        ) : (
          <span className="mg-status row-trailing">
            {/* 两种状态各一个图标（图标是第一信号）：目录在、空的 = 打开的空文件夹；没找到 = 禁用圈 */}
            <Icon name={state.kind === "empty-dir" ? "folder-open" : "circle-off"} size={12} strokeWidth={1.8} />
            {state.kind === "empty-dir" ? t.externalSources.dirNoSessions : t.externalSources.notFound}
          </span>
        )}
      </div>
      <ul className="ext-paths" aria-label={t.externalSources.pathsFor(name)}>
        {source.roots.length > 0 ? (
          source.roots.map((root) => (
            <li key={root.dir} className="mg-path-line" data-warn={!root.hasData || undefined} title={root.dir}>
              <Icon name={root.hasData ? "folder" : "triangle-alert"} size={11} strokeWidth={1.8} />
              <span className="ext-path">{middleEllipsis(abbreviateHome(root.dir, props.home))}</span>
              {root.custom && <span className="ext-tag">{t.externalSources.addedByYou}</span>}
              {!root.hasData && <span className="ext-note">{t.externalSources.noData}</span>}
            </li>
          ))
        ) : (
          <li className="mg-path-line" title={source.expected}>
            <Icon name="folder" size={11} strokeWidth={1.8} />
            {state.kind === "missing" && <span className="ext-note">{t.externalSources.lookedIn}</span>}
            <span className="ext-path">{middleEllipsis(abbreviateHome(source.expected, props.home))}</span>
          </li>
        )}
        {source.problems.map((problem) => (
          <li key={problem} className="mg-path-line" data-warn title={problem}>
            <Icon name="triangle-alert" size={11} strokeWidth={1.8} />
            <span className="ext-note">{problem}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 下块第 1 步：来源（勾选；先列出扫描会读的全部路径）
// ---------------------------------------------------------------------------

/** 路径清单里每一行的图标：JSON 文件 / 其他文件 / 目录（含 `*` 通配的目录） */
function pathIcon(path: string): IconName {
  if (/\.json$/i.test(path)) return "file-json-2";
  if (/\.[a-z0-9]+$/i.test(path) && !path.includes("*")) return "file";
  return "folder";
}

function ConfigSourcesStep(props: {
  state: StepState;
  detect: DetectState;
  probes: readonly ImportConfigProbe[];
  home: string;
  ticked: ReadonlySet<ImportSourceId>;
  scanning: boolean;
  scanned: boolean;
  busy: boolean;
  error: string | null;
  onToggle: (id: ImportSourceId) => void;
  onTickAll: () => void;
  onScan: () => void;
}) {
  const t = useT();
  const canTickMore = props.probes.some((probe) => probe.found && !props.ticked.has(probe.id));
  return (
    <Step
      n={1}
      title={t.externalSources.stepSources}
      state={props.state}
      tools={
        <span className="mg-tools">
          {canTickMore && (
            <button type="button" className="mg-textbtn" disabled={props.busy} onClick={props.onTickAll}>
              {t.externalSources.tickAllFound}
            </button>
          )}
          <button
            type="button"
            className="quiet-control mg-btn"
            disabled={props.busy || props.ticked.size === 0}
            title={props.ticked.size === 0 ? t.externalSources.tickToScan : undefined}
            onClick={props.onScan}
          >
            <Icon name={props.scanning ? "loader-circle" : props.scanned ? "refresh-cw" : "search"} size={12} spin={props.scanning} />
            {props.scanning ? t.migration.scanning : props.scanned ? t.migration.rescan : t.externalSources.scan}
          </button>
        </span>
      }
    >
      {props.detect.kind === "loading" && (
        <p className="mg-caption">
          <Icon name="loader-circle" size={12} spin /> {t.externalSources.loading}
        </p>
      )}
      {props.detect.kind === "error" && (
        <p className="mg-caption mg-error">
          <Icon name="triangle-alert" size={12} />
          {t.externalSources.loadFailed} {props.detect.message}
        </p>
      )}
      {props.detect.kind === "ready" && (
        <>
          <p className="mg-caption mg-caption-lead">
            <Icon name="eye" size={12} strokeWidth={1.8} />
            {t.externalSources.pathsNote}
          </p>
          <div className="mg-block">
            {props.probes.map((probe) => (
              <div className="mg-src" key={probe.id} data-disabled={!probe.found || undefined}>
                <label className="mg-src-head">
                  <input
                    type="checkbox"
                    checked={props.ticked.has(probe.id)}
                    disabled={props.busy || !probe.found}
                    onChange={() => props.onToggle(probe.id)}
                  />
                  <span className="mg-line1">
                    <span className="mg-name">{t.migration.sources[probe.id]}</span>
                  </span>
                  <span className="mg-trail">
                    {probe.found ? (
                      <span className="mg-status">
                        <Icon name="circle-check" size={12} strokeWidth={1.8} />
                        {t.externalSources.configFound}
                      </span>
                    ) : (
                      <span className="mg-status">
                        <Icon name="circle-off" size={12} strokeWidth={1.8} />
                        {t.externalSources.configNotFound}
                      </span>
                    )}
                  </span>
                </label>
                {/* 路径清单竖排、常驻：这就是事前披露，不收进悬停 */}
                <ul className="mg-paths" aria-label={t.externalSources.pathsFor(t.migration.sources[probe.id])}>
                  {probe.paths.map((path) => (
                    <li key={path} className="mg-path-line" title={path}>
                      <Icon name={pathIcon(path)} size={11} strokeWidth={1.8} />
                      <span>{abbreviateHome(path, props.home)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
      {props.error !== null && (
        <p className="mg-caption mg-error">
          <Icon name="triangle-alert" size={12} />
          {t.migration.scanFailed} {props.error}
        </p>
      )}
    </Step>
  );
}

// ---------------------------------------------------------------------------
// 下块第 4 步：导入（在块里面，不粘底）
// ---------------------------------------------------------------------------

const FOOT_ICON: Record<FootFactKind, "book-open" | "power"> = { skills: "book-open", mcp: "power" };

function ImportStep(props: {
  state: StepState;
  scanned: boolean;
  importable: number;
  run: RunState;
  skills: number;
  mcp: number;
  skillMode: ImportSkillMode;
  disabled: boolean;
  onImport: () => void;
}) {
  const t = useT();
  const { run } = props;
  const facts = useMemo(() => footFacts(props.skills, props.skillMode, props.mcp, t), [props.skills, props.skillMode, props.mcp, t]);
  const busy = run.kind === "running";
  const button = (
    <button type="button" className="btn-accent mg-btn mg-btn-primary" disabled={props.disabled || busy} onClick={props.onImport}>
      <Icon name={busy ? "loader-circle" : "download"} size={13} spin={busy} />
      {busy ? t.migration.importing : t.externalSources.importButton}
    </button>
  );

  let main: React.ReactNode;
  let sub: React.ReactNode = null;
  if (run.kind === "running") {
    main = <span className="ext-import-main">{runningHeadline(run.skills, run.mcp, t)}</span>;
  } else if (run.kind === "done") {
    const failed = doneFacts(run.result, t);
    main = (
      <span className="ext-import-main" role="status">
        <span className="mg-ok">
          <Icon name="circle-check" size={14} />
        </span>
        {doneHeadline(run.result, t)}
      </span>
    );
    if (failed.length > 0) {
      sub = failed.map((fact) => (
        <FootFact key={fact.text} icon="triangle-alert" tone="danger" tip={fact.tip}>
          {fact.text}
        </FootFact>
      ));
    }
  } else if (run.kind === "error") {
    main = (
      <span className="ext-import-main mg-error">
        <Icon name="triangle-alert" size={13} />
        {t.migration.importFailed}
      </span>
    );
    sub = <span className="mg-foot-msg">{run.message}</span>;
  } else {
    const dim = !props.scanned || props.importable === 0 || props.skills + props.mcp === 0;
    main = (
      <span className={dim ? "ext-import-main mg-dim" : "ext-import-main"}>
        {headline({ scanned: props.scanned, importable: props.importable, skills: props.skills, mcp: props.mcp }, t)}
      </span>
    );
    if (facts.length > 0) {
      sub = facts.map((fact) => (
        <FootFact key={fact.kind} icon={FOOT_ICON[fact.kind]} tip={fact.tip}>
          {fact.text}
        </FootFact>
      ));
    }
  }

  return (
    <Step n={4} title={t.externalSources.stepImport} state={props.state} tools={run.kind === "done" ? null : button}>
      <div className="ext-import">
        {main}
        {sub !== null && <span className="mg-foot-sub">{sub}</span>}
      </div>
    </Step>
  );
}
