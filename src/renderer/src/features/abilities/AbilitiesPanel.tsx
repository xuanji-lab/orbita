import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { PanelEmpty } from "../../shell/PanelEmpty";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { Menu, type MenuItem } from "../../shell/Menu";
import { StatusPie } from "../../shell/StatusPie";
import {
  PanelFilter,
  PanelHelp,
  PanelIconButton,
  PanelLine,
  PanelTitle,
  RightPanelFrame,
} from "../../shell/RightPanel";
import type { TokenPickerControl } from "../../shell/panel-token.ts";
import type { SkillsState } from "../skills/useSkills";
import { SkillDetail } from "../skills/SkillsPanel";
import { AddServerForm, McpServerDetail } from "../mcp/McpPanel";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import {
  ABILITY_TABS,
  abilityRows,
  clampPick,
  groupRows,
  movePick,
  nextTab,
  pickView,
  tabCounts,
  visibleRows,
  type AbilityGroup,
  type AbilityRow,
  type AbilityState,
  type AbilitySub,
  type AbilityTab,
  type AbilityWorkspace,
} from "./abilities-view.ts";
import "./abilities.css";

/** 面板里此刻是列表还是某一项的详情 / 添加表单 */
type PanelView =
  | { kind: "list" }
  | { kind: "skill"; slug: string }
  | { kind: "mcp"; name: string }
  | { kind: "add-server" };

/** 上次停在哪个页签：收起再开回到它（与右栏其它面板一样只记在内存里，重启从「全部」起） */
let rememberedTab: AbilityTab = "all";

/**
 * 能力面板（2026-10-30）：Skills 与 MCP 服务合成一张列表，顶上「全部 / 技能 / MCP」
 * 三个页签。取代原先两个各画各的旧面板（一个入口两页签只是第一步）。
 *
 * 两种态：
 * - **浏览**（从右栏图标开）：按类分组；行悬停出「插入」（插到输入框当前光标，面板不关，
 *   可以连插）；行尾开关（Skill 只管这个工作区，MCP 管所有工作区——组头写明）；点行开
 *   详情（Skill 详情 / MCP 服务卡）。
 * - **选取**（输入框里孤立的 `/` 按空格，App 传 picker）：只列这个工作区用得上的，没启用
 *   的灰着收底；焦点在筛选框，↑↓ 移高亮、回车插回那个 `/` 的位置、Tab 轮换页签、Esc
 *   先清词再回输入框；面板内容面一圈 accent 内描边，底部一条按键提示。
 *
 * 行怎么算（可用性、状态、开关口径）在 abilities-view.ts；这里只管画与键盘。
 */
