import { useState } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import type { ChatSession } from "../features/chat/useChatSession";
import { SETTINGS_TABS, type SettingsTab } from "../features/settings/SettingsView";

/**
 * 左栏，288px。**它自己没有面**——不填色、不描边、不分割线，直接坐在 layer 1 上，
 * 结构完全由中卡的边缘给出（设计系统 *Layout*：both sidebars are unbounded）。
 *
 * 只列真实存在的东西：本分支还没有会话存储，所以「会话列表」目前最多一条——
 * 就是当前这个 session。**不铺假数据**；没做的（编排、归档）按设计系统的
 * 规矩「显示、禁用、标注 planned」，不藏也不假装。
 *
 * 进设置时**换的是这块列表，不是弹一个窗**：tab 列表就长在这里，和会话行同一套
 * 处理（透明、hover 中性、选中加重），右边还是同一张内容面。设置因此和聊天是
 * 同一个壳的两种内容，而不是叠在壳上的另一层。
 */
export function Sidebar(props: {
  session: ChatSession;
  title: string | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  onSettingsTab: (tab: SettingsTab) => void;
  onToggleSettings: () => void;
}) {
  const { session } = props;
  return (
    <aside
      style={{
        width: 288,
        flex: "0 0 288px",
        display: "flex",
        flexDirection: "column",
        gap: "var(--space-3)",
        padding: "var(--space-2) var(--space-3)",
        background: "transparent",
        overflow: "hidden",
      }}
    >
      {/*
        顶栏兼作标题栏：`titleBarStyle: "hidden"` 之后这是窗口唯一的可拖区域，
        macOS 上还要给红黄绿三个键让净空——见 styles.css 的 `.titlebar`。
        没有 logo：品牌就是衬线体里的小写 orbita（设计系统 *No logo*）。
      */}
      <div
        className="titlebar"
        style={{
          display: "flex",
          alignItems: "center",
          height: 34,
          fontFamily: "var(--font-family-brand)",
          fontSize: 22,
          fontWeight: 500,
          lineHeight: 1,
          letterSpacing: "0.01em",
          color: "var(--color-text-primary)",
        }}
      >
        orbita
      </div>

      <div role="tablist" style={{ display: "flex", gap: 4 }}>
        <ModeChip icon="bot" active>
          Agent mode
        </ModeChip>
        <ModeChip icon="workflow" disabled title="Orchestration mode (planned)">
          Orchestrate
        </ModeChip>
      </div>

      {/* 一屏一个 accent：主操作（新建 / 发送）与模式选中，别处一律中性 */}
      <button
        type="button"
        onClick={session.newTask}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          width: "100%",
          height: 32,
          padding: "0 10px",
          border: 0,
          borderRadius: "var(--radius-md)",
          background: "var(--color-accent)",
          color: "var(--color-accent-fg)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-control)",
          fontWeight: "var(--weight-medium)",
          cursor: "pointer",
          transition: "var(--transition-hover)",
        }}
      >
        <Icon name="plus" size={16} />
        New task
      </button>

      <div
        className="scroll"
        style={{
          flex: 1,
          minHeight: 0,
          marginRight: "calc(-1 * var(--space-3))",
          paddingRight: "var(--space-3)",
        }}
      >
        {props.settingsOpen ? (
          <>
            <NodeLabel>Settings</NodeLabel>
            {SETTINGS_TABS.map((tab) => (
              <NavRow
                key={tab.id}
                icon={tab.icon}
                label={tab.label}
                active={props.settingsTab === tab.id}
                onClick={() => props.onSettingsTab(tab.id)}
              />
            ))}
          </>
        ) : (
          <>
            <NodeHeader
              label="Workspaces"
              addLabel="Choose a workspace folder"
              addIcon="folder-plus"
              onAdd={session.chooseWorkspace}
            />
            {session.workspace === null ? (
              <Empty>No workspace yet. Choose the folder the agent may read.</Empty>
            ) : (
              <div style={{ padding: "var(--space-2) 0" }}>
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "minmax(0,1fr) 26px",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <span
                    title={session.workspace}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "24px minmax(0,1fr)",
                      alignItems: "center",
                      gap: "var(--space-2)",
                      minHeight: 28,
                    }}
                  >
                    <span
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 24,
                        height: 24,
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      <Icon name="folder" size={14} strokeWidth={1.8} />
                    </span>
                    <strong
                      style={{
                        minWidth: 0,
                        fontSize: "var(--font-size-control)",
                        fontWeight: "var(--weight-semibold)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {basename(session.workspace)}
                    </strong>
                  </span>
                  {/* 这个 + 建的是「这个工作区里的任务」：cwd 按路径直接选好，
                      与顶上那个「+ New task」（不属于任何工作区，落在兜底）区分开 */}
                  <IconButton
                    label="New task in this workspace"
                    size={26}
                    onClick={session.newTaskInWorkspace}
                  >
                    <Icon name="plus" size={14} />
                  </IconButton>
                </div>
                {props.title === null ? (
                  <Empty>No task yet. The one you start lands here.</Empty>
                ) : (
                  <SessionRow
                    title={props.title}
                    running={session.phase === "turn"}
                    failed={session.error !== null}
                    active={!props.settingsOpen}
                    onClick={props.settingsOpen ? props.onToggleSettings : undefined}
                  />
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* 整条可点，不是只有图标可点——和 New task 一样是一整根横条 */}
      <NavRow
        icon="archive"
        label="Archived (0)"
        hint="Archived tasks (planned)"
        active={false}
        disabled
      />
      <NavRow
        icon="settings"
        label="Settings"
        active={props.settingsOpen}
        onClick={props.onToggleSettings}
      />
    </aside>
  );
}

/** 分组标题：机器面的小字用 business/mono，字号 micro，大写加字距 */
function NodeLabel(props: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        minHeight: 28,
        fontFamily: "var(--font-family-business)",
        fontSize: "var(--font-size-micro)",
        letterSpacing: "0.06em",
        textTransform: "uppercase",
        color: "var(--color-text-secondary)",
      }}
    >
      {props.children}
    </span>
  );
}

