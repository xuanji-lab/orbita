/**
 * 插件详情（设计稿 v5 屏 1）：**一张长页**——头部（头像、名字、来源、描述）+ 各节：
 * 它能做什么（技能、脚本、外接）/ 输入与输出 / 工作流（标出等你的步骤）/ 看板样式（缩小的看板 + 每卡一行 +「打开看板」）/
 * 要你填的 / 装在哪 / 来源与版本。宽的时候左右两列（左：能做什么、输入输出、工作流；右：装在哪、要你填的、来源与版本，
 * 看板样式跨两列放最下），窄的时候（右栏）单列，顺序见 plugins.css 的 `order`。
 *
 * 「正在做」（草稿，`draftPath` 非空）就是这张页：清单里还没写的节画虚线框「还没聊到」，刚变化的节外圈高亮 2 秒，
 * 文件改动几秒内刷新；没有安装记录，所以没有开关、没有卸载。
 * 零散的技能与 MCP（面板叫「能力」，列表里和插件并排）同样走这一页，只是节不同（见 detail-sections.ts 的 detailParts）：
 * 技能 = 内容三格（失焦即存）+ 在哪儿可用；MCP = 状态（启用开关、连接状态、错误全文与重试）+ 工具 + 命令 + 在哪儿可用。
 * 插件带的技能只读，带的 MCP 显示状态与工具、不单独启停。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parsePluginViewId, type PluginScope, type PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { fileManagerKind } from "../../file-manager.ts";
import { useT } from "../../locale.ts";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { Icon } from "../../shell/Icon";
import { AvailabilityBody, McpStatusLine, McpToolChips, PluginMcpRuntime, SkillContentBody, serverStatusOf, toolsOfStatus } from "./AbilitySections.tsx";
import { ConfigField, ScopeEditor } from "./PluginConfig.tsx";
import { BoardStyleBody } from "./PluginBoardSection.tsx";
import { ExternalAbility, McpAbility, PluginAvatar, PluginSwitch, ScriptsAbility, SkillAbility, UnsupportedAbility } from "./PluginParts.tsx";
import { WorkflowList } from "./PluginWorkflow.tsx";
import {
  FRESH_HIGHLIGHT_MS,
  changedSections,
  detailParts,
  sectionFilled,
  sectionSignatures,
  waitCount,
  type DetailSection,
  type SectionSignatures,
} from "./detail-sections.ts";
import { conflictText, problemText } from "./plugin-text.ts";
import { namedInstances } from "./mcp-row-display.ts";
import { useMcpRows } from "./useMcpRows.ts";
import { availabilityScopeOf, canRemoveMcpView, isBuiltinView, sourceKey, workspaceName } from "./plugin-view.ts";

const DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });

export function PluginDetail(props: {
  view: PluginView;
  workspaces: readonly Workspace[];
  /** 当前会话所在的工作区（看板的数据路径里 `${workspaceFolder}` 按它解析，也决定看板在这里启没启用） */
  currentWorkspaceId: string | null;
  /** 「正在做」：这份视图是还没安装的草稿（工作区内插件文件夹的路径）；null / 不给 = 已装的 */
  draftPath?: string | null;
  /** 点「打开看板」：右栏版进入看板视图；设置里的全屏版 = 关设置并在右栏打开 */
  onOpenBoard: () => void;
  /** 页内是否画返回键：右栏版的返回键在工具栏胶囊里，不重复 */
  showBack: boolean;
  onBack: () => void;
  onScope: (scope: PluginScope) => Promise<void>;
  /** 配置 / 重载 / 卸载之后让列表回读 */
  onChanged: () => Promise<void>;
  /** 卸载完成：回已装列表 */
  onUninstalled: () => void;
}) {
  const messages = useT();
  const t = messages.plugins;
  const fileManager = fileManagerKind(api.platform);
  const { view } = props;
  const draft = props.draftPath !== undefined && props.draftPath !== null;
  const parsed = parsePluginViewId(view.id);
  const [error, setError] = useState<string | null>(null);
  // 行内二次确认正等着哪个动作：插件卸载或旧 MCP 移除；null = 没在确认
  const [confirming, setConfirming] = useState<null | "plugin" | "mcp" | "skill-archive" | "skill-trash">(null);
  const [busy, setBusy] = useState<null | "reload" | "uninstall" | "remove" | "archive" | "trash">(null);
  const [reloaded, setReloaded] = useState(false);
  const [leadOpen, setLeadOpen] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  // 导入的技能（入口是指向你自己文件夹的链接）：移除时只摘入口，确认条要说清；点「移除」时现查
  const [linkedSkillPath, setLinkedSkillPath] = useState<string | null>(null);
  const parts = detailParts(view);
  // 确认条一出现就把焦点给「取消」：误按回车不会删东西，Esc 也在这一层收回
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming !== null) cancelRef.current?.focus();
  }, [confirming]);

  // 草稿里刚变化的节高亮 2 秒：只比较各节自己的内容签名（标题 / 描述变了不亮）
  const signatures = useMemo(() => sectionSignatures(view), [view]);
  const previousSignatures = useRef<SectionSignatures | null>(null);
  const [fresh, setFresh] = useState<readonly DetailSection[]>([]);
  useEffect(() => {
    if (!draft) return;
    const changed = changedSections(previousSignatures.current, signatures);
    previousSignatures.current = signatures;
    if (changed.length > 0) setFresh(changed);
  }, [signatures, draft]);
  useEffect(() => {
    if (fresh.length === 0) return;
    const timer = window.setTimeout(() => setFresh([]), FRESH_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  const run = async (task: () => Promise<void>): Promise<void> => {
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(t.actionFailed(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  const source = sourceKey(view);
  const sourceLabel = {
    builtin: t.sourceBuiltin,
    userSkill: t.sourceUserSkill,
    userMcp: t.sourceUserMcp,
    copy: t.sourceCopy,
    link: t.sourceLink,
    git: t.sourceGit,
  }[source];
  // 零散技能 / MCP 的副标题：「你的技能 · 全局」——种类 + 现在在哪儿可用（MCP 停用时说已停用）
  const availability = availabilityScopeOf(view);
  const where =
    view.origin === "user-mcp" && view.scope.kind === "off"
      ? t.mcpState.disabled
      : availability.kind === "global"
        ? t.availableGlobal
        : availability.kind === "workspaces"
          ? availability.ids.map((id) => workspaceName(props.workspaces, id)).join("、")
          : t.groupNone;
  const by = draft
    ? [t.draftBy]
    : view.origin === "user-mcp" || (view.origin === "user-skill" && !parts.skillMissing)
      ? [sourceLabel, where]
      : view.origin === "user-skill"
        ? [sourceLabel]
        : [view.author, view.version, view.license, sourceLabel].filter((part): part is string => part !== null && part !== "");
  const isPlugin = view.origin === "plugin";
  const hasAbilities = sectionFilled(view, "abilities");
  const linked = view.install?.source.kind === "link";
  /** Orbita 内置（做插件）：可以停用，不能卸载 */
  const builtin = isBuiltinView(view);
  const pluginName = parsed?.key ?? "";
  // 连接状态是运行时事实：这张详情涉及 MCP（你的 MCP，或插件带了 MCP）才读，并跟着 agent 的快照走
  const mcpRows = useMcpRows(parts.mcpStatus || (isPlugin && view.mcp.length > 0));
  const mcpServer = parts.mcpStatus ? (mcpRows.servers.find((row) => row.name === (parsed?.key ?? view.name)) ?? null) : null;
  const mcpStatus = serverStatusOf(mcpServer, mcpRows.loaded);
  const mcpTools = toolsOfStatus(mcpStatus);
  /** 启用开关的真值：文件里的 disabled 事实（mcp:list 读的），没读到就按视图的范围 */
  const mcpEnabled = mcpServer !== null ? !mcpServer.disabled : view.scope.kind !== "off";
  const pluginRuntimeRow = (row: (typeof mcpRows.pluginServers)[number] | undefined) =>
    row === undefined ? null : { status: row.status, instances: namedInstances(row.instances, (id) => workspaceName(props.workspaces, id)) };
  const reconnect = (): void =>
    void run(async () => {
      setReconnecting(true);
      try {
        await mcpRows.reconnect();
      } finally {
        setReconnecting(false);
      }
    });

  /** 一节：草稿里没写的画虚线框「还没聊到」+ 一句提示，写了的正常画；刚变化的外圈亮一下 */
  const section = (key: DetailSection, title: string, body: ReactNode, opts: { hint?: string; trailing?: ReactNode; placeholder: string }): ReactNode => {
    if (draft && !sectionFilled(view, key)) {
      return (
        <section className="pl-card pl-ph" data-sec={key}>
          <div className="pl-card-h">
            {title}
            <span className="hint">{t.notChatted}</span>
          </div>
          <p className="pl-ph-text">{opts.placeholder}</p>
        </section>
      );
    }
    return (
      <section className="pl-card" data-sec={key} data-fresh={fresh.includes(key) ? "true" : undefined}>
        <div className="pl-card-h">
          {title}
          {opts.hint !== undefined && <span className="hint">{opts.hint}</span>}
          {opts.trailing !== undefined && <span className="pl-card-trail">{opts.trailing}</span>}
        </div>
        {body}
      </section>
    );
  };

  const abilities = section(
    "abilities",
    t.abilitiesTitle,
    hasAbilities ? (
      <div>
        {view.skills.map((skill) => (
          <SkillAbility key={`s:${skill.slug}`} skill={skill} />
        ))}
        {view.mcp.map((server) => (
          <McpAbility
            key={`m:${server.name}`}
            server={server}
            runtime={
              <PluginMcpRuntime
                server={server.qualified}
                row={pluginRuntimeRow(mcpRows.pluginServers.find((row) => row.name === server.qualified))}
                loaded={mcpRows.loaded}
                disabled={view.scope.kind === "off"}
                reconnecting={reconnecting}
                onRetry={reconnect}
              />
            }
          />
        ))}
        {view.contents.scripts && <ScriptsAbility />}
        {view.external.length > 0 && <ExternalAbility items={view.external} />}
        {view.unsupported.map((entry) => (
          <UnsupportedAbility key={`u:${entry.kind}`} entry={entry} />
        ))}
      </div>
    ) : (
      // 只带看板的插件（技能 / MCP 都没有）不是「加载不了」，是本来就没有
      <span className="pl-muted">{view.board !== null ? t.abilitiesNone : t.abilitiesEmpty}</span>
    ),
    { hint: t.abilitiesHint, placeholder: t.phAbilities },
  );

  const hasIo = sectionFilled(view, "io");
  const io =
    draft || hasIo
      ? section(
          "io",
          t.ioTitle,
          <div>
            {(["reads", "writes"] as const).map((side) =>
              view.io[side].length === 0 ? null : (
                <div className="pl-ab" key={side}>
                  <span className="pl-ab-kind pl-io-kind">
                    <Icon name={side === "reads" ? "log-in" : "log-out"} size={12} strokeWidth={1.8} />
                    {side === "reads" ? t.ioRead : t.ioWrite}
                  </span>
                  <div className="pl-ab-body">
                    {view.io[side].map((item, index) => (
                      <span className="pl-io" key={index}>
                        <code>{item.path}</code>
                        {(item.note !== null || item.when !== null) && <small>{[item.note, item.when].filter((part) => part !== null).join(" · ")}</small>}
                      </span>
                    ))}
                  </div>
                </div>
              ),
            )}
          </div>,
          { hint: t.ioHint, placeholder: t.phIo },
        )
      : null;

  const hasWorkflow = view.workflow.length > 0;
  const waits = waitCount(view.workflow);
  const workflow =
    draft || hasWorkflow
      ? section("workflow", t.workflowTitle, <WorkflowList pluginName={pluginName} steps={view.workflow} canView={!draft} />, {
          hint: waits === 0 ? t.workflowHint : undefined,
          trailing: waits > 0 ? t.workflowWaits(waits) : undefined,
          placeholder: t.phWorkflow,
        })
      : null;

  const board =
    view.board !== null || draft
      ? section(
          "board",
          t.boardTitle,
          view.board === null ? null : (
            <BoardStyleBody
              board={view.board}
              target={draft ? { kind: "draft", path: props.draftPath ?? "", workspaceId: props.currentWorkspaceId } : { kind: "installed", name: pluginName, workspaceId: props.currentWorkspaceId }}
            />
          ),
          {
            trailing:
              view.board === null ? undefined : (
                <button type="button" className="pl-btn pl-open-board" onClick={props.onOpenBoard}>
                  <Icon name="layout-grid" size={12} strokeWidth={1.8} />
                  {t.boardOpen}
                </button>
              ),
            placeholder: t.phBoard,
          },
        )
      : null;

  const scope = section(
    "scope",
    t.scopeTitle,
    <ScopeEditor scope={view.scope} workspaces={props.workspaces} offLabel={t.scopeOff} onChange={(next) => void run(() => props.onScope(next))} />,
    { placeholder: t.phScope },
  );

  const config = section(
    "config",
    t.configTitle,
    view.config.length === 0 ? (
      <span className="pl-muted">{t.configNone}</span>
    ) : draft ? (
      // 草稿还没装，没有地方存值：只列出它会问你什么，装上之后再填
      <ul className="pl-list">
        {view.config.map((state) => (
          <li key={state.field.key}>
            <b>{state.field.title}</b>
            {state.field.description !== "" && <small> {state.field.description}</small>}
          </li>
        ))}
      </ul>
    ) : (
      <div className="pl-form">
        {view.config.map((state) => (
          <ConfigField
            key={state.field.key}
            state={state}
            onSave={async (value) => {
              await api.plugin.setConfig(pluginName, state.field.key, value);
              await props.onChanged();
            }}
          />
        ))}
      </div>
    ),
    { placeholder: t.phConfig },
  );

  const sourceCard = section(
    "source",
    t.sourceTitle,
    <>
      <dl className="pl-kv">
        {view.version !== null && (
          <>
            <dt>{t.kvVersion}</dt>
            <dd className="mono">{view.version}</dd>
          </>
        )}
        <dt>{t.kvSource}</dt>
        <dd>{sourceLine(view, t, sourceLabel)}</dd>
        {view.install?.source.kind === "git" && (
          <>
            <dt>{t.kvCommit}</dt>
            <dd className="mono">{view.install.source.commit.slice(0, 12)}</dd>
          </>
        )}
        {view.install !== null && (
          <>
            <dt>{t.kvInstalled}</dt>
            <dd>{DATE.format(view.install.installedAt)}</dd>
            <dt>{t.kvUpdates}</dt>
            <dd>{builtin ? t.kvUpdatesBuiltin : t.kvUpdatesValue}</dd>
          </>
        )}
      </dl>
      {view.location !== null && view.install === null && <span className="pl-code">{view.location}</span>}
      {/* 链接安装的根就是来源那一行的路径，不再重复一遍 */}
      {view.install !== null && view.install.source.kind !== "link" && <span className="pl-code">{view.install.root}</span>}
    </>,
    { placeholder: t.phSource },
  );

  const problemsCard =
    view.problems.length > 0 ? (
      <section className="pl-card" data-sec="problems">
        <div className="pl-card-h">{t.problemsTitle}</div>
        <ul className="pl-list">
          {view.problems.map((problem, index) => (
            <li key={index}>{problemText(t, problem)}</li>
          ))}
        </ul>
      </section>
    ) : null;

  // 打开文件夹 / 重新载入 / 卸载：宽窄都在标题区下面这一处；点「卸载 / 移除」原地换成确认条
  const actionButtons = (
    <>
      {isPlugin && !draft && (
        <>
          <button type="button" className="pl-btn" onClick={() => void run(() => api.plugin.reveal(pluginName))}>
            <Icon name="folder-open" size={13} strokeWidth={1.8} />
            {t.openFolder}
          </button>
          <button
            type="button"
            className="pl-btn"
            title={t.reloadTip}
            disabled={busy !== null}
            onClick={() =>
              void run(async () => {
                setBusy("reload");
                setReloaded(false);
                try {
                  await api.plugin.reload();
                  await props.onChanged();
                  setReloaded(true);
                } finally {
                  setBusy(null);
                }
              })
            }
          >
            <Icon name="refresh-cw" size={13} strokeWidth={1.8} />
            {busy === "reload" ? t.reloading : reloaded ? t.reloaded : t.reload}
          </button>
          {!builtin && (
            <button type="button" className="pl-btn danger" disabled={busy !== null} onClick={() => setConfirming("plugin")}>
              <Icon name="trash-2" size={13} strokeWidth={1.8} />
              {t.uninstall}
            </button>
          )}
        </>
      )}
      {view.origin === "user-skill" && !parts.skillMissing && (
        <button type="button" className="pl-btn" onClick={() => void run(() => api.skill.reveal(parsed?.key ?? null))}>
          <Icon name="folder-open" size={13} strokeWidth={1.8} />
          {t.revealInManager(fileManager)}
        </button>
      )}
      {parts.skillContent && (
        <>
          <button type="button" className="pl-btn" disabled={busy !== null} onClick={() => setConfirming("skill-archive")}>
            <Icon name={FEATURE_ICON.archived} size={13} strokeWidth={1.8} />
            {t.skillArchive}
          </button>
          <button type="button" className="pl-btn danger" disabled={busy !== null} onClick={() => {
              setLinkedSkillPath(null);
              setConfirming("skill-trash");
              void api.skill.list().then((list) => setLinkedSkillPath(list.find((each) => each.slug === skillKey)?.linkedPath ?? null)).catch(() => undefined);
            }}>
            <Icon name="trash-2" size={13} strokeWidth={1.8} />
            {t.skillTrash}
          </button>
        </>
      )}
      {parts.skillMissing && (
        <button
          type="button"
          className="pl-btn danger"
          title={t.skillMissingCleanTip}
          disabled={busy !== null}
          onClick={() =>
            void run(async () => {
              await api.skill.clean(parsed?.key ?? "");
              await props.onChanged();
              // 清完这一条就不在列表里了：回列表
              props.onUninstalled();
            })
          }
        >
          <Icon name="trash-2" size={13} strokeWidth={1.8} />
          {t.skillMissingClean}
        </button>
      )}
      {view.origin === "user-mcp" && (
        <>
          <button type="button" className="pl-btn" disabled={reconnecting} onClick={reconnect}>
            <Icon name="refresh-cw" size={13} strokeWidth={1.8} className={reconnecting ? "anim-continuous pl-mcp-spin" : undefined} />
            {reconnecting ? t.mcpReconnecting : t.mcpReconnect}
          </button>
          <button type="button" className="pl-btn" onClick={() => void run(() => api.mcp.openConfig())}>
            <Icon name="file-text" size={13} strokeWidth={1.8} />
            {t.openMcpConfig}
          </button>
          {/* 右栏的「MCP」面板已撤（PR #421）：删它只能落在这里或手改 mcp.json */}
          {canRemoveMcpView(view) && (
            <button type="button" className="pl-btn danger" disabled={busy !== null} onClick={() => setConfirming("mcp")}>
              <Icon name="trash-2" size={13} strokeWidth={1.8} />
              {t.mcpRemove}
            </button>
          )}
        </>
      )}
    </>
  );
  const hasActions = !draft;

  /** 就地确认条的内容：问句、说明、动作与它做的事。插件卸载 / MCP 移除 / 技能归档 / 技能移除共用同一条。 */
  const skillKey = parsed?.key ?? "";
  const confirmation =
    confirming === "mcp"
      ? { ask: t.mcpRemoveAsk, hint: t.mcpRemoveHint, action: t.mcpRemoveAction, doing: t.mcpRemoving, busy: "remove" as const, act: () => api.mcp.remove(parsed?.key ?? view.name) }
      : confirming === "plugin"
        ? { ask: t.uninstallAsk(view.name), hint: linked ? t.uninstallHintLink : t.uninstallHint, action: t.uninstallAction, doing: t.uninstalling, busy: "uninstall" as const, act: () => api.plugin.uninstall(pluginName) }
        : confirming === "skill-archive"
          ? { ask: t.skillArchiveAsk(view.name), hint: t.skillArchiveHint, action: t.skillArchiveAction, doing: t.skillArchiving, busy: "archive" as const, act: () => api.skill.archive(skillKey) }
          : confirming === "skill-trash"
            ? { ask: t.skillTrashAsk(view.name), hint: linkedSkillPath !== null ? t.skillTrashHintLinked(linkedSkillPath) : t.skillTrashHint(fileManager), action: t.skillTrashAction, doing: t.skillTrashing, busy: "trash" as const, act: () => api.skill.trash(skillKey) }
            : null;

  /**
   * 「在哪儿可用」改范围。你的 MCP 停用时改位置不该顺手把它开起来：setScope 的非停用范围会写 disabled: false，
   * 所以原本停着的再补一次停用。
   */
  const changeAvailability = async (next: PluginScope): Promise<void> => {
    const wasStopped = view.origin === "user-mcp" && view.scope.kind === "off";
    await props.onScope(next);
    if (wasStopped && next.kind !== "off") {
      await api.mcp.setDisabled(parsed?.key ?? view.name, true);
      await props.onChanged();
    }
  };

  return (
    <div className="pl-detail" data-draft={draft ? "true" : undefined}>
      {props.showBack && (
        <button type="button" className="pl-back" onClick={props.onBack}>
          <Icon name="chevron-left" size={14} strokeWidth={1.8} />
          {t.backToInstalled}
        </button>
      )}

      <div className="pl-hero">
        <PluginAvatar view={view} big />
        <div className="pl-hero-main">
          <div className="pl-title">{view.name}</div>
          <div className="pl-by">{by.join(" · ")}</div>
          {!parts.lead ? null : view.description !== "" ? (
            // 描述原文常常几百字（技能的触发词清单）：默认三行，点一下展开——简洁为默认、细节可展开
            <button type="button" className="pl-lead" aria-expanded={leadOpen} data-open={leadOpen} onClick={() => setLeadOpen((open) => !open)}>
              {view.description}
            </button>
          ) : (
            draft && <p className="pl-lead pl-ph-text">{t.phLead}</p>
          )}
        </div>
      </div>

      {hasActions &&
        (confirming === null || confirmation === null ? (
          <div className="pl-acts">{actionButtons}</div>
        ) : (
          <div
            className="pl-ic"
            role="alertdialog"
            aria-label={confirmation.ask}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setConfirming(null);
              }
            }}
          >
            <div className="pl-ic-bar">
              <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
              <span className="pl-ic-ask">{confirmation.ask}</span>
              <button
                type="button"
                className="pl-btn solid-danger"
                disabled={busy !== null}
                onClick={() =>
                  void run(async () => {
                    setBusy(confirmation.busy);
                    try {
                      await confirmation.act();
                      await props.onChanged();
                      props.onUninstalled();
                    } finally {
                      setBusy(null);
                      setConfirming(null);
                    }
                  })
                }
              >
                {busy === confirmation.busy ? confirmation.doing : confirmation.action}
              </button>
              <button type="button" className="pl-btn" ref={cancelRef} onClick={() => setConfirming(null)}>
                {messages.common.cancel}
              </button>
            </div>
            <p className="pl-ic-hint">{confirmation.hint}</p>
          </div>
        ))}

      {error !== null && (
        <div className="pl-note danger" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>{error}</span>
        </div>
      )}

      {parts.skillMissing && (
        <div className="pl-note danger" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>{t.skillMissingNote}</span>
        </div>
      )}

      {view.conflicts.length > 0 && (
        <div className="pl-note warn" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <div style={{ display: "grid", gap: "var(--space-1)" }}>
            <b>{t.conflictsTitle}</b>
            {view.conflicts.map((conflict, index) => (
              <span key={index}>{conflictText(t, conflict)}</span>
            ))}
          </div>
        </div>
      )}

      {builtin && (
        <div className="pl-note">
          <Icon name="info" size={14} strokeWidth={1.8} />
          <span>{t.builtinNote}</span>
        </div>
      )}

      {/* 两列（宽）：左 能做什么 / 输入与输出 / 工作流，右 装在哪 / 要你填的 / 来源与版本，看板样式跨两列放最下；
          单列（窄）：.pl-cols / .pl-col 退成 display: contents，各节按 order 重排（plugins.css） */}
      {parts.skillContent || parts.mcpStatus ? (
        // 零散技能 / MCP：单列几节（设计稿 b / c），没有两列、没有看板
        <div className="pl-legacy">
          {parts.skillContent && (
            <section className="pl-card" data-sec="content">
              <div className="pl-card-h">
                {t.contentTitle}
                <span className="hint">{t.contentHint}</span>
              </div>
              <SkillContentBody slug={parsed?.key ?? ""} onSaved={props.onChanged} />
            </section>
          )}
          {parts.mcpStatus && (
            <>
              <section className="pl-card" data-sec="status">
                <div className="pl-card-h">
                  {t.mcpStatusTitle}
                  <span className="pl-card-trail pl-mcp-enable">
                    {t.mcpEnabled}
                    <PluginSwitch
                      checked={mcpEnabled}
                      label={mcpEnabled ? t.mcpEnabledOn(view.name) : t.mcpEnabledOff(view.name)}
                      disabled={busy !== null || reconnecting}
                      onChange={() =>
                        void run(async () => {
                          // 写盘后主进程自动重连；这里等它回来再读，状态才是新的
                          await api.mcp.setDisabled(parsed?.key ?? view.name, mcpEnabled);
                          await Promise.all([props.onChanged(), mcpRows.refresh()]);
                        })
                      }
                    />
                  </span>
                </div>
                <McpStatusLine status={mcpStatus} instances={mcpServer?.instances ?? []} reconnecting={reconnecting} onRetry={reconnect} />
                {mcpRows.error !== null && (
                  <span className="pl-field-error" role="alert">
                    {mcpRows.error}
                  </span>
                )}
              </section>
              <section className="pl-card" data-sec="tools">
                <div className="pl-card-h">
                  <Icon name="wrench" size={13} strokeWidth={1.8} />
                  {t.mcpToolsTitle(mcpTools.length)}
                </div>
                {mcpTools.length > 0 ? <McpToolChips server={parsed?.key ?? view.name} tools={mcpTools} /> : <span className="pl-muted">{t.mcpToolsNone}</span>}
              </section>
              <section className="pl-card" data-sec="command">
                <div className="pl-card-h">
                  <Icon name="terminal" size={13} strokeWidth={1.8} />
                  {t.mcpCommandTitle}
                </div>
                <code className="pl-cmd">{view.mcp[0]?.commandLine ?? view.description}</code>
              </section>
            </>
          )}
          {parts.availability && (
            <section className="pl-card" data-sec="available">
              <div className="pl-card-h">
                <Icon name="layers" size={13} strokeWidth={1.8} />
                {t.availableTitle}
              </div>
              <AvailabilityBody view={view} workspaces={props.workspaces} onScope={(next) => void run(() => changeAvailability(next))} />
            </section>
          )}
        </div>
      ) : parts.skillMissing ? null : (
        <>
          <div className="pl-cols">
            <div className="pl-col">
              {abilities}
              {io}
              {workflow}
            </div>
            <div className="pl-col">
              {scope}
              {config}
              {sourceCard}
              {problemsCard}
            </div>
          </div>
          {board}
        </>
      )}
    </div>
  );
}

function sourceLine(view: PluginView, t: ReturnType<typeof useT>["plugins"], fallback: string): string {
  const source = view.install?.source;
  if (source === undefined) return fallback;
  if (source.kind === "copy") return t.sourceCopyLine(source.from);
  if (source.kind === "link") return t.sourceLinkLine(source.path);
  if (source.kind === "builtin") return fallback;
  return t.sourceGitLine(source.url);
}
