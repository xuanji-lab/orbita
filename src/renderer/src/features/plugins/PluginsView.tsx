/**
 * 插件页（实验功能 plugins）：一个组件、两层外壳。
 * - `chrome="rail"`：右栏单列版。右侧图标条的积木图标打开，与 Files 等共用右栏面板位，
 *   页头住工具栏的右栏胶囊（标题 + 筛选；详情里是返回 + 标题），用户可以一边看对话一边看它。
 * - `chrome="page"`：设置页的「插件」页签，全屏版，页头（发现 / 已装 + 动作）画在页内。
 * 排法**不看外壳看宽度**：根上 `container-type: inline-size`，窄于 640px 一律单列（详情的两列叠成一列、
 * 列表行的次要列收起），见 plugins.css 末尾那一个 `@container pl`。别的 PR 往详情里加的卡片
 * 放进 `.pl-col` 就自动跟着单列，不用逐个适配右栏。
 *
 * 全屏版的列表是**按工作区分组的卡片墙**（学设置 › 模型服务的大 / 小卡，样式在 settings/card-wall.css）：
 * 大卡 = 头像 + 名字 + 一句话 + 来源 · 里面有什么，右上「已启用」；小卡一行 = 头像 + 名字 + 启用勾；
 * 启用开关悬停（或键盘聚焦）才浮出，与模型服务卡的「+」同一处理。页头的「大 / 小」与「仅显示已启用」
 * 记在设置里（AppSettings.pluginsPage，切页 / 重载后保持）。窄于 640 时同一页退回安静列表——
 * 卡片墙与列表是页签里的两棵子树，哪棵显示由 plugins.css 的容器查询定，JS 不量宽度；
 * 右栏版只有列表，也不受这两个状态影响。
 *
 * 本期：页签「发现」是计划中（显示、禁用、写明）；「已装」按工作区分组——
 * 真插件、你原来的技能、你原来的 MCP 都是这张表里的一行（旧的不搬文件，只是投影），
 * 行尾开关、点行进详情。「接入本地插件」打开安装确认（模态框，两种外壳都一样）。
 * 选中某个插件时同一槽里换成详情；旧技能 / MCP 面板本期保留不动。
 */
