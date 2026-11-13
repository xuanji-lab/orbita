import { useEffect, useMemo, useState } from "react";
import "./automation.css";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import {
  PanelButton,
  PanelGroupHead,
  PanelHelp,
  PanelIconButton,
  PanelLine,
  PanelTitle,
  RightPanelFrame,
} from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import type { ProviderDto } from "@shared/provider";
import type { SessionMeta } from "@shared/session";
import type { Workspace } from "@shared/workspace";
import { AUTOMATION_ARCHIVE_KEEP, automationWorkspaceId, isFinished, type Automation, type AutomationAction } from "../../../../shared/automation.ts";
import { AutomationDetailView } from "./AutomationDetailView";
import { AutomationEditView, type AutomationSeed } from "./AutomationEditView";
import { AutomationRow } from "./AutomationRow";
import {
  AUTOMATION_TEMPLATES,
  groupAutomations,
  splitFinished,
  type AutomationGroup,
  type AutomationScope,
  type AutomationTemplate,
} from "./automation-view.ts";
import { sparkScale } from "./automation-spark.ts";
import { automationSubOf, resolveAutomationSub, type AutomationSub } from "../../shell/right-panel-memory.ts";
import { useReportSub } from "../../shell/use-report-sub.ts";
import type { AutomationsState } from "./useAutomations.ts";

/** 「N 分钟后」这类相对文案要跟着走：每分钟重算一次 now（面板开着才有这个定时器） */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs]);
  return now;
}

type View =
  | { kind: "list" }
  | { kind: "detail"; id: string }
  /** from = "detail"：从详情的「改设置」进来，保存 / 返回后回到那条的详情 */
  | { kind: "edit"; id: string | null; seed: AutomationSeed | null; from?: "detail" };

/**
 * 右栏「自动化」面板：列表 / 运行记录 / 新建与编辑子页 / 空态模板，
 * 底部常驻「有任务在跑时阻止系统睡眠」开关。入口在右栏 rail（MCP 之后），壳与宽度同 Skills / MCP。
 *
 * 分组：「本会话」（对话里建的、投回当前这条会话的）与「这个工作区」（其余）；范围切到「全部」按工作区各一组。
 * 自动化新开的会话**不进左侧栏**，收在各自那条自动化的运行记录下面，点一行在主区打开。
 */