export function AbilitiesPanel(props: {
  skills: SkillsState;
  /** 主槽会话所在的工作区（首页 = 输入框选着的那个）；null = 不属于任何工作区 */
  workspace: AbilityWorkspace | null;
  /** 新建技能…：新建会话并预填输入框，让智能体用 create_skill 落盘 */
  onCreateSkill: () => void;
  /** 「/ + 空格」选取态：只有主槽的 App 提供 */
  picker?: TokenPickerControl;
  /** 浏览态行内「插入」：token 插到主槽输入框当前光标处（面板不关） */
  onInsert: (token: string) => void;
}) {
  const { skills } = props;
  const [view, setView] = useState<PanelView>({ kind: "list" });
  const [tab, setTabState] = useState<AbilityTab>(rememberedTab);
  const setTab = useCallback((next: AbilityTab) => {
    rememberedTab = next;
    setTabState(next);
  }, []);
  const [query, setQuery] = useState("");

  // 「/ + 空格」把人带回能选的地方：详情里没有可选的行。靠 request 重触发——面板可能
  // 已开着、选取态可能已在
  useEffect(() => {
    if (props.picker !== undefined) setView({ kind: "list" });
  }, [props.picker?.request]);

  const back = (): void => setView({ kind: "list" });
  const workspaceName = (id: string): string => skills.workspaces.find((w) => w.id === id)?.name ?? id;

  if (view.kind === "skill") {
    const meta = skills.skills.find((s) => s.slug === view.slug);
    // 详情那一项没了（被清理 / 在访达里删了）：回列表
    if (meta !== undefined) {
      return <SkillDetail skills={skills} meta={meta} workspaceName={workspaceName} onBack={back} />;
    }
  } else if (view.kind === "mcp") {
    const server = skills.servers.find((s) => s.name === view.name);
    if (server !== undefined) {
      return <McpServerDetail skills={skills} server={server} onBack={back} onInsert={props.onInsert} />;
    }
  } else if (view.kind === "add-server") {
    return <AddServerForm skills={skills} onCancel={back} onAdded={back} />;
  }
  return (
    <AbilityList
      skills={skills}
      workspace={props.workspace}
      picker={props.picker}
      tab={tab}
      onTab={setTab}
      query={query}
      onQuery={setQuery}
      onInsert={props.onInsert}
      onOpen={(row) =>
        setView(row.kind === "skill" ? { kind: "skill", slug: row.id } : { kind: "mcp", name: row.id })
      }
      onCreateSkill={props.onCreateSkill}
      onAddServer={() => setView({ kind: "add-server" })}
    />
  );
}

