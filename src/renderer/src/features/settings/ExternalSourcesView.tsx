import "./migration-view.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ExternalSourceInfo, ExternalSourcesResult } from "@shared/external-sources";
import type { ImportRunReport, ImportScanReport, ImportSkillItem, ImportSkillMode, ImportSkillScope } from "@shared/import";
import type { SettingsPatch } from "@shared/settings";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { useT } from "../../locale.ts";
import { CustomRootsSection } from "./CustomRootsSection.tsx";
import { abbreviateHome } from "./display-format.ts";
import {
  CONFIG_SOURCES,
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
import { FootFact, Step, StepDot, TipBadge } from "./MigrationStep.tsx";
import { defaultMcpSelection, selectedMcpNames } from "./migration-mcp.ts";
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
 * 设置 › 外部来源（原「迁移」页，2026-11 导入聊天记录退场后改成这样）。四步铺在同一页：
 *
 *   1 别的工具里的聊天记录  每个来源一行：名字、会话数、数据目录、开关。**只读**——read_task 在原位
 *                          读，不复制进 Orbita；关掉的来源 read_task 不列也不读。下面是手动加数据目录。
 *   2 Skills / 3 MCP       从别的工具导入配置（复制一次就对），扫描、勾选照旧。
 *   4 Import（底栏）        只导技能与 MCP。
 */

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; result: ExternalSourcesResult }
  | { kind: "error"; message: string };

