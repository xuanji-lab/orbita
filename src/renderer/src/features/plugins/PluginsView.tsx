/**
 * 插件页（实验功能 plugins）：一个组件、两层外壳。
 * - `chrome="rail"`：右栏单列版。右侧图标条的积木图标打开，与 Files 等共用右栏面板位，
 *   页头住工具栏的右栏胶囊（标题 + 筛选；详情里是返回 + 标题），用户可以一边看对话一边看它。
 * - `chrome="page"`：设置页的「插件」页签，全屏版，页头（发现 / 已装 + 动作）画在页内。
 * 排法**不看外壳看宽度**：根上 `container-type: inline-size`，窄于 640px 一律单列（详情的两列叠成一列、
 * 列表行的次要列收起），见 plugins.css 末尾那一个 `@container pl`。别的 PR 往详情里加的卡片
 * 放进 `.pl-col` 就自动跟着单列，不用逐个适配右栏。
 *
 * 本期：页签「发现」是计划中（显示、禁用、写明）；「已装」按工作区分组——
 * 真插件、你原来的技能、你原来的 MCP 都是这张表里的一行（旧的不搬文件，只是投影），
 * 行尾开关、点行进详情。「接入本地插件」打开安装确认（模态框，两种外壳都一样）。
 * 选中某个插件时同一槽里换成详情；旧技能 / MCP 面板本期保留不动。
 */
import { useEffect, useMemo, useState } from "react";
import type { PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { PanelFilter, PanelIconButton, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { describeList } from "../chat/load-state";
import { InstallDialog } from "./InstallDialog.tsx";
import { PluginDetail } from "./PluginDetail.tsx";
import { PluginAvatar, PluginSwitch } from "./PluginParts.tsx";
import { contentsParts, creatorAvailable, filterPlugins, groupPlugins, legacyCounts, sourceKey, toggleTarget, isActive, type PluginGroup } from "./plugin-view.ts";
import { usePlugins } from "./usePlugins.ts";
import "./plugins.css";

/** 外壳：右栏单列版 / 设置页全屏版。排法不看它，看容器宽度（plugins.css 的 @container pl） */
export type PluginsChrome = "rail" | "page";

export function PluginsView(props: {
  workspaces: readonly Workspace[];
  chrome: PluginsChrome;
  /** 「和智能体一起做一个」：新开一条会话并预填引导（App 接到会话引擎上） */
  onMakeWithAgent: () => void;
  /** 当前会话所在的工作区：详情页里面板的数据路径与「在右栏打开」按它判断 */
  currentWorkspaceId: string | null;
  onOpenPanel: (pluginName: string) => void;
}) {
  const messages = useT();
  const t = messages.plugins;
  const rail = props.chrome === "rail";
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
  const filtering = query.trim() !== "";
  const makeAvailable = creatorAvailable(state.plugins);

  const toggle = async (view: PluginView): Promise<void> => {
    setToggleError(null);
    try {
      await state.setScope(view.id, toggleTarget(view));
    } catch (cause) {
      setToggleError(t.actionFailed(cause instanceof Error ? cause.message : String(cause)));
    }
  };

  // 「接入本地插件」「和智能体一起做一个」：两种外壳同一对按钮，只是摆的位置不同（右栏在列表顶上，全屏在页头右侧）
  const actions = (
    <>
      <button type="button" className="pl-btn" onClick={() => setInstalling(true)}>
        <Icon name="folder-open" size={13} strokeWidth={1.8} />
        {t.connectLocal}
      </button>
      <button
        type="button"
        className="pl-btn"
        disabled={!makeAvailable}
        title={makeAvailable ? t.makeWithAgentTip : t.makeWithAgentOffTip}
        onClick={props.onMakeWithAgent}
      >
        <Icon name="bot" size={13} strokeWidth={1.8} />
        {t.makeWithAgent}
      </button>
    </>
  );

  const listBody = (
    <>
      {rail ? (
        <div className="pl-top">{actions}</div>
      ) : (
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
      )}

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
  );

  const detailBody =
    selected === null ? null : (
      <PluginDetail
        key={selected.id}
        view={selected}
        workspaces={workspaces}
        // 右栏版的返回键在胶囊里；全屏版在页内
        showBack={!rail}
        currentWorkspaceId={props.currentWorkspaceId}
        onOpenPanel={props.onOpenPanel}
        onBack={() => setSelectedId(null)}
        onScope={(scope) => state.setScope(selected.id, scope)}
        onChanged={state.refresh}
        onUninstalled={() => setSelectedId(null)}
      />
    );

  // 安装确认是模态框（portal 到 body），不随外壳变
  const dialog = installing ? (
    <InstallDialog
      workspaces={workspaces}
      onClose={() => setInstalling(false)}
      onInstalled={(id) => {
        setInstalling(false);
        // 先回读再选中：选中的 id 在刷新回来之前找不到，「选中的那条没了就回列表」会把它当场清掉
        void state.refresh().then(() => setSelectedId(id));
      }}
    />
  ) : null;

  if (rail) {
    // 页头住工具栏的右栏胶囊（RightPanelFrame 把它 portal 过去）：列表 = 标题 + 筛选；详情 = 返回 + 标题
    const header =
      selected === null ? (
        <>
          <PanelTitle icon="blocks" title={t.title} />
          <PanelFilter
            value={query}
            onChange={setQuery}
            placeholder={t.filterPlaceholder}
            ariaLabel={t.filterAria}
            count={filtering ? `${filtered.length} / ${state.plugins.length}` : String(state.plugins.length)}
          />
        </>
      ) : (
        <>
          <PanelIconButton title={t.backToInstalled} onClick={() => setSelectedId(null)}>
            <Icon name="chevron-left" size={16} strokeWidth={2} />
          </PanelIconButton>
          <strong className="cap-title">{t.title}</strong>
        </>
      );
    return (
      <>
        <RightPanelFrame header={header} contentKey={selected === null ? "list" : `detail:${selected.id}`}>
          <div className="pl-page" data-chrome="rail">
            <div className="pl-body">{selected === null ? listBody : detailBody}</div>
          </div>
        </RightPanelFrame>
        {dialog}
      </>
    );
  }

  return (
    <div className="pl-page" data-chrome="page">
      {selected === null && (
        <div className="pl-head">
          <span className="pl-seg" role="group" aria-label={t.title}>
            <button type="button" disabled title={t.tabFindTip} aria-pressed={false}>
              {t.tabFind}
            </button>
            <button type="button" aria-pressed={true}>
              {t.tabInstalled} <span className="pl-seg-count">{state.plugins.length}</span>
            </button>
          </span>
          <span className="pl-head-actions">{actions}</span>
        </div>
      )}
      <div className="pl-body scroll">{selected === null ? listBody : detailBody}</div>
      {dialog}
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
    builtin: t.sourceBuiltin,
    userSkill: t.sourceUserSkill,
    userMcp: t.sourceUserMcp,
    copy: t.sourceCopy,
    link: t.sourceLink,
    git: t.sourceGit,
  }[sourceKey(view)];
  return (
    <div className="pl-row" data-active={active}>
      {/* 窄了行里收起「里面有什么 / 来源」（plugins.css），悬停时仍能读到 */}
      <button type="button" className="pl-row-main" title={`${kindsLine === "" ? t.contentEmpty : kindsLine} · ${sourceLabel}`} onClick={props.onOpen}>
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