function AbilityList(props: {
  skills: SkillsState;
  workspace: AbilityWorkspace | null;
  picker: TokenPickerControl | undefined;
  tab: AbilityTab;
  onTab: (tab: AbilityTab) => void;
  query: string;
  onQuery: (query: string) => void;
  onInsert: (token: string) => void;
  onOpen: (row: AbilityRow) => void;
  onCreateSkill: () => void;
  onAddServer: () => void;
}) {
  const t = useT();
  const { skills, picker, tab, query } = props;
  const picking = picker !== undefined;
  /** 重新加载 MCP 进行中：用得上的 MCP 行转「连接中」 */
  const [reloading, setReloading] = useState(false);
  /** 开关在途（写盘 + 回读）：显示成拨过去的样子，回来之前不让再拨 */
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  /** 开关写失败的原因（一行红字，下次拨开关时清掉） */
  const [actionError, setActionError] = useState<string | null>(null);
  const [pickIndex, setPickIndex] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);

  // 选取态多带插件里的技能（实验功能 plugins）：点名规则与用户技能一致，选取面要选得到；
  // 浏览视图仍只列你自己的技能（插件的技能在插件页管）
  const rows = useMemo(
    () =>
      abilityRows({
        skills: picking ? [...skills.skills, ...skills.pluginSkills] : skills.skills,
        servers: skills.servers,
        workspace: props.workspace,
        reloading,
      }),
    [picking, skills.skills, skills.pluginSkills, skills.servers, props.workspace, reloading],
  );
  const counts = tabCounts(rows);
  const shown = useMemo(() => visibleRows(rows, tab, query), [rows, tab, query]);
  const browse = useMemo(() => groupRows(rows, shown), [rows, shown]);
  const pick = useMemo(() => pickView(rows, tab, query), [rows, tab, query]);

  // ── 焦点：「/ + 空格」后落到筛选框 ─────────────────────────────
  // 筛选框住在工具栏的右栏胶囊里（portal）。面板从关着打开时，胶囊这一拍才挂上、portal
  // 的宿主下一拍才有——effect 跑的时候输入框还不在，只在 effect 里 focus 会落空（改动前
  // 「/ + 空格」从关着的面板进选取态，焦点从来没落过去，就是这个时序）。所以记一个
  // 「欠一次聚焦」，输入框真挂上时（回调 ref）补上
  const filterEl = useRef<HTMLInputElement | null>(null);
  const focusOwed = useRef(false);
  const filterRef = useCallback((el: HTMLInputElement | null) => {
    filterEl.current = el;
    if (el !== null && focusOwed.current) {
      focusOwed.current = false;
      el.focus();
    }
  }, []);
  useEffect(() => {
    if (picker === undefined) return;
    // 每次「/ + 空格」从干净的状态起：清词、回「全部」、亮第一行
    props.onQuery("");
    props.onTab("all");
    setPickIndex(0);
    focusOwed.current = true;
    const el = filterEl.current;
    if (el !== null) {
      focusOwed.current = false;
      el.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker?.request]);

  // 可选行变了（筛选、切页签、清单读回来）：高亮夹回范围
  const pickCount = pick.pickable.length;
  useEffect(() => {
    if (picking) setPickIndex((index) => clampPick(index, pickCount));
  }, [picking, pickCount]);
  // 高亮行滚进视野：只动列表自己的纵向滚动。不用 scrollIntoView——它连祖先也横着滚：
  // 「/ + 空格」从关着的面板进来时右栏壳还在从 0 宽展开，高亮行横向「不在视野里」，浏览器就把
  // overflow:hidden 的壳横滚一点（内层比壳的内宽宽一条边框），之后一直停在那里——实测窄窗
  // 覆盖层偏 2px、并排偏 0.5px，选取态那圈 accent 的左边被裁掉（旧 Skills 面板同一句，同样会偏）
  useEffect(() => {
    if (!picking) return;
    const row = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    let scroller = row?.parentElement ?? null;
    while (scroller !== null && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    if (row == null || scroller === null) return;
    const view = scroller.getBoundingClientRect();
    const box = row.getBoundingClientRect();
    if (box.top < view.top) scroller.scrollTop -= view.top - box.top;
    else if (box.bottom > view.bottom) scroller.scrollTop += box.bottom - view.bottom;
  }, [picking, pickIndex]);

  const changeQuery = (next: string): void => {
    props.onQuery(next);
    if (picking) setPickIndex(0);
  };
  const changeTab = (next: AbilityTab): void => {
    props.onTab(next);
    if (picking) setPickIndex(0);
  };

  /** 选取态的键盘：↑↓ 移高亮、回车插入、Tab 轮换页签、Esc 先清词再回输入框 */
  const onPickerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (picker === undefined || event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setPickIndex((index) => movePick(index, event.key === "ArrowDown" ? 1 : -1, pickCount));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = pick.pickable[pickIndex >= 0 ? pickIndex : 0];
      if (row?.token != null) picker.onSelect(row.token);
    } else if (event.key === "Tab") {
      // Tab 归页签：筛选框里没有别的可以 Tab 去的地方，焦点留在框里
      event.preventDefault();
      changeTab(nextTab(tab, event.shiftKey));
    } else if (event.key === "Escape") {
      // 两段式：人还在搜就先清词；词空了才退出选取（App 的全局 Esc 不能接着关面板）
      event.preventDefault();
      event.stopPropagation();
      if (query !== "") changeQuery("");
      else picker.onCancel();
    }
  };

  /** 拨开关：Skill 链 / 解链这个工作区；MCP 改 mcp.json 的 disabled（所有工作区） */
  const toggle = (row: AbilityRow): void => {
    const sw = row.toggle;
    if (sw === null || sw.kind === "locked" || pending.has(row.key)) return;
    const next = !sw.on;
    setActionError(null);
    setPending((map) => new Map(map).set(row.key, next));
    const write =
      sw.kind === "workspace"
        ? next
          ? skills.link(row.id, { kind: "workspace", workspaceId: sw.workspaceId })
          : skills.unlink(row.id, { kind: "workspace", workspaceId: sw.workspaceId })
        : skills.setServerDisabled(row.id, !next);
    void write
      .catch((cause: unknown) => setActionError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() =>
        setPending((map) => {
          const rest = new Map(map);
          rest.delete(row.key);
          return rest;
        }),
      );
  };

  const runReload = (): void => {
    setReloading(true);
    void Promise.resolve(skills.reloadMcp()).finally(() => setReloading(false));
  };

  const addItems: MenuItem[] = [
    { id: "create-skill", label: t.skills.create, icon: "plus", onSelect: props.onCreateSkill },
    {
      id: "link-skill",
      label: t.skills.linkFolder,
      icon: "folder-plus",
      onSelect: () => void skills.importFolder(null),
    },
    { id: "add-server", label: t.abilities.addServer, icon: "plug", onSelect: props.onAddServer },
  ];
  const moreItems: MenuItem[] = [
    { id: "skills-dir", label: t.skills.openDir, icon: "folder-open", onSelect: () => skills.reveal(null) },
    { id: "edit-mcp", label: t.mcp.editConfig, icon: "pencil-line", onSelect: skills.openMcpConfig },
    {
      id: "reload-mcp",
      label: reloading ? t.abilities.reloadingMcp : t.abilities.reloadMcp,
      icon: "refresh-cw",
      disabled: reloading,
      onSelect: runReload,
    },
  ];

  const header = (
    <>
      <PanelTitle icon={FEATURE_ICON.abilities} title={t.abilities.title} />
      <PanelFilter
        inputRef={filterRef}
        value={query}
        onChange={changeQuery}
        placeholder={picking ? t.abilities.filterPicking : t.abilities.filter}
        ariaLabel={t.abilities.filterAria}
        onKeyDown={picking ? onPickerKeyDown : undefined}
      />
    </>
  );
  const headerExtra = (
    <>
      <PanelHelp label={t.abilities.helpLabel} text={t.abilities.help} />
      <Menu
        align="end"
        items={addItems}
        trigger={({ toggle: open }) => (
          <PanelIconButton title={t.abilities.add} onClick={open}>
            <Icon name="plus" size={16} strokeWidth={2} />
          </PanelIconButton>
        )}
      />
      <Menu
        align="end"
        items={moreItems}
        trigger={({ toggle: open }) => (
          <PanelIconButton title={t.common.more} onClick={open}>
            <Icon name={reloading ? "loader-circle" : "ellipsis-vertical"} size={16} spin={reloading} />
          </PanelIconButton>
        )}
      />
    </>
  );

  const errors: string[] = [
    ...(skills.load.kind === "failed" ? [`${t.skills.readFailed} ${skills.load.message}`] : []),
    ...(skills.serversLoad.kind === "failed" ? [skills.serversLoad.message] : []),
    ...skills.serverWarnings,
    ...(actionError === null ? [] : [t.abilities.actionFailed(actionError)]),
  ];
  const loading =
    rows.length === 0 && (skills.load.kind === "loading" || skills.serversLoad.kind === "loading");
  const q = query.trim();

  /** 列表空着时的空态：有词说没匹配；没词按页签说没有什么、怎么来，出口是那一类的「添加」 */
  const emptyState = (): React.ReactNode => {
    if (q !== "") return <PanelEmpty icon="search">{t.abilities.noMatch(q)}</PanelEmpty>;
    if (tab === "skill") {
      return (
        <PanelEmpty icon="book" hint={t.skills.noneHint} exit={{ label: t.skills.create, onClick: props.onCreateSkill }}>
          {t.skills.none}
        </PanelEmpty>
      );
    }
    if (tab === "mcp") {
      return (
        <PanelEmpty icon="plug" hint={t.mcp.emptyDesc} exit={{ label: t.abilities.addServer, onClick: props.onAddServer }}>
          {t.mcp.emptyTitle}
        </PanelEmpty>
      );
    }
    return <PanelEmpty icon={FEATURE_ICON.abilities}>{t.abilities.none}</PanelEmpty>;
  };

  const groupHead = (group: AbilityGroup): React.ReactNode => {
    const label =
      group.kind === "skill"
        ? props.workspace === null
          ? t.abilities.outsideWorkspaces
          : t.abilities.inWorkspace(props.workspace.name)
        : t.abilities.servers;
    const note = picking
      ? undefined
      : group.kind === "mcp"
        ? t.abilities.mcpSwitchNote
        : props.workspace === null
          ? t.abilities.skillSwitchNoteNoWorkspace
          : t.abilities.skillSwitchNote;
    return <GroupHead kind={group.kind} label={label} count={`${group.usable} / ${group.total}`} note={note} />;
  };

  const rowView = (row: AbilityRow, active: boolean): React.ReactNode => (
    <AbilityRowView
      key={row.key}
      row={row}
      picking={picking}
      active={active}
      pendingOn={pending.get(row.key)}
      workspaceName={props.workspace?.name ?? null}
      onOpen={() => props.onOpen(row)}
      onPick={() => {
        if (picker !== undefined && row.usable && row.token !== null) picker.onSelect(row.token);
      }}
      onInsert={() => {
        if (row.token !== null) props.onInsert(row.token);
      }}
      onToggle={() => toggle(row)}
    />
  );

  let body: React.ReactNode;
  if (loading) {
    body = <PanelEmpty busy>{t.common.loading}</PanelEmpty>;
  } else if (picking) {
    let index = 0;
    body = (
      <>
        {pick.pickable.length === 0 && (
          <PanelEmpty icon={q === "" ? FEATURE_ICON.abilities : "search"}>
            {q === "" ? t.abilities.pickerEmpty : t.abilities.noMatch(q)}
          </PanelEmpty>
        )}
        {pick.groups.map((group) => (
          <div key={group.kind} role="group" aria-label={group.kind === "skill" ? t.abilities.kindSkill : t.abilities.kindMcp}>
            {groupHead(group)}
            {group.rows.map((row) => rowView(row, index++ === pickIndex))}
          </div>
        ))}
        {pick.unusable.length > 0 && (
          <div role="group" aria-label={t.abilities.notEnabledHere}>
            <div className="ability-group-head">
              <span className="ability-group-label">
                {props.workspace === null ? t.abilities.notEnabledOutside : t.abilities.notEnabledHere}
              </span>
              <span className="ability-group-count">{pick.unusable.length}</span>
              <span className="ability-group-note row-trailing">{t.abilities.notEnabledHint}</span>
            </div>
            {pick.unusable.map((row) => rowView(row, false))}
          </div>
        )}
      </>
    );
  } else if (shown.length === 0) {
    body = emptyState();
  } else {
    body = browse.map((group) => (
      <div key={group.kind}>
        {groupHead(group)}
        {group.rows.map((row) => rowView(row, false))}
      </div>
    ));
  }

  const pickbar = (
    <div className="ability-pickbar" aria-hidden="true">
      <span>
        <kbd className="ability-kbd">
          <Icon name="arrow-up" size={12} />
        </kbd>
        <kbd className="ability-kbd">
          <Icon name="arrow-down" size={12} />
        </kbd>
        {t.abilities.keyMove}
      </span>
      <span>
        <kbd className="ability-kbd">
          <Icon name="corner-down-left" size={12} />
        </kbd>
        {t.abilities.keyInsert}
      </span>
      <span>
        <kbd className="ability-kbd">{t.abilities.keyTabCap}</kbd>
        {t.abilities.keyTab}
      </span>
      <span>
        <kbd className="ability-kbd">{t.abilities.keyEscCap}</kbd>
        {t.abilities.keyEsc}
      </span>
    </div>
  );

  return (
    <RightPanelFrame
      header={header}
      headerExtra={headerExtra}
      contentKey="list"
      footer={picking ? pickbar : undefined}
    >
      <div ref={listRef} className={`ability-list${picking ? " ability-picking" : ""}`}>
        <div className="ability-tabs" role="tablist" aria-label={t.abilities.tabsAria}>
          {ABILITY_TABS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              className="ability-tab"
              aria-selected={tab === key}
              // 选取态：点页签不把焦点从筛选框抢走（键盘还要接着 ↑↓ / 回车）
              onMouseDown={picking ? (event) => event.preventDefault() : undefined}
              onClick={() => changeTab(key)}
            >
              {key === "all" ? t.abilities.tabAll : key === "skill" ? t.abilities.tabSkills : t.abilities.tabMcp}
              <span className="ability-tab-count">{counts[key]}</span>
            </button>
          ))}
        </div>
        {errors.map((line) => (
          <div key={line} className="ability-error">
            <PanelLine danger>{line}</PanelLine>
          </div>
        ))}
        {/* 选取态的可选行是一个 listbox（页签不在里面：tablist 不能是 listbox 的孩子） */}
        <div role={picking ? "listbox" : undefined} aria-label={picking ? t.abilities.title : undefined}>
          {body}
        </div>
      </div>
    </RightPanelFrame>
  );
}