type ScanState =
  | { kind: "idle" }
  | { kind: "scanning" }
  | { kind: "ready"; report: ImportScanReport }
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
    if (first) setList({ kind: "loading" });
    let cancelled = false;
    void api.externalSources
      .list()
      .then((result) => {
        if (!cancelled) setList({ kind: "ready", result });
      })
      .catch((cause: unknown) => {
        if (!cancelled) setList({ kind: "error", message: errorText(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  useEffect(() => load(true), [load]);

  const home = list.kind === "ready" ? list.result.home : "";
  const busy = scan.kind === "scanning" || run.kind === "running";
  // 任何改选择的动作都让「Imported …」退场：那是上一次的结果，不是眼前这份勾选的
  const touch = useCallback(() => setRun((current) => (current.kind === "done" ? { kind: "idle" } : current)), []);

  const setSourceEnabled = (source: ExternalSourceInfo, enabled: boolean): void => {
    if (list.kind !== "ready") return;
    const sources = list.result.sources;
    // 先在页面上翻过去（开关即时响应），再落设置、重新列一遍
    setList({ kind: "ready", result: { ...list.result, sources: sources.map((item) => (item.id === source.id ? { ...item, enabled } : item)) } });
    props.onSettingsChange({ externalSources: switchesAfter(sources, source.id, enabled) });
  };

  const startScan = useCallback((keepRun: boolean) => {
    setScan({ kind: "scanning" });
    if (!keepRun) setRun({ kind: "idle" });
    void api.import
      .scan({ sources: [...CONFIG_SOURCES] })
      .then((report) => {
        setScan({ kind: "ready", report });
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
  const steps = stepStates({
    listed: list.kind === "ready",
    scanned: scan.kind === "ready",
    imported: run.kind === "done",
    hasSkills: scan.kind === "ready" && scan.report.skills.some((group) => selectableSkills(group).length > 0),
    hasMcp: scan.kind === "ready" && scan.report.mcp.some((item) => item.status === "new"),
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
    setRun({ kind: "running", skills: skillCount, mcp: mcpCount });
    void api.import
      .run({
        sources: [...CONFIG_SOURCES],
        skills: selectedSkillDirs(scan.report.skills, skillSelected),
        skillMode,
        skillScopes: skillScopeChoices(skillScopes),
        mcp: selectedMcpNames(scan.report.mcp, mcpSelected),
      })
      .then((result) => {
        setRun({ kind: "done", result });
        // 导进来的不再列：重扫，保住「Imported …」那一行
        startScan(true);
      })
      .catch((cause: unknown) => setRun({ kind: "error", message: errorText(cause) }));
  };

  const scanButton = (
    <button type="button" className="quiet-control mg-btn" disabled={busy} onClick={() => startScan(false)}>
      <Icon
        name={scan.kind === "scanning" ? "loader-circle" : scan.kind === "ready" ? "refresh-cw" : "search"}
        size={12}
        spin={scan.kind === "scanning"}
      />
      {scan.kind === "scanning" ? t.migration.scanning : scan.kind === "ready" ? t.migration.rescan : t.externalSources.scanConfig}
    </button>
  );

  return (
    <div className="mg">
      <div className="mg-scroll scroll">
        <div className="mg-col">
          <SourcesStep
            state={steps.sources}
            list={list}
            home={home}
            busy={busy}
            onToggle={setSourceEnabled}
            onCustomRootsChanged={() => load(false)}
          />

          <SkillsSection
            n={2}
            state={steps.skills}
            scan={scanButton}
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
          {scan.kind === "error" && (
            <p className="mg-caption mg-error">
              <Icon name="triangle-alert" size={12} />
              {t.migration.scanFailed} {scan.message}
            </p>
          )}

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
        </div>
      </div>

      <ImportFooter
        state={steps.import}
        scanned={scan.kind === "ready"}
        run={run}
        skills={skillCount}
        mcp={mcpCount}
        skillMode={skillMode}
        disabled={busy || skillCount + mcpCount === 0}
        onImport={startRun}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 1 别的工具里的聊天记录
// ---------------------------------------------------------------------------

function SourcesStep(props: {
  state: StepState;
  list: ListState;
  home: string;
  busy: boolean;
  onToggle: (source: ExternalSourceInfo, enabled: boolean) => void;
  onCustomRootsChanged: () => void;
}) {
  const t = useT();
  const { list } = props;
  return (
    <Step
      n={1}
      title={t.externalSources.stepTitle}
      state={props.state}
      summary={
        <span className="mg-step-sum">
          <TipBadge icon="lock" tip={t.externalSources.readOnlyTip} focusable>
            {t.migration.readOnly}
          </TipBadge>
        </span>
      }
    >
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
            {t.externalSources.lead}
          </p>
          {noneFound(list.result.sources) ? (
            <div className="mg-block">
              <PanelEmpty icon="circle-off" className="mg-empty" hint={t.externalSources.noneFoundHint}>
                {t.externalSources.noneFound}
              </PanelEmpty>
            </div>
          ) : (
            <div className="mg-block ext-list">
              {list.result.sources.map((source) => (
                <SourceRow key={source.id} source={source} home={props.home} disabled={props.busy} onToggle={props.onToggle} />
              ))}
            </div>
          )}
          <CustomRootsSection
            roots={list.result.customRoots}
            home={props.home}
            disabled={props.busy}
            onChanged={props.onCustomRootsChanged}
          />
        </>
      )}
    </Step>
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
    <div className="ext-src" data-missing={state.kind === "missing" || undefined} data-off={!source.enabled || undefined}>
      <div className="ext-src-head">
        <span className="mg-line1">
          <span className="mg-name">{name}</span>
          {state.kind === "found" && (
            <span className="mg-count">
              {source.enabled ? t.externalSources.sessions(state.sessions) : t.externalSources.offNote(state.sessions)}
            </span>
          )}
        </span>
        {state.kind === "missing" ? (
          <span className="mg-status row-trailing">
            <Icon name="circle-off" size={12} strokeWidth={1.8} />
            {t.externalSources.notFound}
          </span>
        ) : (
          <span className="row-trailing">
            <Switch
              label={t.externalSources.switchLabel(name)}
              checked={source.enabled}
              disabled={props.disabled}
              onChange={(next) => props.onToggle(source, next)}
            />
          </span>
        )}
      </div>
      <ul className="ext-paths" aria-label={t.externalSources.pathsFor(name)}>
        {state.kind === "missing" ? (
          <li className="mg-path-line" title={source.expected}>
            <Icon name="folder" size={11} strokeWidth={1.8} />
            <span>
              <span className="ext-note">{t.externalSources.lookedIn}</span> {abbreviateHome(source.expected, props.home)}
            </span>
          </li>
        ) : (
          source.roots.map((root) => (
            <li key={root.dir} className="mg-path-line" data-warn={!root.hasData || undefined} title={root.dir}>
              <Icon name={root.hasData ? "folder" : "triangle-alert"} size={11} strokeWidth={1.8} />
              <span>
                {abbreviateHome(root.dir, props.home)}
                {root.custom && <span className="ext-note"> · {t.externalSources.addedByYou}</span>}
                {!root.hasData && <span className="ext-note"> · {t.externalSources.noData}</span>}
              </span>
            </li>
          ))
        )}
        {source.problems.map((problem) => (
          <li key={problem} className="mg-path-line" data-warn title={problem}>
            <Icon name="triangle-alert" size={11} strokeWidth={1.8} />
            <span>{problem}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4 Import（底栏，只导技能与 MCP）
// ---------------------------------------------------------------------------

const FOOT_ICON: Record<FootFactKind, "book-open" | "power"> = { skills: "book-open", mcp: "power" };

function ImportFooter(props: {
  state: StepState;
  scanned: boolean;
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
  const importButton = (label: string, busy: boolean) => (
    <button type="button" className="btn-accent mg-btn mg-btn-primary" disabled={props.disabled || busy} onClick={props.onImport}>
      <Icon name={busy ? "loader-circle" : "download"} size={13} spin={busy} />
      {label}
    </button>
  );

  let copy: React.ReactNode;
  let action: React.ReactNode = importButton(t.migration.import, false);
  if (run.kind === "running") {
    copy = <span className="mg-foot-main">{runningHeadline(run.skills, run.mcp, t)}</span>;
    action = importButton(t.migration.importing, true);
  } else if (run.kind === "done") {
    const failed = doneFacts(run.result, t);
    copy = (
      <>
        <span className="mg-foot-main" role="status">
          <span className="mg-ok">
            <Icon name="circle-check" size={15} />
          </span>
          {doneHeadline(run.result, t)}
        </span>
        {failed.length > 0 && (
          <span className="mg-foot-sub">
            {failed.map((fact) => (
              <FootFact key={fact.text} icon="triangle-alert" tone="danger" tip={fact.tip}>
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
  } else if (!props.scanned) {
    copy = <span className="mg-foot-main mg-dim">{t.externalSources.importHint}</span>;
  } else {
    copy = (
      <>
        <span className={props.skills + props.mcp === 0 ? "mg-foot-main mg-dim" : "mg-foot-main"}>
          {headline(props.skills, props.mcp, t)}
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
        <StepDot n={4} state={props.state} />
        <span className="mg-foot-copy">{copy}</span>
        {action}
      </div>
    </footer>
  );
}
