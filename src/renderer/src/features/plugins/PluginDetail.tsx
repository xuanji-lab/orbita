/**
 * 插件详情（设计稿第 6 屏的结构，去掉面板 / 自动化 / 版本线三块——那是后几期）：
 * 头部、它能做什么（用不了的标原因）、装在哪、要你填的、来源与版本，
 * 打开文件夹 / 重新载入 / 卸载。旧技能与旧 MCP 同样走这一页，只是能做的动作少几样。
 */
import { useState } from "react";
import { parsePluginViewId, type PluginScope, type PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { ConfigField, ScopeEditor } from "./PluginConfig.tsx";
import { McpAbility, PluginAvatar, ScriptsAbility, SkillAbility, UnsupportedAbility } from "./PluginParts.tsx";
import { PluginPanelCards } from "./PluginPanelCard.tsx";
import { panelProblemText } from "./panel-view.ts";
import { conflictText, problemText } from "./plugin-text.ts";
import { usePanelInfo } from "./usePluginPanel.ts";
import { sourceKey } from "./plugin-view.ts";

const DATE = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "2-digit", day: "2-digit" });

export function PluginDetail(props: {
  view: PluginView;
  workspaces: readonly Workspace[];
  /** 当前会话所在的工作区（面板的数据路径里 `${workspaceFolder}` 按它解析；「在右栏打开」按它判断启没启用） */
  currentWorkspaceId: string | null;
  /** 在右栏打开这个插件的面板 */
  onOpenPanel: (pluginName: string) => void;
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

  return (
    <div className="pl-detail">
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
        <span className="pl-acts">
          {isPlugin && (
            <>
              <button
                type="button"
                className="pl-btn"
                onClick={() => void run(() => api.plugin.reveal(parsed?.key ?? ""))}
              >
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
            <button
              type="button"
              className="pl-btn"
              onClick={() => void run(() => api.skill.reveal(parsed?.key ?? null))}
            >
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
        </span>
      </div>

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

      <div className="pl-cols">
        <div className="pl-col">
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
              <span className="pl-muted">{t.abilitiesEmpty}</span>
            )}
          </section>
          {panelInfo !== null && panelInfo !== undefined && (
            <PluginPanelCards info={panelInfo} onOpen={() => props.onOpenPanel(parsed?.key ?? "")} />
          )}
          {view.problems.length + (panelInfo?.problems.length ?? 0) > 0 && (
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
          )}
        </div>

        <div className="pl-col">
          <section className="pl-card">
            <div className="pl-card-h">{t.scopeTitle}</div>
            <ScopeEditor
              scope={view.scope}
              workspaces={props.workspaces}
              offLabel={t.scopeOff}
              onChange={(scope) => void run(() => props.onScope(scope))}
            />
          </section>

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
        </div>
      </div>
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