/** 组头：类别色描边小标签 + 范围 + 「能用 / 一共」，浏览态行尾一句开关管什么 */
function GroupHead(props: { kind: AbilityRow["kind"]; label: string; count: string; note: string | undefined }) {
  const t = useT();
  return (
    <div className="ability-group-head">
      <span className="ability-kind" data-kind={props.kind}>
        {props.kind === "skill" ? t.abilities.kindSkill : t.abilities.kindMcp}
      </span>
      <span className="ability-group-label">{props.label}</span>
      <span className="ability-group-count">{props.count}</span>
      {props.note !== undefined && (
        <span className="ability-group-note row-trailing" title={props.note}>
          {props.note}
        </span>
      )}
    </div>
  );
}

/** 第二行的文案（事实在 abilities-view，文案按语言取） */
function subText(t: Messages, sub: AbilitySub): string {
  switch (sub.kind) {
    case "description":
      return sub.text === "" ? t.abilities.subNoDescription : sub.text;
    case "missing":
      return t.abilities.subMissing;
    case "ready":
      return t.abilities.subTools(sub.tools);
    case "failed":
      return t.abilities.subFailed(sub.message);
    case "connecting":
      return t.abilities.subConnecting;
    case "idle":
      return t.abilities.subIdle;
    case "disabled":
      return t.abilities.subDisabled;
    case "elsewhere":
      return t.abilities.subOnlyIn(sub.workspaces.join(t.common.listSeparator));
  }
}