export function AutomationPanel(props: {
  state: AutomationsState;
  /** 当前会话所在的工作区（null = Home）与名字 */
  workspaceId: string | null;
  workspaces: readonly Workspace[];
  /** 当前主槽的会话 id（首页 / 新任务占位为 null） */
  sessionId: string | null;
  sessions: readonly SessionMeta[];
  providers: readonly ProviderDto[];
  keepAwake: boolean;
  onKeepAwakeChange: (next: boolean) => void;
  /** 对话卡的「在右栏查看」：直接打开这一条的详情（nonce 递增，同一条重复点也生效） */
  focus: { id: string; nonce: number } | null;
  /**
   * 这次 focus 已经用掉：App 清回 null。不清的话面板每次重新挂载（关了右栏再点自动化）都会被
   * 同一个 focus 再拉进那条的详情——2026-11-06 用户报「不管在哪个会话点自动化，都回到同一条」。
   */
  onFocusConsumed: () => void;
  onOpenSession: (sessionId: string) => void;
  /** 「在这条会话里说一句」：往输入框预填一句引导 */
  onAskInChat: () => void;
  /**
   * 第二层（按会话记忆，right-panel-memory.ts）：看哪一条的详情、范围。只在挂载时读一次当初值
   * （App 按会话换 key 重挂）；之后经 onSubChange 报给 App。编辑页不记（表单里有没存的字）。
   */
  sub?: AutomationSub;
  onSubChange?: (sub: AutomationSub | undefined) => void;
}) {
  const t = useT();
  const a = t.automation;
  const { state } = props;
  const now = useNow(60_000);
  const [view, setView] = useState<View>(() => (props.sub?.detail === undefined ? { kind: "list" } : { kind: "detail", id: props.sub.detail }));
  const [scope, setScope] = useState<AutomationScope>(() => props.sub?.scope ?? "workspace");
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 「已结束」段默认折叠：已结束的是记录，不是要天天看的任务
  const [finishedOpen, setFinishedOpen] = useState(false);

  // 工作区被移除之后它名下的自动化还在（会话 id 同理）：组头如实说「已移除的工作区」，不留一个空标题
  const nameOf = (id: string | null): string =>
    id === null ? a.homeName : (props.workspaces.find((w) => w.id === id)?.name ?? a.removedWorkspace);
  const workspaceName = nameOf(props.workspaceId);
  const sessionById = useMemo(() => new Map(props.sessions.map((meta) => [meta.id, meta])), [props.sessions]);
  const knownSessionIds = useMemo(() => new Set(props.sessions.map((meta) => meta.id)), [props.sessions]);

  // 从对话卡跳来：直接打开那一条的详情（它不在当前范围里就把范围切到「全部」，返回列表时看得到它）
  useEffect(() => {
    if (props.focus === null) return;
    const target = state.automations.find((automation) => automation.id === props.focus?.id);
    // 一次性：用完就让 App 清掉（见 onFocusConsumed）
    props.onFocusConsumed();
    setMenuOpen(false);
    if (target === undefined) {
      setView({ kind: "list" });
      return;
    }
    if (automationWorkspaceId(target) !== props.workspaceId) setScope("all");
    // 看的是已结束的：退回列表时它所在的「已结束」段已经是展开的，不用再找
    if (isFinished(target)) setFinishedOpen(true);
    setView({ kind: "detail", id: target.id });
    // focus 的 nonce 变了才重来；列表刷新不该把详情再打开一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce]);

  // 把第二层报给 App：详情里的那一条（编辑页退回它来源的那一层：从详情进的回详情，新建回列表）、范围。
  // 详情指向的那一条不在了（别处删的 / 重启后已不存在）：列表读回来后按「回列表」报（resolveAutomationSub），面板自己也渲染成回列表
  const detailId = view.kind === "detail" || (view.kind === "edit" && view.from === "detail") ? view.id : null;
  const knownIds = useMemo(
    () => (state.load.kind === "ready" ? new Set(state.automations.map((automation) => automation.id)) : null),
    [state.load.kind, state.automations],
  );
  useReportSub(resolveAutomationSub(automationSubOf(detailId, scope), knownIds), props.onSubChange);

  const act = async (automation: Automation, action: AutomationAction): Promise<void> => {
    const outcome = await state.act(automation.id, action);
    setError(outcome.ok ? null : outcome.error);
  };

  const here = { workspaceId: props.workspaceId, sessionId: props.sessionId };
  const split = splitFinished(state.automations);
  const groups = groupAutomations(split.open, scope, here);
  // 已结束的跟着同一个范围走（本工作区 / 全部），分组方式与进行中的一样
  const finishedGroups = groupAutomations(split.finished, scope, here);
  const finishedCount = finishedGroups.reduce((sum, group) => sum + group.items.length, 0);

  // 一把尺只按当前显示出来的那些行算（「本工作区 / 全部」切换时跟着变；折叠起来的已结束行不算）
  const sparkMax = sparkScale(
    [...groups, ...(finishedOpen ? finishedGroups : [])].flatMap((group) => group.items),
    now,
  );

  if (view.kind === "edit") {
    const target = view.id === null ? null : (state.automations.find((automation) => automation.id === view.id) ?? null);
    // 编辑的那一条被删了（别处删的 / 会话级联）：回列表
    if (view.id !== null && target === null) {
      return state.load.kind === "loading" ? <LoadingFrame /> : <BackToList onBack={() => setView({ kind: "list" })} />;
    }
    return (
      <AutomationEditView
        key={view.id ?? "new"}
        automation={target}
        seed={view.seed}
        workspaceId={props.workspaceId}
        providers={props.providers}
        now={now}
        create={state.create}
        update={state.update}
        remove={(id) => state.act(id, { type: "delete" })}
        onBack={() => setView(view.from === "detail" && view.id !== null ? { kind: "detail", id: view.id } : { kind: "list" })}
      />
    );
  }

  const header = <PanelTitle icon={FEATURE_ICON.automation} title={a.title} />;
  const detailTarget =
    view.kind === "detail" ? (state.automations.find((automation) => automation.id === view.id) ?? null) : null;
  // 看的那一条被删了（别处删的 / 会话级联）：回列表
  // 列表还没读回来（刚重启 / 刚挂载）时别急着判「没了」：记着的详情要等数据到了再认
  if (view.kind === "detail" && detailTarget === null) {
    return state.load.kind === "loading" ? <LoadingFrame /> : <BackToList onBack={() => setView({ kind: "list" })} />;
  }
  const headerExtra = (
    <>
      <PanelHelp label={a.helpLabel} text={a.help} />
      <PanelIconButton title={a.add} onClick={() => setMenuOpen((value) => !value)}>
        <Icon name="plus" size={16} strokeWidth={2} />
      </PanelIconButton>
    </>
  );
  const footer = (
    <label className="auto-foot" title={a.keepAwakeTip}>
      <Icon name="power" size={12} strokeWidth={1.8} />
      <span className="auto-foot-text">{a.keepAwake}</span>
      <button
        type="button"
        role="switch"
        className="auto-switch"
        aria-checked={props.keepAwake}
        aria-label={a.keepAwake}
        onClick={() => props.onKeepAwakeChange(!props.keepAwake)}
      />
    </label>
  );

  const startTemplate = (template: AutomationTemplate): void => {
    const text = a.templates[template.id];
    setView({
      kind: "edit",
      id: null,
      seed: {
        title: text.title,
        prompt: text.prompt,
        schedule: template.schedule,
        ...(template.maxRuns === undefined ? {} : { maxRuns: template.maxRuns }),
      },
    });
  };

  if (view.kind === "detail" && detailTarget !== null) {
    const bound = detailTarget.target.kind === "this_session" ? sessionById.get(detailTarget.target.sessionId) : undefined;
    return (
      <RightPanelFrame header={header} headerExtra={headerExtra} contentKey={`detail:${detailTarget.id}`} footer={footer}>
        <div className="auto-detail-wrap">
          <button type="button" className="auto-back" onClick={() => setView({ kind: "list" })}>
            <Icon name="chevron-left" size={14} strokeWidth={2} /> {a.detail.back}
          </button>
        </div>
        <AutomationDetailView
          key={detailTarget.id}
          automation={detailTarget}
          now={now}
          boundSession={bound === undefined ? null : { mode: bound.mode, title: bound.title }}
          knownSessionIds={knownSessionIds}
          act={(action) => state.act(detailTarget.id, action)}
          onEdit={() => setView({ kind: "edit", id: detailTarget.id, seed: null, from: "detail" })}
          onDeleted={() => setView({ kind: "list" })}
          onOpenSession={props.onOpenSession}
        />
      </RightPanelFrame>
    );
  }

  /**
   * 一组行。已结束的段里：本工作区范围只有一组时不再摆组头（它就在「已结束」底下，再来一句
   * 「这个工作区 · 每次新开会话」既重复、那句提示也是在说进行中的）；有多组（本会话 / 各工作区）才留标签、不带提示。
   */
  const renderGroup = (group: AutomationGroup, options: { finished: boolean; head: boolean }) => (
    <div key={group.key}>
      {options.head && (
        <PanelGroupHead
          label={
            group.kind === "thisSession" ? a.groupThisSession : scope === "all" ? nameOf(group.workspaceId ?? null) : a.groupWorkspace
          }
          detail={options.finished ? "" : group.kind === "thisSession" ? a.groupThisSessionHint : scope === "all" ? "" : a.groupWorkspaceHint}
        />
      )}
      <div className="auto-list">
        {group.items.map((automation) => {
          const bound = automation.target.kind === "this_session" ? sessionById.get(automation.target.sessionId) : undefined;
          return (
            <AutomationRow
              key={automation.id}
              automation={automation}
              now={now}
              sparkMax={sparkMax}
              boundSession={bound === undefined ? null : { mode: bound.mode, title: bound.title }}
              onOpen={() => setView({ kind: "detail", id: automation.id })}
              onAct={(action) => void act(automation, action)}
            />
          );
        })}
      </div>
    </div>
  );

  return (
    <RightPanelFrame header={header} headerExtra={headerExtra} contentKey="list" footer={footer}>
      {menuOpen && (
        <div className="auto-add-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              setView({ kind: "edit", id: null, seed: null });
            }}
          >
            <Icon name="pencil-line" size={14} /> {a.addManual}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setMenuOpen(false);
              props.onAskInChat();
            }}
          >
            <Icon name="message-square" size={14} /> {a.addByChat}
          </button>
        </div>
      )}

      <div className="auto-scope">
        <div className="auto-seg" role="group" aria-label={a.scopeLabel}>
          <button type="button" className="quiet-control" aria-pressed={scope === "workspace"} onClick={() => setScope("workspace")}>
            {a.scopeWorkspace}
          </button>
          <button type="button" className="quiet-control" aria-pressed={scope === "all"} onClick={() => setScope("all")}>
            {a.scopeAll}
          </button>
        </div>
        {scope === "workspace" && <span className="auto-scope-name">{workspaceName}</span>}
      </div>

      {error !== null && (
        <div style={{ padding: "var(--space-1) var(--space-3)" }}>
          <PanelLine danger>{a.actionFailed(error)}</PanelLine>
        </div>
      )}

      {state.load.kind === "loading" && state.automations.length === 0 && <p className="panel-empty">{a.loading}</p>}
      {state.load.kind === "failed" && (
        <div style={{ padding: "var(--space-2) var(--space-3)", display: "grid", gap: "var(--space-2)" }}>
          <PanelLine danger>{a.loadFailed(state.load.message)}</PanelLine>
          <span>
            <PanelButton onClick={state.reload}>{a.retry}</PanelButton>
          </span>
        </div>
      )}

      {state.load.kind === "ready" && groups.length === 0 && (
        <>
          <div className="auto-empty">
            <span className="auto-empty-icon">
              <Icon name={FEATURE_ICON.automation} size={18} strokeWidth={1.8} />
            </span>
            {/* 只有已结束的：说「没有进行中的」，别说「还没有自动化」——下面的「已结束」里明明有 */}
            <strong>{finishedCount > 0 ? a.empty.idleTitle : scope === "all" ? a.empty.titleAll : a.empty.title}</strong>
            <p>{finishedCount > 0 ? a.empty.idleBody : a.empty.body}</p>
          </div>
          {finishedCount === 0 && (
            <>
              <PanelGroupHead label={a.empty.templates} />
              {AUTOMATION_TEMPLATES.map((template) => (
                <button key={template.id} type="button" className="auto-tpl" onClick={() => startTemplate(template)}>
                  <Icon name={template.icon} size={14} strokeWidth={1.8} />
                  <span>
                    <b>{a.templates[template.id].name}</b>
                    <span className="auto-tpl-desc">{a.templates[template.id].desc}</span>
                  </span>
                </button>
              ))}
            </>
          )}
        </>
      )}

      {groups.map((group) => renderGroup(group, { finished: false, head: true }))}

      {finishedCount > 0 && (
        <div className="auto-finished">
          <PanelGroupHead
            label={a.finished.title(finishedCount)}
            collapsed={!finishedOpen}
            onToggle={() => setFinishedOpen((open) => !open)}
          />
          {finishedOpen && (
            <>
              <p className="auto-finished-note">{a.finished.note(AUTOMATION_ARCHIVE_KEEP)}</p>
              {finishedGroups.map((group) => renderGroup(group, { finished: true, head: scope === "all" || finishedGroups.length > 1 }))}
              {state.archive !== null && state.archive.older > 0 && (
                <p className="auto-finished-note">{a.finished.older(state.archive.older, state.archive.file)}</p>
              )}
            </>
          )}
        </div>
      )}
    </RightPanelFrame>
  );
}

/** 正在编辑的那条自动化已经不在了：一帧空页后回列表（effect 里切视图，避免渲染期 setState） */
/** 记着的详情在等列表读回来：只画壳与「加载中」，不抢着回列表 */
function LoadingFrame() {
  const a = useT().automation;
  return (
    <RightPanelFrame header={<PanelTitle icon={FEATURE_ICON.automation} title={a.title} />} contentKey="loading">
      <p className="panel-empty">{a.loading}</p>
    </RightPanelFrame>
  );
}

function BackToList(props: { onBack: () => void }) {
  useEffect(props.onBack, [props.onBack]);
  return null;
}
