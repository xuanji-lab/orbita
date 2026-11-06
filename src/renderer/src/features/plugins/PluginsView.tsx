/**
 * 插件页：一个组件、两层外壳。
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
 * 「/ + 空格」选取态（右栏版、App 传 picker）：同一张列表换成选取排法——顶上搜索框接筛选、↑↓ 选、↵ 插入整个插件、
 * → 展开里面的技能、Esc 取消；这个工作区没启用的排下面灰着、选了只提示（PluginPicker.tsx、plugin-picker.ts）。
 * 选中某个插件时同一槽里换成详情（一张长页）；详情里点「打开看板」右栏换成看板视图；旧技能 / MCP 面板本期保留不动。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parsePluginViewId, type PluginDraftEntry, type PluginView } from "@shared/plugin";
import type { Workspace } from "@shared/workspace";
import type { CardSize, PluginsPageSettings } from "@shared/settings";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { PanelFilter, PanelIconButton, PanelTitle, RightPanelFrame } from "../../shell/RightPanel";
import { relativeTime } from "../../shell/relative-time";
import { WorkspaceFilterBar, useWorkspaceFilter } from "../../shell/WorkspaceFilterBar.tsx";
import { buildOptions, defaultFilter, type WsAllow } from "../../shell/workspace-filter.ts";
import type { TokenPickerControl } from "../../shell/panel-token.ts";
import { describeList } from "../chat/load-state";
import { InstallDialog } from "./InstallDialog.tsx";
import { PluginDetail } from "./PluginDetail.tsx";
import { PluginDraftView } from "./PluginDraftView.tsx";
import { PluginBoardView } from "./PluginBoardView.tsx";
import { ArchivedAbilities, KindTag } from "./AbilitySections.tsx";
import { PluginAvatar, PluginSwitch } from "./PluginParts.tsx";
import { PluginPickerBar, PluginPickerGroup } from "./PluginPicker.tsx";
import { activateRow, buildPicker, clampPick, collapseRow, expandRow, indexOfPlugin, movePick, type PickerOutcome } from "./plugin-picker.ts";
import { filterDrafts, groupDrafts, type PluginDraftTarget } from "./plugin-draft.ts";
import { useDraftList } from "./useDraftList.ts";
import { contentsParts, creatorAvailable, filterEnabled, filterPlugins, groupUsable, isMissingSkillView, legacyCounts, pluginFilterCounts, rangeOf, sourceKey, toggleTarget, isActive, type PluginGroup, type RangeLabel } from "./plugin-view.ts";
import { usePlugins } from "./usePlugins.ts";
import "./plugins.css";

/** 外壳：右栏单列版 / 设置页全屏版。排法不看它，看容器宽度（plugins.css 的 @container pl） */
export type PluginsChrome = "rail" | "page";

/** 能力面板的选择条：有「全局」档，没有「任务」档（没有工作区的会话能用的就是全局的） */
const ABILITY_FILTER_ALLOW: WsAllow = { tasks: false, global: true };

/** 「在右栏打开」的请求在列表里找不到那个插件时，最多等列表更新多久再放弃 */
const OPEN_REQUEST_WAIT_MS = 5000;

/**
 * 「在右栏打开这个插件」的请求：nonce 每次递增，同一个插件连点两次也会再选一次。
 * `board` = 打开它的看板视图（设置里的全屏版点「打开看板」）；否则打开详情（装好之后）。
 */
export interface PluginOpenRequest {
  name: string;
  nonce: number;
  board: boolean;
}