function stateTitle(t: Messages, state: AbilityState): string {
  switch (state) {
    case "on":
      return t.abilities.stateOn;
    case "off":
      return t.abilities.stateOff;
    case "idle":
      return t.abilities.stateIdle;
    case "failed":
      return t.abilities.stateFailed;
    case "connecting":
      return t.abilities.stateConnecting;
  }
}

/**
 * 行首 14px 状态槽。亮着的三档借会话状态饼的符号（同一套：满绿 = 好、满红 = 出错、
 * 1/3 蓝 = 进行中），关着 / 还没连上是同尺寸的空圈。静态，不转。
 */
function AbilityDot(props: { state: AbilityState }) {
  const t = useT();
  const title = stateTitle(t, props.state);
  if (props.state === "off" || props.state === "idle") {
    return <span className="ability-dot-off" role="img" aria-label={title} title={title} />;
  }
  return (
    <StatusPie
      state={props.state === "on" ? "done" : props.state === "failed" ? "failed" : "running"}
      title={title}
    />
  );
}

/**
 * 一行能力。外层 div 管悬停底色与布局；点行的语义在 `.ability-row-main` 这颗按钮上
 * （行里还有「插入」键与开关，按钮不能套按钮）。
 * - 浏览态：点行开详情；「插入」悬停 / 键盘聚焦才出现，压在开关左边（不占位，血线规则的
 *   悬停组合例外）；开关钉在行右血线。
 * - 选取态：点行即插入；高亮行左侧一条 accent、行尾一个「插入」提示；没启用的行灰着、
 *   不可点。
 */
