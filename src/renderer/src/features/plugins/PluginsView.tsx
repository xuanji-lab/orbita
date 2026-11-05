/**
 * 插件页（实验功能 plugins）：右侧图标条的积木图标打开，占中间主槽，不进设置页——
 * 它是常用入口，不是偶尔改一次的设置（设计稿第 1 问）。
 *
 * 本期：页签「发现」是计划中（显示、禁用、写明）；「已装」按工作区分组——
 * 真插件、你原来的技能、你原来的 MCP 都是这张表里的一行（旧的不搬文件，只是投影），
 * 行尾开关、点行进详情。头部「接入本地插件」打开安装确认。
 * 选中某个插件时同一槽里换成详情；旧技能 / MCP 面板本期保留不动。
 */
import { useEffect, useMemo, useState } from "react";
import type { PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { describeList } from "../chat/load-state";
import { InstallDialog } from "./InstallDialog.tsx";
import { PluginDetail } from "./PluginDetail.tsx";
import { PluginAvatar, PluginSwitch } from "./PluginParts.tsx";
import { contentsParts, filterPlugins, groupPlugins, legacyCounts, sourceKey, toggleTarget, isActive, type PluginGroup } from "./plugin-view.ts";
import { usePlugins } from "./usePlugins.ts";
import "./plugins.css";

export function PluginsView(props: { workspaces: readonly Workspace[] }) {
  const messages = useT();
  const t = messages.plugins;
  const state = usePlugins(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [query, setQuery] = useState("");
  const [toggleError, setToggleError] = useState<string | null>(null);

  const selected = selectedId === null ? null : (state.plugins.find((view) => view.id === selectedId) ?? null);
  // 选中的那条没了（在别处被删 / 刚卸载）：回列表
  useEffect(() => {
    if (selectedId !== null && state.load.kind === "ready" && selected === null) setSelectedId(null);
  }, [selectedId, selected, state.load.kind]);

  const workspaces = props.workspaces;
  const filtered = useMemo(() => filterPlugins(state.plugins, query), [state.plugins, query]);
  const groups = useMemo(() => groupPlugins(filtered, workspaces), [filtered, workspaces]);
  const legacy = legacyCounts(state.plugins);
  const list = describeList(state.load, state.plugins.length);

  const toggle = async (view: PluginView): Promise<void> => {
    setToggleError(null);
    try {
      await state.setScope(view.id, toggleTarget(view));
    } catch (cause) {
      setToggleError(t.actionFailed(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  return (
    <div className="pl-page">
      {selected === null && (
        <div className="pl-head">
          <h2 className="pl-head-title">{t.title}</h2>
          <span className="pl-seg" role="group" aria-label={t.title}>
            <button type="button" disabled title={t.tabFindTip} aria-pressed={false}>
              {t.tabFind}
            </button>
            <button type="button" aria-pressed={true}>
              {t.tabInstalled} <span className="pl-seg-count">{state.plugins.length}</span>
            </button>
          </span>
          <span className="pl-head-actions">
            <button type="button" className="pl-btn" onClick={() => setInstalling(true)}>
              <Icon name="folder-open" size={13} strokeWidth={1.8} />
              {t.connectLocal}
            </button>
            <button type="button" className="pl-btn" disabled title={t.planned}>
              <Icon name="bot" size={13} strokeWidth={1.8} />
              {t.makeWithAgent}
            </button>
          </span>
        </div>
      )}

      <div className="pl-body scroll">
        {selected !== null ? (
          <PluginDetail
            key={selected.id}
            view={selected}
            workspaces={workspaces}
            onBack={() => setSelectedId(null)}
            onScope={(scope) => state.setScope(selected.id, scope)}
            onChanged={state.refresh}
            onUninstalled={() => setSelectedId(null)}
          />
        ) : (
          <>
            <div className="pl-bar">
              <label className="pl-search">
                <Icon name="search" size={13} strokeWidth={1.8} />
                <input
                  value={query}
                  placeholder={t.filterPlaceholder}
                  aria-label={t.filterAria}
                  spellCheck={false}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <span className="pl-chips" role="group">
                <button type="button" aria-pressed={true}>
                  {t.groupByWorkspace}
                </button>
                <button type="button" disabled title={t.planned} aria-pressed={false}>
                  {t.groupByRecent}
                </button>
              </span>
            </div>

            {list.error !== null && (
              <div className="pl-note danger" role="alert">
                <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                <span>
                  {t.loadFailed} {list.error}
                </span>
              </div>
            )}
            {state.mcpError !== null && (
              <div className="pl-note warn" role="alert">
                <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                <span>{t.mcpError(state.mcpError)}</span>
              </div>
            )}
            {toggleError !== null && (
              <div className="pl-note danger" role="alert">
                <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
                <span>{toggleError}</span>
              </div>
            )}
            {(legacy.skills > 0 || legacy.mcp > 0) && (
              <div className="pl-note">
                <Icon name="info" size={14} strokeWidth={1.8} />
                <span>{t.legacyNote(legacy.skills, legacy.mcp)}</span>
              </div>
            )}

            {list.body === "loading" && <p className="pl-empty">{messages.common.loading}</p>}
            {list.body === "empty" && (
              <div className="pl-empty">
                <b>{t.emptyTitle}</b>
                <span>{t.emptyHint}</span>
              </div>
            )}
            {list.body === "list" && groups.length === 0 && <p className="pl-empty">{t.noMatch(query.trim())}</p>}
            {groups.map((group) => (
              <GroupCard key={groupKey(group)} group={group} onOpen={setSelectedId} onToggle={(view) => void toggle(view)} />
            ))}
          </>
        )}
      </div>

      {installing && (
        <InstallDialog
          workspaces={workspaces}
          onClose={() => setInstalling(false)}
          onInstalled={(id) => {
            setInstalling(false);
            // 先回读再选中：选中的 id 在刷新回来之前找不到，「选中的那条没了就回列表」会把它当场清掉
            void state.refresh().then(() => setSelectedId(id));
          }}
        />
      )}
    </div>
  );
}

function groupKey(group: PluginGroup): string {
  return group.kind === "workspace" ? `ws:${group.workspace.id}` : group.kind;
}

function GroupCard(props: { group: PluginGroup; onOpen: (id: string) => void; onToggle: (view: PluginView) => void }) {
  const t = useT().plugins;
  const { group } = props;
  const title = group.kind === "global" ? t.groupAll : group.kind === "none" ? t.groupNone : group.workspace.name;
  return (
    <section className="pl-grp" aria-label={title}>
      <div className="pl-gh">
        <Icon name={group.kind === "global" ? "globe" : group.kind === "none" ? "circle-off" : "folder"} size={14} strokeWidth={1.8} />
        <b>{title}</b>
        <span className="pl-gh-count">{t.groupCount(group.items.length)}</span>
      </div>
      {group.items.map((view) => (
        <PluginRow key={view.id} view={view} onOpen={() => props.onOpen(view.id)} onToggle={() => props.onToggle(view)} />
      ))}
    </section>
  );
}

function PluginRow(props: { view: PluginView; onOpen: () => void; onToggle: () => void }) {
  const t = useT().plugins;
  const { view } = props;
  const active = isActive(view);
  const parts = contentsParts(view.contents);
  const kindsLine = parts
    .map((part) => (part.kind === "skills" ? t.contentSkills(part.count) : part.kind === "mcp" ? t.contentMcp(part.count) : t.contentScripts))
    .join(" · ");
  const sourceLabel = {
    userSkill: t.sourceUserSkill,
    userMcp: t.sourceUserMcp,
    copy: t.sourceCopy,
    link: t.sourceLink,
    git: t.sourceGit,
  }[sourceKey(view)];
  return (
    <div className="pl-row" data-active={active}>
      <button type="button" className="pl-row-main" onClick={props.onOpen}>
        <PluginAvatar view={view} />
        <span className="pl-name">
          <b>{view.name}</b>
          <small className={view.origin === "user-mcp" ? "mono" : undefined}>{view.description}</small>
        </span>
        <span className="pl-kinds">{kindsLine === "" ? t.contentEmpty : kindsLine}</span>
        <span className="pl-from">{sourceLabel}</span>
      </button>
      <PluginSwitch checked={active} label={active ? t.toggleOff(view.name) : t.toggleOn(view.name)} onChange={props.onToggle} />
    </div>
  );
}