export function PluginsView(props: {
  workspaces: readonly Workspace[];
  chrome: PluginsChrome;
  /** 当前会话所在的工作区：看板的数据路径与启没启用按它判断 */
  currentWorkspaceId: string | null;
  /** 全屏版详情页的「打开看板」：App 关掉设置、打开右栏插件页并回一个 openRequest 过来（右栏版自己进看板视图，不用它） */
  onOpenBoard: (pluginName: string) => void;
  /** 全屏版的界面记忆（AppSettings.pluginsPage）；右栏版不传，也没有这两个状态 */
  page?: PluginsPageSettings;
  onPage?: (patch: PluginsPageSettings) => void;
  /** 「和智能体一起做一个」：新开一条会话并预填引导（App 接到会话引擎上；设置里的全屏版随之退场） */
  onMakeWithAgent: () => void;
  /** 右栏版收到的请求：选中该插件（并按请求进它的看板视图）；处理完调 onOpenRequestHandled（全屏版不传） */
  openRequest?: PluginOpenRequest | null;
  onOpenRequestHandled?: () => void;
  /** 正在看的草稿；非 null 时右栏版显示「正在做」长页（全屏版不传）。来源：agent 刚预览了它，或用户在列表的「正在做」组里点了它 */
  draft?: PluginDraftTarget | null;
  onLeaveDraft?: () => void;
  /** 点「正在做」组里的一行：App 把它设成要看的草稿（全屏版还要先退出设置、打开右栏插件页） */
  onOpenDraft: (draft: PluginDraftTarget) => void;
  /** 点「正在做」组里的「回到对话」：打开做它的那条会话，右栏直接是该草稿的长页（全屏版随之退出设置） */
  onOpenSession: (sessionId: string, draftPath: string) => void;
  /** 「/ + 空格」选取态：只有主槽右栏的 App 提供 */
  picker?: TokenPickerControl;
}) {
  const messages = useT();
  const t = messages.plugins;
  const rail = props.chrome === "rail";
  const state = usePlugins(true);
  const draftList = useDraftList(true, state.plugins, props.draft?.path ?? null);
  const [selectedId, setSelectedIdRaw] = useState<string | null>(null);
  // 右栏里看的是详情还是看板视图：换了插件就回详情
  const [boardOpen, setBoardOpen] = useState(false);
  const setSelectedId = (id: string | null): void => {
    setSelectedIdRaw(id);
    setBoardOpen(false);
  };
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

  // ── 「/ + 空格」选取态（plugin-picker.ts 排行与按键语义；这里管状态、焦点与画）─────────────
  const { picker } = props;
  const picking = rail && picker !== undefined;
  const [pickIndex, setPickIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [pickNotice, setPickNotice] = useState<string | null>(null);
  const pickListRef = useRef<HTMLDivElement>(null);
  // 焦点：「/ + 空格」后落到搜索框。搜索框住在工具栏的右栏胶囊里（portal）：面板从关着打开时胶囊这一拍才挂上，
  // 只在 effect 里 focus 会落空，所以记一个「欠一次聚焦」，输入框真挂上时（回调 ref）补上
  const filterEl = useRef<HTMLInputElement | null>(null);
  const focusOwed = useRef(false);
  const filterRef = useCallback((el: HTMLInputElement | null) => {
    filterEl.current = el;
    if (el !== null && focusOwed.current) {
      focusOwed.current = false;
      el.focus();
    }
  }, []);
  const { draft: shownDraftTarget, onLeaveDraft } = props;
  useEffect(() => {
    if (picker === undefined) return;
    // 每次「/ + 空格」从干净的状态起：回列表（不在详情 / 草稿里）、清词、不展开、亮第一行
    setSelectedIdRaw(null);
    setBoardOpen(false);
    if (shownDraftTarget != null) onLeaveDraft?.();
    setQuery("");
    setPickIndex(0);
    setExpandedId(null);
    setPickNotice(null);
    focusOwed.current = true;
    const el = filterEl.current;
    if (el !== null) {
      focusOwed.current = false;
      el.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker?.request]);
  const pickModel = useMemo(
    () => buildPicker(state.plugins, props.currentWorkspaceId, query, expandedId),
    [state.plugins, props.currentWorkspaceId, query, expandedId],
  );
  const pickCount = pickModel.flat.length;
  // 行变了（筛选、展开收起、列表读回来）：高亮夹回范围
  useEffect(() => {
    if (picking) setPickIndex((index) => clampPick(index, pickCount));
  }, [picking, pickCount]);
  // 高亮行滚进视野：只动列表自己的纵向滚动。不用 scrollIntoView——它连祖先也横着滚：
  // 「/ + 空格」从关着的面板进来时右栏壳还在从 0 宽展开，高亮行横向「不在视野里」，浏览器就把 overflow:hidden 的壳横滚一点
  useEffect(() => {
    if (!picking) return;
    const row = pickListRef.current?.querySelector<HTMLElement>('[data-pick-active="true"]');
    let scroller = row?.parentElement ?? null;
    while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    if (row == null || scroller === null) return;
    const view = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
    else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom;
  }, [picking, pickIndex, pickCount]);

  const changePickQuery = (next: string): void => {
    setQuery(next);
    setPickIndex(0);
    setPickNotice(null);
  };
  /** 执行一次按键 / 点击的结果（算在 plugin-picker.ts，这里只落到状态上） */
  const runPick = (outcome: PickerOutcome): void => {
    if (picker === undefined) return;
    if (outcome.kind === "insert") picker.onSelect(outcome.token);
    else if (outcome.kind === "blocked") setPickNotice(t.pickBlocked(outcome.name));
    else if (outcome.kind === "expand") setExpandedId(outcome.id);
    else if (outcome.kind === "collapse") {
      // 收起后高亮落回那个插件行（技能行没了）
      setExpandedId(null);
      setPickIndex(indexOfPlugin(buildPicker(state.plugins, props.currentWorkspaceId, query, null).flat, outcome.id));
    }
  };
  /** 选取态的键盘：↑↓ 移高亮、↵ 插入、→ 展开（光标在词尾才接管）、← 收起、Esc 先清词再取消 */
  const onPickKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (picker === undefined || event.nativeEvent.isComposing) return;
    const row = pickModel.flat[pickIndex];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setPickNotice(null);
      setPickIndex((index) => movePick(index, event.key === "ArrowDown" ? 1 : -1, pickCount));
    } else if (event.key === "Enter") {
      event.preventDefault();
      runPick(activateRow(row));
    } else if (event.key === "ArrowRight") {
      // 词中间的 → 是在移光标：只有光标已在词尾才当「展开」
      const input = event.currentTarget;
      if (input.selectionStart !== input.value.length || input.selectionEnd !== input.value.length) return;
      const outcome = expandRow(row);
      if (outcome.kind === "none") return;
      event.preventDefault();
      runPick(outcome);
    } else if (event.key === "ArrowLeft") {
      const outcome = collapseRow(row);
      if (outcome.kind === "none") return;
      event.preventDefault();
      runPick(outcome);
    } else if (event.key === "Escape") {
      // 两段式：人还在搜就先清词；词空了才退出选取（App 的全局 Esc 不能接着关面板）
      event.preventDefault();
      event.stopPropagation();
      if (query !== "") changePickQuery("");
      else picker.onCancel();
    }
  };
  const currentWorkspaceName = props.workspaces.find((workspace) => workspace.id === props.currentWorkspaceId)?.name ?? null;

  // 「在右栏打开」：等列表读到、找到那个插件，就选中它（看板请求直接进看板视图）。
  // 找不到时**留着请求等列表更新**：装好之后马上来的请求（agent 装完 / 点了对话里的「安装」）常常早于列表的重读——
  // 页面已经开着、列表还是装之前的，此刻丢掉请求，右栏就停在列表里不进详情。所以找不到就主动重读一次，
  // 列表一变（`state.plugins` 换了引用）这个 effect 重跑再找；等不到（刚卸载的、拼错的名字）过了 OPEN_REQUEST_WAIT_MS 才放弃。
  const { openRequest = null, onOpenRequestHandled } = props;
  const { refresh } = state;
  const refreshedFor = useRef<PluginOpenRequest | null>(null);
  useEffect(() => {
    if (openRequest === null || state.load.kind !== "ready") return;
    const target = state.plugins.find((view) => view.origin === "plugin" && parsePluginViewId(view.id)?.key === openRequest.name);
    if (target !== undefined) {
      setSelectedIdRaw(target.id);
      setBoardOpen(openRequest.board);
      onOpenRequestHandled?.();
      return;
    }
    if (refreshedFor.current !== openRequest) {
      refreshedFor.current = openRequest;
      void refresh();
    }
    const timer = window.setTimeout(() => onOpenRequestHandled?.(), OPEN_REQUEST_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [openRequest, state.load.kind, state.plugins, onOpenRequestHandled, refresh]);

  const workspaces = props.workspaces;
  const filtered = useMemo(
    () => filterEnabled(filterPlugins(state.plugins, query), onlyEnabled),
    [state.plugins, query, onlyEnabled],
  );
  // 工作区选择条：没选过时默认当前会话所在的工作区（Home / 无工作区 = 全部），选过后面板自己记住
  const [wsFilter, setWsFilter] = useWorkspaceFilter("capabilities", defaultFilter(props.currentWorkspaceId, workspaces), workspaces, ABILITY_FILTER_ALLOW);
  const wsOptions = useMemo(() => {
    const counts = pluginFilterCounts(state.plugins, workspaces);
    return buildOptions({ workspaces, total: counts.total, perWorkspace: counts.perWorkspace, tasks: null, global: counts.global, selected: wsFilter, hideEmpty: false });
  }, [state.plugins, workspaces, wsFilter]);
  const wsBar = <WorkspaceFilterBar options={wsOptions} workspaces={workspaces} selected={wsFilter} onSelect={setWsFilter} />;
  // 「全部」= 按位置分组；选了某个工作区 / 全局 = 一组「它能用的」，每行小字写范围
  const groups = useMemo(() => groupUsable(filtered, workspaces, wsFilter), [filtered, workspaces, wsFilter]);
  // 「正在做」：还没装的草稿不算「已启用」，「仅显示已启用」开着时不列；草稿活在某个工作区里，选了别的工作区就不列，选「全局」不列
  const draftGroups = useMemo(() => {
    if (onlyEnabled || wsFilter.kind === "global") return [];
    const scoped = wsFilter.kind === "workspace" ? draftList.drafts.filter((entry) => entry.workspaceId === wsFilter.id) : draftList.drafts;
    return groupDrafts(filterDrafts(scoped, query), workspaces, props.currentWorkspaceId);
  }, [draftList.drafts, query, workspaces, props.currentWorkspaceId, onlyEnabled, wsFilter]);

  const legacy = legacyCounts(state.plugins);
  const list = describeList(state.load, state.plugins.length);
  const filtering = query.trim() !== "";
  const makeAvailable = creatorAvailable(state.plugins);
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

      {draftList.error !== null && (
        <div className="pl-note danger" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>
            {t.draftsLoadFailed} {draftList.error}
          </span>
        </div>
      )}
      {draftGroups.length > 0 && <DraftsSection groups={draftGroups} onOpen={props.onOpenDraft} onOpenSession={props.onOpenSession} />}

      {list.body === "loading" && <p className="pl-empty">{messages.common.loading}</p>}
      {list.body === "empty" && (
        <div className="pl-empty">
          <b>{t.emptyTitle}</b>
          <span>{t.emptyHint}</span>
        </div>
      )}
      {list.body === "list" && groups.length === 0 && (
        <p className="pl-empty">
          {wsFilter.kind !== "all" && !filtering && !onlyEnabled
            ? messages.sidebar.wsFilterNoneIn(wsFilter.kind === "workspace" ? (workspaces.find((workspace) => workspace.id === wsFilter.id)?.name ?? "") : t.availableGlobal)
            : onlyEnabled && !filtering
              ? t.noneEnabled
              : t.noMatch(query.trim())}
        </p>
      )}
      {/* 全屏版同时带卡片墙与安静列表两棵树，哪棵显示由容器宽度定（plugins.css）；右栏版只有列表 */}
      {!rail && groups.length > 0 && (
        <div className="pl-wall">
          {groups.map((group) => (
            <WallGroup
              key={groupKey(group)}
              group={group}
              workspaces={workspaces}
              size={cardSize}
              onOpen={setSelectedId}
              onToggle={(view) => void toggle(view)}
            />
          ))}
        </div>
      )}
      {groups.map((group) => (
        <GroupCard key={groupKey(group)} group={group} workspaces={workspaces} onOpen={setSelectedId} onToggle={(view) => void toggle(view)} />
      ))}
      {/* 归档的技能不在上面的表里（文件夹已挪走）：底部一个默认折叠的分组，筛选时不出（它不参与筛选） */}
      {!filtering && <ArchivedAbilities refreshKey={state.plugins} workspaces={workspaces} filter={wsFilter} onRestored={state.refresh} />}
    </>
  );

  let pickOffset = 0;
  const pickBody = (
    <div ref={pickListRef} className="pl-pick-list" role="listbox" aria-label={t.title}>
      {pickNotice !== null && (
        <div className="pl-note warn" role="status">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>{pickNotice}</span>
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
      {list.body === "loading" && <p className="pl-empty">{messages.common.loading}</p>}
      {list.body === "empty" && (
        <div className="pl-empty">
          <b>{t.emptyTitle}</b>
          <span>{t.emptyHint}</span>
        </div>
      )}
      {list.body === "list" && pickModel.groups.length === 0 && <p className="pl-empty">{t.noMatch(query.trim())}</p>}
      {pickModel.groups.map((group) => {
        const offset = pickOffset;
        pickOffset += group.rows.length;
        return (
          <PluginPickerGroup
            key={group.key}
            group={group}
            workspaceName={currentWorkspaceName}
            offset={offset}
            activeIndex={pickIndex}
            onActivate={(row) => runPick(activateRow(row))}
            onExpand={(id) => runPick({ kind: "expand", id })}
          />
        );
      })}
    </div>
  );

  const detailBody =
    selected === null ? null : (
      <PluginDetail
        key={selected.id}
        view={selected}
        workspaces={workspaces}
        currentWorkspaceId={props.currentWorkspaceId}
        // 右栏版直接进看板视图；全屏版（设置里）要退出设置、到右栏去看
        onOpenBoard={rail ? () => setBoardOpen(true) : () => props.onOpenBoard(parsePluginViewId(selected.id)?.key ?? "")}
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

  // 正在做的草稿优先于列表与详情（智能体刚预览了它，用户要看的就是它）；点返回回到列表
  if (rail && props.draft !== undefined && props.draft !== null) {
    return <PluginDraftView path={props.draft.path} workspaceId={props.draft.workspaceId} onBack={() => props.onLeaveDraft?.()} />;
  }

  if (rail) {
    // 页头住工具栏的右栏胶囊（RightPanelFrame 把它 portal 过去）：列表 = 标题 + 筛选；详情 = 返回 + 标题
    const boardOf = selected !== null && boardOpen && parsePluginViewId(selected.id) !== null ? selected : null;
    const header =
      boardOf !== null ? (
        <>
          <PanelIconButton title={t.boardBackToDetail} onClick={() => setBoardOpen(false)}>
            <Icon name="chevron-left" size={16} strokeWidth={2} />
          </PanelIconButton>
          <strong className="cap-title">{t.boardViewTitle(boardOf.name)}</strong>
        </>
      ) : selected === null ? (
        <>
          <PanelTitle icon={FEATURE_ICON.plugins} title={t.title} />
          {picking ? (
            <PanelFilter
              inputRef={filterRef}
              value={query}
              onChange={changePickQuery}
              placeholder={t.pickPlaceholder}
              ariaLabel={t.filterAria}
              onKeyDown={onPickKeyDown}
            />
          ) : (
            <PanelFilter
              value={query}
              onChange={setQuery}
              placeholder={t.filterPlaceholder}
              ariaLabel={t.filterAria}
              count={filtering ? `${filtered.length} / ${state.plugins.length}` : String(state.plugins.length)}
            />
          )}
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
        <RightPanelFrame
          header={header}
          contentKey={selected === null ? "list" : `${boardOf === null ? "detail" : "board"}:${selected.id}`}
          // 工作区选择条钉在列表上方（列表滚下去它还在）；详情 / 看板 / 选取态里不出
          subheader={selected === null && !picking ? <div className="pl-wsbar" data-chrome="rail">{wsBar}</div> : undefined}
          footer={picking && selected === null ? <PluginPickerBar expanded={collapseRow(pickModel.flat[pickIndex]).kind !== "none"} /> : undefined}
        >
          <div className="pl-page" data-chrome="rail" data-picking={picking && selected === null}>
            <div className="pl-body">
              {boardOf !== null ? (
                <PluginBoardView target={{ kind: "installed", name: parsePluginViewId(boardOf.id)?.key ?? "", workspaceId: props.currentWorkspaceId }} />
              ) : selected === null ? (
                picking ? pickBody : listBody
              ) : (
                detailBody
              )}
            </div>
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
      {selected === null && <div className="pl-wsbar">{wsBar}</div>}
      <div className="pl-body scroll">{selected === null ? listBody : detailBody}</div>
      {dialog}
    </div>
  );
}

function groupKey(group: PluginGroup): string {
  return group.kind === "workspace" ? `ws:${group.workspace.id}` : group.kind === "usable" ? `usable:${group.workspace?.id ?? "global"}` : group.kind;
}

function groupTitle(t: Messages["plugins"], group: PluginGroup): string {
  if (group.kind === "usable") return group.workspace === null ? t.usableGlobal : t.usableIn(group.workspace.name);
  return group.kind === "global" ? t.groupAll : group.kind === "none" ? t.groupNone : group.workspace.name;
}

/** 「一组 = 它能用的」时每行 / 每张卡上的范围小字（别的分组里范围已经由组头说了，不重复）。 */
function rangeText(t: Messages["plugins"], range: RangeLabel): string {
  return range.kind === "global" ? t.rangeGlobal : range.kind === "only" ? t.rangeOnly(range.names.join("、")) : t.rangeNone;
}

/** 分组头：图标 + 组名 + 数量。列表（卡片底里）与卡片墙共用 */
function GroupHead(props: { group: PluginGroup }) {
  const t = useT().plugins;
  const { group } = props;
  return (
    <div className="pl-gh">
      <Icon
        name={group.kind === "global" || (group.kind === "usable" && group.workspace === null) ? "globe" : group.kind === "none" ? "circle-off" : "folder"}
        size={14}
        strokeWidth={1.8}
      />
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
    builtin: t.sourceBuiltin,
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
  workspaces: readonly Workspace[];
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
          <PluginCard key={view.id} view={view} range={group.kind === "usable" ? rangeOf(view, props.workspaces) : null} size={props.size} onOpen={() => props.onOpen(view.id)} onToggle={() => props.onToggle(view)} />
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
function PluginCard(props: { view: PluginView; range: RangeLabel | null; size: CardSize; onOpen: () => void; onToggle: () => void }) {
  const t = useT().plugins;
  const { view } = props;
  const active = isActive(view);
  const large = props.size === "large";
  const { kindsLine, sourceLabel } = describePlugin(t, view);
  const foot = `${props.range === null ? "" : `${rangeText(t, props.range)} · `}${sourceLabel} · ${kindsLine}`;
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

function GroupCard(props: { group: PluginGroup; workspaces: readonly Workspace[]; onOpen: (id: string) => void; onToggle: (view: PluginView) => void }) {
  const t = useT().plugins;
  const { group } = props;
  return (
    <section className="pl-grp" aria-label={groupTitle(t, group)}>
      <GroupHead group={group} />
      {group.items.map((view) => (
        <PluginRow key={view.id} view={view} range={group.kind === "usable" ? rangeOf(view, props.workspaces) : null} onOpen={() => props.onOpen(view.id)} onToggle={() => props.onToggle(view)} />
      ))}
    </section>
  );
}

function PluginRow(props: { view: PluginView; range: RangeLabel | null; onOpen: () => void; onToggle: () => void }) {
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
          <small className={view.origin === "user-mcp" ? "mono" : undefined}>
            {props.range === null ? view.description : [rangeText(t, props.range), view.description].filter((part) => part !== "").join(" · ")}
          </small>
        </span>
        <span className="pl-kinds">{kindsLine}</span>
        <span className="pl-from">{sourceLabel}</span>
        <KindTag view={view} />
      </button>
      {/* 断链的技能没有东西可开关：开关停着，点进去清理 */}
      <PluginSwitch checked={active} label={active ? t.toggleOff(view.name) : t.toggleOn(view.name)} disabled={isMissingSkillView(view)} onChange={props.onToggle} />
    </div>
  );
}

/**
 * 「正在做」：还没装、但已经有清单的插件文件夹，列表最上面一组（有草稿才出现），按工作区分组。
 * 用户中途离开、之后回来接着做的入口——草稿不是只活在对话里的东西。
 */
function DraftsSection(props: {
  groups: ReturnType<typeof groupDrafts>;
  onOpen: (draft: PluginDraftTarget) => void;
  onOpenSession: (sessionId: string, draftPath: string) => void;
}) {
  const t = useT().plugins;
  const total = props.groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <section className="pl-drafts" aria-label={t.draftsTitle}>
      <div className="pl-gh">
        <Icon name="pencil-line" size={14} strokeWidth={1.8} />
        <b>{t.draftsTitle}</b>
        <span className="pl-gh-count">{t.draftsCount(total)}</span>
      </div>
      {props.groups.map((group) => (
        <section key={group.workspace.id} className="pl-grp pl-dgrp" aria-label={group.workspace.name}>
          <div className="pl-gh">
            <Icon name="folder" size={14} strokeWidth={1.8} />
            <b>{group.workspace.name}</b>
            <span className="pl-gh-count">{t.draftsCount(group.items.length)}</span>
          </div>
          {group.items.map((entry) => (
            <DraftRow key={entry.path} entry={entry} onOpen={props.onOpen} onOpenSession={props.onOpenSession} />
          ))}
        </section>
      ))}
    </section>
  );
}

function DraftRow(props: { entry: PluginDraftEntry; onOpen: (draft: PluginDraftTarget) => void; onOpenSession: (sessionId: string, draftPath: string) => void }) {
  const messages = useT();
  const t = messages.plugins;
  const { entry } = props;
  const meta = [t.draftEdited(relativeTime(entry.updatedAt, messages)), ...(entry.sessionTitle === null ? [] : [t.draftMadeIn(entry.sessionTitle)])].join(" · ");
  const { sessionId } = entry;
  return (
    <div className="pl-row" data-draft="true">
      <button
        type="button"
        className="pl-row-main pl-draft-main"
        title={entry.manifestProblem === null ? meta : `${t.draftManifestProblem}: ${entry.manifestProblem}`}
        onClick={() => props.onOpen({ path: entry.path, workspaceId: entry.workspaceId })}
      >
        <PluginAvatar view={{ origin: "plugin" }} />
        <span className="pl-name">
          <span className="pl-draft-head">
            <b>{entry.displayName}</b>
            {entry.manifestProblem !== null && (
              <span className="pl-draft-flag">
                <Icon name="triangle-alert" size={12} strokeWidth={1.8} />
                {t.draftManifestProblem}
              </span>
            )}
          </span>
          <small>{entry.description === "" ? t.notChatted : entry.description}</small>
          <small className="pl-draft-meta">{meta}</small>
        </span>
      </button>
      {sessionId !== null && (
        <button type="button" className="pl-btn" title={t.draftGoToChatTip(entry.sessionTitle)} onClick={() => props.onOpenSession(sessionId, entry.path)}>
          <Icon name="message-square" size={13} strokeWidth={1.8} />
          {t.draftGoToChat}
        </button>
      )}
    </div>
  );
}