function AbilityRowView(props: {
  row: AbilityRow;
  picking: boolean;
  active: boolean;
  /** 开关在途时拨向的状态；undefined = 不在途 */
  pendingOn: boolean | undefined;
  workspaceName: string | null;
  onOpen: () => void;
  onPick: () => void;
  onInsert: () => void;
  onToggle: () => void;
}) {
  const t = useT();
  const { row, picking } = props;
  const sw = row.toggle;
  const bad = row.sub.kind === "failed" || row.sub.kind === "missing";
  const unusable = picking && !row.usable;
  const on = props.pendingOn ?? sw?.on ?? false;
  const label =
    sw === null
      ? ""
      : row.kind === "skill"
        ? t.abilities.switchSkill(row.name, props.workspaceName ?? t.abilities.outsideWorkspaces)
        : t.abilities.switchMcp(row.name);
  const switchTitle =
    sw === null || sw.kind !== "locked"
      ? label
      : sw.reason === "global-skill"
        ? t.abilities.lockedGlobal
        : sw.reason === "no-workspace"
          ? t.abilities.lockedNoWorkspace
          : t.mcp.workspaceFileOnly;
  return (
    <div
      className={`ability-row${picking ? " picking" : ""}${row.usable ? "" : " off"}${unusable ? " unusable" : ""}`}
      data-kind={row.kind}
      data-active={props.active ? "true" : undefined}
      role={picking ? "option" : undefined}
      aria-selected={picking ? props.active : undefined}
      aria-disabled={unusable ? true : undefined}
    >
      <button
        type="button"
        className="ability-row-main"
        // 灰行用 aria-disabled 而不是 disabled：原生禁用的按钮收不到 mousedown，点它焦点就从筛选框
        // 掉到 body 上（实测），键盘选取接不下去。点灰行什么也不插——onPick 自己认 usable
        aria-disabled={unusable ? true : undefined}
        // 选取态：点行不把焦点从筛选框抢走——点到灰行上什么也不插，键盘（↑↓ / 回车）还得接着用
        onMouseDown={picking ? (event) => event.preventDefault() : undefined}
        onClick={picking ? props.onPick : props.onOpen}
      >
        <span className="ability-dot-slot">
          {/* 选取态灰着的行一律空圈：那一组说的是「这里没启用」，红点绿点会把眼睛拉回不可选的行 */}
          <AbilityDot state={unusable ? "off" : row.state} />
        </span>
        <span className="ability-row-name">{row.name}</span>
        <span className={`ability-row-sub${bad ? " bad" : ""}`} title={subText(t, row.sub)}>
          {subText(t, row.sub)}
        </span>
      </button>
      {picking
        ? props.active && (
            <span className="ability-insert" aria-hidden="true">
              <Icon name="corner-down-left" size={12} />
              {t.abilities.insert}
            </span>
          )
        : row.token !== null && (
            <button
              type="button"
              className="ability-insert reveal"
              title={t.abilities.insertTip}
              onClick={props.onInsert}
            >
              <Icon name="corner-down-left" size={12} />
              {t.abilities.insert}
            </button>
          )}
      {!picking && sw !== null && (
        <button
          type="button"
          role="switch"
          className="ability-switch row-trailing"
          aria-checked={on}
          aria-label={label}
          aria-busy={props.pendingOn !== undefined ? true : undefined}
          // 锁住的开关用 aria-disabled 而不是 disabled：原生 disabled 的按钮不出 tooltip、
          // 也 Tab 不到，「为什么拨不动」就没处说了（toggle 里对 locked 本来就不动作）
          aria-disabled={sw.kind === "locked" ? true : undefined}
          title={switchTitle}
          onClick={props.onToggle}
        />
      )}
    </div>
  );
}