import { useEffect, useMemo, useState } from "react";
import type { PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import type { CardSize, PluginsPageSettings } from "@shared/settings";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { Icon } from "../../shell/Icon";
import { PanelFilter, PanelIconButton, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { describeList } from "../chat/load-state";
import { InstallDialog } from "./InstallDialog.tsx";
import { PluginDetail } from "./PluginDetail.tsx";
import { PluginAvatar, PluginSwitch } from "./PluginParts.tsx";
import { contentsParts, filterEnabled, filterPlugins, groupPlugins, legacyCounts, sourceKey, toggleTarget, isActive, type PluginGroup } from "./plugin-view.ts";
import { usePlugins } from "./usePlugins.ts";
import "./plugins.css";

/** 外壳：右栏单列版 / 设置页全屏版。排法不看它，看容器宽度（plugins.css 的 @container pl） */
export type PluginsChrome = "rail" | "page";

export function PluginsView(props: {
  workspaces: readonly Workspace[];
  chrome: PluginsChrome;
  /** 全屏版的界面记忆（AppSettings.pluginsPage）；右栏版不传，也没有这两个状态 */
  page?: PluginsPageSettings;
  onPage?: (patch: PluginsPageSettings) => void;
}) {
  const messages = useT();
  const t = messages.plugins;
  const rail = props.chrome === "rail";
  const state = usePlugins(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [query, setQuery] = useState("");
  const [toggleError, setToggleError] = useState<string | null>(null);
  // 大 / 小与「仅显示已启用」记在设置里（同模型服务页）：本地先切，不等写盘回来；右栏版恒为全部显示
  const [cardSize, setCardSizeState] = useState<CardSize>(props.page?.cardSize ?? "large");
  const [onlyEnabledState, setOnlyEnabledState] = useState(props.page?.onlyEnabled ?? false);
  useEffect(() => setCardSizeState(props.page?.cardSize ?? "large"), [props.page?.cardSize]);
  useEffect(() => setOnlyEnabledState(props.page?.onlyEnabled ?? false), [props.page?.onlyEnabled]);
  const onlyEnabled = !rail && onlyEnabledState;
  const setCardSize = (next: CardSize) => {
    setCardSizeState(next);
    props.onPage?.({ cardSize: next });
  };
  const setOnlyEnabled = (next: boolean) => {
    setOnlyEnabledState(next);
    props.onPage?.({ onlyEnabled: next });
  };

  const selected = selectedId === null ? null : (state.plugins.find((view) => view.id === selectedId) ?? null);
  // 选中的那条没了（在别处被删 / 刚卸载）：回列表
  useEffect(() => {
    if (selectedId !== null && state.load.kind === "ready" && selected === null) setSelectedId(null);
  }, [selectedId, selected, state.load.kind]);

  const workspaces = props.workspaces;
  const filtered = useMemo(
    () => filterEnabled(filterPlugins(state.plugins, query), onlyEnabled),
    [state.plugins, query, onlyEnabled],
  );
  const groups = useMemo(() => groupPlugins(filtered, workspaces), [filtered, workspaces]);
  const legacy = legacyCounts(state.plugins);
  const list = describeList(state.load, state.plugins.length);
  const filtering = query.trim() !== "";
  const enabledCount = state.plugins.filter(isActive).length;

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
      <button type="button" className="pl-btn" disabled title={t.planned}>
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
          <span className="pl-bar-end">
            <button type="button" className="pl-btn" aria-pressed={onlyEnabled} onClick={() => setOnlyEnabled(!onlyEnabled)}>
              <Icon name="list-filter" size={13} strokeWidth={1.8} />
              {t.onlyEnabled}
              <span className="pl-seg-count">{enabledCount}</span>
            </button>
            {/* 窄了（退回列表）这一组收起：列表没有大小之分 */}
            <span className="pv-seg pl-size-seg" role="group" aria-label={t.cardSize}>
              {(["large", "small"] as const).map((size) => (
                <button key={size} type="button" aria-pressed={cardSize === size} title={t.cardSizes[size]} onClick={() => setCardSize(size)}>
                  <Icon name={size === "large" ? "layout-grid" : "grid-3x3"} size={13} strokeWidth={1.8} /> {t.cardSizes[size]}
                </button>
              ))}
            </span>
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
      {list.body === "list" && groups.length === 0 && (
        <p className="pl-empty">{onlyEnabled && !filtering ? t.noneEnabled : t.noMatch(query.trim())}</p>
      )}
      {/* 全屏版同时带卡片墙与安静列表两棵树，哪棵显示由容器宽度定（plugins.css）；右栏版只有列表 */}
      {!rail && groups.length > 0 && (
        <div className="pl-wall">
          {groups.map((group) => (
            <WallGroup
              key={groupKey(group)}
              group={group}
              size={cardSize}
              onOpen={setSelectedId}
              onToggle={(view) => void toggle(view)}
            />
          ))}
        </div>
      )}
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

function groupTitle(t: Messages["plugins"], group: PluginGroup): string {
  return group.kind === "global" ? t.groupAll : group.kind === "none" ? t.groupNone : group.workspace.name;
}

/** 分组头：图标 + 组名 + 数量。列表（卡片底里）与卡片墙共用 */
function GroupHead(props: { group: PluginGroup }) {
  const t = useT().plugins;
  const { group } = props;
  return (
    <div className="pl-gh">
      <Icon name={group.kind === "global" ? "globe" : group.kind === "none" ? "circle-off" : "folder"} size={14} strokeWidth={1.8} />
      <b>{groupTitle(t, group)}</b>
      <span className="pl-gh-count">{t.groupCount(group.items.length)}</span>
    </div>
  );
}

/** 一行 / 一张卡共用的两段小字：里面有什么、来源 */
function describePlugin(t: Messages["plugins"], view: PluginView): { kindsLine: string; sourceLabel: string } {
  const kindsLine = contentsParts(view.contents)
    .map((part) => (part.kind === "skills" ? t.contentSkills(part.count) : part.kind === "mcp" ? t.contentMcp(part.count) : t.contentScripts))
    .join(" · ");
  const sourceLabel = {
    userSkill: t.sourceUserSkill,
    userMcp: t.sourceUserMcp,
    copy: t.sourceCopy,
    link: t.sourceLink,
    git: t.sourceGit,
  }[sourceKey(view)];
  return { kindsLine: kindsLine === "" ? t.contentEmpty : kindsLine, sourceLabel };
}

/** 卡片墙里的一组：组头 + 大 / 小卡网格（卡片墙的外壳类是模型服务页那套 pv-*，见 card-wall.css） */
function WallGroup(props: {
  group: PluginGroup;
  size: CardSize;
  onOpen: (id: string) => void;
  onToggle: (view: PluginView) => void;
}) {
  const t = useT().plugins;
  const { group } = props;
  return (
    <section className="pv-wall-group" aria-label={groupTitle(t, group)}>
      <GroupHead group={group} />
      <div className={`pv-cards ${props.size}`}>
        {group.items.map((view) => (
          <PluginCard key={view.id} view={view} size={props.size} onOpen={() => props.onOpen(view.id)} onToggle={() => props.onToggle(view)} />
        ))}
      </div>
    </section>
  );
}

/**
 * 一张插件卡。大卡：头像、名字、一句话、底行（来源 · 里面有什么），右上「已启用」；小卡一行只留头像、
 * 名字与启用勾（说明进悬停）。启用开关悬停或键盘聚焦才浮出（模型服务卡的「+」同款），不占卡面。
 * 卡片本身是 div + role="button"：里面还套着开关，button 不能嵌 button。
 */
function PluginCard(props: { view: PluginView; size: CardSize; onOpen: () => void; onToggle: () => void }) {
  const t = useT().plugins;
  const { view } = props;
  const active = isActive(view);
  const large = props.size === "large";
  const { kindsLine, sourceLabel } = describePlugin(t, view);
  const foot = `${sourceLabel} · ${kindsLine}`;
  // 已启用：图标 + 文字（不只靠颜色）；小卡只留图标，文字进 aria-label
  const badge = active ? (
    <span className="pv-added-badge" {...(large ? {} : { role: "img", "aria-label": t.enabled, title: t.enabled })}>
      <Icon name="circle-check" size={12} strokeWidth={1.8} />
      {large && <span>{t.enabled}</span>}
    </span>
  ) : null;
  const toggle = (
    // 点开关不该同时进详情
    <span className="pl-card-switch" onClick={(event) => event.stopPropagation()}>
      <PluginSwitch checked={active} label={active ? t.toggleOff(view.name) : t.toggleOn(view.name)} onChange={props.onToggle} />
    </span>
  );
  return (
    <div
      role="button"
      tabIndex={0}
      className="pv-vcard pl-vcard"
      data-active={active}
      title={large ? undefined : `${view.name} — ${view.description} · ${foot}`}
      onClick={props.onOpen}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          props.onOpen();
        }
      }}
    >
      {large ? (
        <>
          <span className="pv-vcard-top">
            <PluginAvatar view={view} big />
            {badge}
          </span>
          <span className="pv-vcard-text">
            <span className="pv-vcard-name">{view.name}</span>
            <span className={`pv-vcard-note pl-vcard-note${view.origin === "user-mcp" ? " mono" : ""}`}>{view.description}</span>
          </span>
          <span className="pv-vcard-foot">{foot}</span>
        </>
      ) : (
        <>
          <PluginAvatar view={view} />
          <span className="pv-vcard-name">{view.name}</span>
          {badge}
        </>
      )}
      {toggle}
    </div>
  );
}

function GroupCard(props: { group: PluginGroup; onOpen: (id: string) => void; onToggle: (view: PluginView) => void }) {
  const t = useT().plugins;
  const { group } = props;
  return (
    <section className="pl-grp" aria-label={groupTitle(t, group)}>
      <GroupHead group={group} />
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
  const { kindsLine, sourceLabel } = describePlugin(t, view);
  return (
    <div className="pl-row" data-active={active}>
      {/* 窄了行里收起「里面有什么 / 来源」（plugins.css），悬停时仍能读到 */}
      <button type="button" className="pl-row-main" title={`${kindsLine} · ${sourceLabel}`} onClick={props.onOpen}>
        <PluginAvatar view={view} />
        <span className="pl-name">
          <b>{view.name}</b>
          <small className={view.origin === "user-mcp" ? "mono" : undefined}>{view.description}</small>
        </span>
        <span className="pl-kinds">{kindsLine}</span>
        <span className="pl-from">{sourceLabel}</span>
      </button>
      <PluginSwitch checked={active} label={active ? t.toggleOff(view.name) : t.toggleOn(view.name)} onChange={props.onToggle} />
    </div>
  );
}
