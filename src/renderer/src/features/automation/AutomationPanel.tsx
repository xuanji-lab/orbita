import { useEffect, useMemo, useState } from "react";
import "./automation.css";
import { Icon } from "../../shell/Icon";
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
import { automationWorkspaceId, type Automation, type AutomationAction } from "../../../../shared/automation.ts";
import { AutomationEditView, type AutomationSeed } from "./AutomationEditView";
import { AutomationRow } from "./AutomationRow";
import {
  AUTOMATION_TEMPLATES,
  groupAutomations,
  type AutomationScope,
  type AutomationTemplate,
} from "./automation-view.ts";
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

type View = { kind: "list" } | { kind: "edit"; id: string | null; seed: AutomationSeed | null };

/**
 * 右栏「自动化」面板（实验功能 automation）：列表 / 运行记录 / 新建与编辑子页 / 空态模板，
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
  /** 对话卡的「在右栏查看」：定位到这一条并展开（nonce 递增，同一条重复点也生效） */
  focus: { id: string; nonce: number } | null;
  onOpenSession: (sessionId: string) => void;
  /** 「在这条会话里说一句」：往输入框预填一句引导 */
  onAskInChat: () => void;
}) {
  const t = useT();
  const a = t.automation;
  const { state } = props;
  const now = useNow(60_000);
  const [view, setView] = useState<View>({ kind: "list" });
  const [scope, setScope] = useState<AutomationScope>("workspace");
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // 工作区被移除之后它名下的自动化还在（会话 id 同理）：组头如实说「已移除的工作区」，不留一个空标题
  const nameOf = (id: string | null): string =>
    id === null ? a.homeName : (props.workspaces.find((w) => w.id === id)?.name ?? a.removedWorkspace);
  const workspaceName = nameOf(props.workspaceId);
  const sessionById = useMemo(() => new Map(props.sessions.map((meta) => [meta.id, meta])), [props.sessions]);
  const knownSessionIds = useMemo(() => new Set(props.sessions.map((meta) => meta.id)), [props.sessions]);

  // 从对话卡跳来：回到列表、必要时把范围切到「全部」、展开并高亮那一条
  useEffect(() => {
    if (props.focus === null) return;
    const target = state.automations.find((automation) => automation.id === props.focus?.id);
    setView({ kind: "list" });
    setMenuOpen(false);
    if (target === undefined) return;
    if (automationWorkspaceId(target) !== props.workspaceId) setScope("all");
    setOpen((current) => new Set(current).add(target.id));
    setFocusedId(target.id);
    const timer = window.setTimeout(() => setFocusedId(null), 2000);
    return () => window.clearTimeout(timer);
    // focus 的 nonce 变了才重来；列表刷新不该把高亮再点一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.focus?.nonce]);

  const act = async (automation: Automation, action: AutomationAction): Promise<void> => {
    const outcome = await state.act(automation.id, action);
    setError(outcome.ok ? null : outcome.error);
  };

  const groups = groupAutomations(state.automations, scope, { workspaceId: props.workspaceId, sessionId: props.sessionId });

  if (view.kind === "edit") {
    const target = view.id === null ? null : (state.automations.find((automation) => automation.id === view.id) ?? null);
    // 编辑的那一条被删了（别处删的 / 会话级联）：回列表
    if (view.id !== null && target === null) return <BackToList onBack={() => setView({ kind: "list" })} />;
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
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  const header = <PanelTitle icon="calendar-clock" title={a.title} />;
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
              <Icon name="calendar-clock" size={18} strokeWidth={1.8} />
            </span>
            <strong>{scope === "all" ? a.empty.titleAll : a.empty.title}</strong>
            <p>{a.empty.body}</p>
          </div>
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

      {groups.map((group) => (
        <div key={group.key}>
          <PanelGroupHead
            label={
              group.kind === "thisSession"
                ? a.groupThisSession
                : scope === "all"
                  ? nameOf(group.workspaceId ?? null)
                  : a.groupWorkspace
            }
            detail={group.kind === "thisSession" ? a.groupThisSessionHint : scope === "all" ? "" : a.groupWorkspaceHint}
          />
          <div className="auto-list">
            {group.items.map((automation) => {
              const bound = automation.target.kind === "this_session" ? sessionById.get(automation.target.sessionId) : undefined;
              return (
                <AutomationRow
                  key={automation.id}
                  automation={automation}
                  now={now}
                  boundSession={bound === undefined ? null : { mode: bound.mode, title: bound.title }}
                  knownSessionIds={knownSessionIds}
                  open={open.has(automation.id)}
                  focused={focusedId === automation.id}
                  onToggle={() =>
                    setOpen((current) => {
                      const next = new Set(current);
                      if (next.has(automation.id)) next.delete(automation.id);
                      else next.add(automation.id);
                      return next;
                    })
                  }
                  onAct={(action) => void act(automation, action)}
                  onEdit={() => setView({ kind: "edit", id: automation.id, seed: null })}
                  onOpenSession={props.onOpenSession}
                />
              );
            })}
          </div>
        </div>
      ))}
    </RightPanelFrame>
  );
}

/** 正在编辑的那条自动化已经不在了：一帧空页后回列表（effect 里切视图，避免渲染期 setState） */
function BackToList(props: { onBack: () => void }) {
  useEffect(props.onBack, [props.onBack]);
  return null;
}