function NodeHeader(props: {
  label: string;
  addLabel: string;
  addIcon: IconName;
  onAdd: () => void;
}) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(0,1fr) 26px",
        alignItems: "center",
        gap: 2,
        minHeight: 28,
      }}
    >
      <NodeLabel>{props.label}</NodeLabel>
      <IconButton label={props.addLabel} size={26} onClick={props.onAdd}>
        <Icon name={props.addIcon} size={14} />
      </IconButton>
    </div>
  );
}

/**
 * 侧栏里的一行导航。**会话行、设置 tab、Archived、Settings 全都是它**——
 * 它们本来就是一回事：前导 13px 图标槽 + 一行文字，整条可点（不是只有图标可点）。
 *
 * hover 与选中都走 `--row-hover-bg` / `--row-active-bg`，两个值在 styles.css
 * 里一处定义，选中态的两个候选与取舍也写在那儿。
 */
function NavRow(props: {
  icon: IconName;
  label: string;
  active: boolean;
  onClick?: (() => void) | undefined;
  disabled?: boolean;
  tone?: string;
  spin?: boolean;
  /** 图标槽的悬停说明（会话行用它讲状态） */
  iconTitle?: string;
  /** 整行的悬停说明（planned 的东西用它讲为什么点不动） */
  hint?: string;
}) {
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  const clickable = !disabled && props.onClick !== undefined;
  return (
    <button
      type="button"
      title={props.hint}
      disabled={disabled}
      aria-pressed={clickable ? props.active : undefined}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-2)",
        width: "100%",
        minHeight: "var(--control-height-md)",
        margin: "2px 0",
        padding: "var(--space-1) var(--space-2) var(--space-1) var(--space-1)",
        border: 0,
        borderRadius: "var(--radius-sm)",
        background: props.active
          ? "var(--row-active-bg)"
          : hover && clickable
            ? "var(--row-hover-bg)"
            : "transparent",
        // 玻璃上的禁用态用实色 tertiary，不用 opacity（设计系统 *Hover, press, disabled*）
        color: disabled ? "var(--color-text-tertiary)" : "var(--color-text-primary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        fontWeight: props.active ? "var(--weight-semibold)" : "var(--weight-regular)",
        textAlign: "left",
        cursor: disabled ? "not-allowed" : clickable ? "pointer" : "default",
        transition: "var(--transition-hover)",
      }}
    >
      <span
        title={props.iconTitle}
        style={{
          display: "grid",
          placeItems: "center",
          flex: "0 0 auto",
          color: disabled ? "var(--color-text-tertiary)" : (props.tone ?? "var(--color-text-secondary)"),
        }}
      >
        <Icon name={props.icon} size={13} strokeWidth={1.8} spin={props.spin ?? false} />
      </span>
      <span
        style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {props.label}
      </span>
    </button>
  );
}

/**
 * 一条会话。状态槽在最前面——**状态优先用图标与文字，颜色是第二信号**。
 */
function SessionRow(props: {
  title: string;
  running: boolean;
  failed: boolean;
  active: boolean;
  onClick?: (() => void) | undefined;
}) {
  const status = props.running
    ? { icon: "loader-circle" as const, tone: "var(--color-accent)", label: "Running", spin: true }
    : props.failed
      ? { icon: "triangle-alert" as const, tone: "var(--color-danger)", label: "Failed", spin: false }
      : { icon: "check" as const, tone: "var(--color-text-tertiary)", label: "Idle", spin: false };
  return (
    <NavRow
      icon={status.icon}
      label={props.title}
      tone={status.tone}
      spin={status.spin}
      iconTitle={status.label}
      active={props.active}
      onClick={props.onClick}
    />
  );
}

function Empty(props: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "var(--space-2) 0",
        padding: "0 var(--space-1)",
        fontSize: "var(--font-size-caption)",
        lineHeight: "var(--line-height-caption)",
        color: "var(--color-text-secondary)",
      }}
    >
      {props.children}
    </p>
  );
}

/** 只显示文件夹名，完整路径进 title——路径是机器事实，不该占掉一整行 */
function basename(path: string): string {
  const parts = path.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] ?? path;
}

/** 模式选择：选中用 mode-active（明主题蓝、暗主题黄），未选中是纯文字 */
function ModeChip(props: {
  icon: IconName;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  const active = props.active === true;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      disabled={disabled}
      title={props.title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        flex: 1,
        minWidth: 0,
        padding: "4px 8px",
        border: 0,
        borderRadius: "var(--radius-md)",
        background: active
          ? "var(--color-mode-active-bg)"
          : hover && !disabled
            ? "var(--color-bg-hover)"
            : "transparent",
        // 玻璃上的禁用态用实色 tertiary，不用 opacity
        color: active
          ? "var(--color-mode-active-fg)"
          : disabled
            ? "var(--color-text-tertiary)"
            : "var(--color-text-primary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        fontWeight: "var(--weight-medium)",
        whiteSpace: "nowrap",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      <Icon name={props.icon} size={14} />
      {props.children}
    </button>
  );
}
