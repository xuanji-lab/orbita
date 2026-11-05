/**
 * 插件详情（设计稿 v4 第 3 屏）：头部（头像、名字、来源、描述）+ 三个页签——
 * 面板（有面板时默认；底部可折叠看模板说明）/ 工作流 / 设置与来源（装在哪、要你填的、面板与最近产出、
 * 来源与版本、读取问题、打开文件夹 / 重新载入 / 卸载）。页签规则在 detail-tabs.ts。
 * 旧技能与旧 MCP 同样走这一页，只是不分页签（没有工作流也没有面板）、能做的动作少几样。
 */
import { useState, type KeyboardEvent } from "react";
import { parsePluginViewId, type PluginScope, type PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { ConfigField, ScopeEditor } from "./PluginConfig.tsx";
import { McpAbility, PluginAvatar, ScriptsAbility, SkillAbility, UnsupportedAbility } from "./PluginParts.tsx";
import { InstalledPanel } from "./PluginPanel.tsx";
import { PluginPanelCards } from "./PluginPanelCard.tsx";
import { detailTabs, resolveDetailTab, stepDetailTab, type DetailTab } from "./detail-tabs.ts";
import { panelProblemText } from "./panel-view.ts";
import { conflictText, problemText } from "./plugin-text.ts";
import { usePanelInfo } from "./usePluginPanel.ts";
import { sourceKey } from "./plugin-view.ts";

const DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });

export function PluginDetail(props: {
  view: PluginView;
  workspaces: readonly Workspace[];
  /** 当前会话所在的工作区（面板的数据路径里 `${workspaceFolder}` 按它解析，也决定面板在这里启没启用） */
  currentWorkspaceId: string | null;
  /** 在右栏打开这个插件的面板（只有全屏版给——右栏版本来就在右栏里） */
  onOpenInRail?: () => void;
  /** 想看的页签（用户点的 / 「在右栏打开面板」指定的）；null = 按默认 */
  tab: DetailTab | null;
  onTab: (tab: DetailTab) => void;
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
  const { view } = props;
  const parsed = parsePluginViewId(view.id);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<null | "reload" | "uninstall">(null);
  const [reloaded, setReloaded] = useState(false);
  const [leadOpen, setLeadOpen] = useState(false);
  // 面板与最近产出（只有真插件、且声明了 orbita.panel 才有；其余为 null）
  const panelInfo = usePanelInfo(view.origin === "plugin" ? (parsed?.key ?? null) : null, props.currentWorkspaceId);

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
    userSkill: t.sourceUserSkill,
    userMcp: t.sourceUserMcp,
    copy: t.sourceCopy,
    link: t.sourceLink,
    git: t.sourceGit,
  }[source];
  const by = [view.author, view.version, view.license, sourceLabel].filter((part): part is string => part !== null && part !== "");
  const isPlugin = view.origin === "plugin";
  const hasAbilities = view.skills.length + view.mcp.length + view.unsupported.length > 0 || view.contents.scripts;
  const linked = view.install?.source.kind === "link";
  const problemCount = view.problems.length + (panelInfo?.problems.length ?? 0);

  // 页签：有没有面板要等主进程回话才知道（旧技能 / MCP 同步就是「没有」）；没读到之前不画页签，免得默认页闪一下
  const panelKnown = panelInfo !== undefined;
  const tabs = detailTabs({ isPlugin, hasPanel: panelInfo !== null && panelInfo !== undefined });
  const tab = resolveDetailTab(tabs, props.tab);
  const tabLabel: Record<DetailTab, string> = { panel: t.tabPanel, workflow: t.tabWorkflow, settings: t.tabSettings };
  const onTabKey = (event: KeyboardEvent<HTMLElement>): void => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = stepDetailTab(tabs, tab, delta);
    if (next !== null) props.onTab(next);
    // 焦点跟着选中的页签走（roving tabindex）
    requestAnimationFrame(() => document.getElementById(`pl-tab-${next ?? ""}`)?.focus());
  };

  // ---- 各页签里的卡片 ----
  const abilitiesCard = (
    <section className="pl-card">
      <div className="pl-card-h">
        {t.abilitiesTitle}
        <span className="hint">{t.abilitiesHint}</span>
      </div>
      {hasAbilities ? (
        <div>
          {view.skills.map((skill) => (
            <SkillAbility key={`s:${skill.slug}`} skill={skill} />
          ))}
          {view.mcp.map((server) => (
            <McpAbility key={`m:${server.name}`} server={server} />
          ))}
          {view.contents.scripts && <ScriptsAbility />}
          {view.unsupported.map((entry) => (
            <UnsupportedAbility key={`u:${entry.kind}`} entry={entry} />
          ))}
        </div>
      ) : (
        // 只带面板的插件（技能 / MCP 都没有）不是「加载不了」，是本来就没有
        <span className="pl-muted">{tabs.includes("panel") ? t.abilitiesNone : t.abilitiesEmpty}</span>
      )}
    </section>
  );

  const scopeCard = (
    <section className="pl-card">
      <div className="pl-card-h">{t.scopeTitle}</div>
      <ScopeEditor
        scope={view.scope}
        workspaces={props.workspaces}
        offLabel={t.scopeOff}
        onChange={(scope) => void run(() => props.onScope(scope))}
      />
    </section>
  );

  const configCard = (
    <section className="pl-card">
      <div className="pl-card-h">{t.configTitle}</div>
      {view.config.length === 0 ? (
        <span className="pl-muted">{t.configNone}</span>
      ) : (
        <div className="pl-form">
          {view.config.map((state) => (
            <ConfigField
              key={state.field.key}
              state={state}
              onSave={async (value) => {
                await api.plugin.setConfig(parsed?.key ?? "", state.field.key, value);
                await props.onChanged();
              }}
            />
          ))}
        </div>
      )}
    </section>
  );

  const sourceCard = (
    <section className="pl-card">
      <div className="pl-card-h">{t.sourceTitle}</div>
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
            <dd>{t.kvUpdatesValue}</dd>
          </>
        )}
      </dl>
      {view.location !== null && view.install === null && <span className="pl-code">{view.location}</span>}
      {/* 链接安装的根就是来源那一行的路径，不再重复一遍 */}
      {view.install !== null && view.install.source.kind !== "link" && <span className="pl-code">{view.install.root}</span>}
    </section>
  );

  const problemsCard =
    problemCount > 0 ? (
      <section className="pl-card">
        <div className="pl-card-h">{t.problemsTitle}</div>
        <ul className="pl-list">
          {view.problems.map((problem, index) => (
            <li key={index}>{problemText(t, problem)}</li>
          ))}
          {(panelInfo?.problems ?? []).map((problem, index) => (
            <li key={`panel-${index}`}>{panelProblemText(messages.pluginPanel, problem)}</li>
          ))}
        </ul>
      </section>
    ) : null;

  // 打开文件夹 / 重新载入 / 卸载：原先挤在头部右侧，窄栏里占两行；设计稿 v4 头部只留名字与来源，动作收进「设置与来源」
  const actionsCard = (
    <section className="pl-card">
      <div className="pl-card-h">{t.actionsTitle}</div>
      <div className="pl-acts">
        {isPlugin && (
          <>
            <button type="button" className="pl-btn" onClick={() => void run(() => api.plugin.reveal(parsed?.key ?? ""))}>
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
            <button type="button" className="pl-btn danger" disabled={busy !== null} onClick={() => setConfirming(true)}>
              <Icon name="trash-2" size={13} strokeWidth={1.8} />
              {t.uninstall}
            </button>
          </>
        )}
        {view.origin === "user-skill" && (
          <button type="button" className="pl-btn" onClick={() => void run(() => api.skill.reveal(parsed?.key ?? null))}>
            <Icon name="folder-open" size={13} strokeWidth={1.8} />
            {t.openFolder}
          </button>
        )}
        {view.origin === "user-mcp" && (
          <button type="button" className="pl-btn" onClick={() => void run(() => api.mcp.openConfig())}>
            <Icon name="file-text" size={13} strokeWidth={1.8} />
            {t.openMcpConfig}
          </button>
        )}
      </div>
      {/* 卸载确认就在按钮下面：窄栏里按钮在页签底部，确认放到头部会离开视线 */}
      {confirming && (
        <div className="pl-note danger" role="alertdialog" aria-label={t.uninstall}>
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <div style={{ display: "grid", gap: "var(--space-2)" }}>
            <span>{linked ? t.uninstallConfirmLink(view.name) : t.uninstallConfirm(view.name)}</span>
            <span style={{ display: "flex", gap: "var(--space-2)" }}>
              <button
                type="button"
                className="pl-btn danger"
                disabled={busy !== null}
                onClick={() =>
                  void run(async () => {
                    setBusy("uninstall");
                    try {
                      await api.plugin.uninstall(parsed?.key ?? "");
                      await props.onChanged();
                      props.onUninstalled();
                    } finally {
                      setBusy(null);
                      setConfirming(false);
                    }
                  })
                }
              >
                {busy === "uninstall" ? t.uninstalling : t.uninstallAction}
              </button>
              <button type="button" className="pl-btn" onClick={() => setConfirming(false)}>
                {messages.common.cancel}
              </button>
            </span>
          </div>
        </div>
      )}
    </section>
  );

  /** 工作流页签：创建闭环（feat/plugins-create）的工作流卡放在这里、「它能做什么」之前；那条分支合进来之前先只有能力清单 */
  const workflowBody = <div className="pl-col">{abilitiesCard}</div>;

  const settingsBody = (
    <div className="pl-cols">
      <div className="pl-col">
        {scopeCard}
        {configCard}
        {panelInfo !== null && panelInfo !== undefined && <PluginPanelCards info={panelInfo} />}
      </div>
      <div className="pl-col">
        {sourceCard}
        {problemsCard}
        {actionsCard}
      </div>
    </div>
  );

  return (
    <div className="pl-detail" data-fill={tab === "panel"}>
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
          {view.description !== "" && (
            // 描述原文常常几百字（技能的触发词清单）：默认三行，点一下展开——简洁为默认、细节可展开
            <button
              type="button"
              className="pl-lead"
              aria-expanded={leadOpen}
              data-open={leadOpen}
              onClick={() => setLeadOpen((open) => !open)}
            >
              {view.description}
            </button>
          )}
        </div>
      </div>

      {error !== null && (
        <div className="pl-note danger" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>{error}</span>
        </div>
      )}

      {view.origin !== "plugin" && (
        <div className="pl-note">
          <Icon name="info" size={14} strokeWidth={1.8} />
          <span>{view.origin === "user-skill" ? t.legacySkillNote : t.legacyMcpNote}</span>
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

      {!panelKnown ? (
        <p className="pl-empty">{messages.common.loading}</p>
      ) : tab === null ? (
        // 旧技能 / 旧 MCP：没有工作流也没有面板，不分页签，能展示的平铺
        <div className="pl-cols">
          <div className="pl-col">{abilitiesCard}</div>
          <div className="pl-col">
            {sourceCard}
            {problemsCard}
            {actionsCard}
          </div>
        </div>
      ) : (
        <>
          <div className="pl-tabs" role="tablist" aria-label={t.tabsAria} onKeyDown={onTabKey}>
            {tabs.map((each) => (
              <button
                key={each}
                type="button"
                role="tab"
                id={`pl-tab-${each}`}
                aria-selected={each === tab}
                aria-controls="pl-tabpanel"
                tabIndex={each === tab ? 0 : -1}
                onClick={() => props.onTab(each)}
              >
                {tabLabel[each]}
                {each === "settings" && problemCount > 0 && (
                  <span title={t.tabHasProblems} className="pl-tab-warn">
                    <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
                  </span>
                )}
              </button>
            ))}
          </div>
          <div className="pl-tabpanel" id="pl-tabpanel" role="tabpanel" aria-labelledby={`pl-tab-${tab}`}>
            {tab === "panel" && (
              <InstalledPanel
                name={parsed?.key ?? ""}
                workspaceId={props.currentWorkspaceId}
                extra={
                  props.onOpenInRail === undefined ? undefined : (
                    <button type="button" className="pl-btn pp-mini" title={messages.pluginPanel.openInRailTip} onClick={props.onOpenInRail}>
                      <Icon name="panel-right" size={12} strokeWidth={1.8} />
                      {messages.pluginPanel.openInRail}
                    </button>
                  )
                }
              />
            )}
            {tab === "workflow" && workflowBody}
            {tab === "settings" && settingsBody}
          </div>
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
  return t.sourceGitLine(source.url);
}
