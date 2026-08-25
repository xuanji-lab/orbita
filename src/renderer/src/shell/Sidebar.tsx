import { useState } from "react";
import { Icon, type IconName } from "./Icon";
import { IconButton } from "./IconButton";
import type { ChatSession } from "../features/chat/useChatSession";

/**
 * 左栏，288px。**它自己没有面**——不填色、不描边、不分割线，直接坐在 layer 1 上，
 * 结构完全由中卡的边缘给出（设计系统 *Layout*：both sidebars are unbounded）。
 *
 * 只列真实存在的东西：本分支还没有会话存储，所以「会话列表」目前最多一条——
 * 就是当前这个 session。**不铺假数据**；没做的（编排、归档）按设计系统的
 * 规矩「显示、禁用、标注 planned」，不藏也不假装。
 */
export function Sidebar(props: {
  session: ChatSession;
  title: string | null;
  settingsOpen: boolean;
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
              <IconButton
                label="New task in this workspace"
                size={26}
                onClick={session.newTask}
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
      </div>

      <FooterRow>
        <IconButton label="Archived tasks (planned)" size={26} disabled>
          <Icon name="archive" size={14} />
        </IconButton>
        <span style={{ fontSize: "var(--font-size-caption)" }}>Archived (0)</span>
      </FooterRow>

      <FooterRow>
        <IconButton
          label="Settings"
          size={26}
          active={props.settingsOpen}
          onClick={props.onToggleSettings}
        >
          <Icon name="settings" size={16} />
        </IconButton>
        <span style={{ fontSize: "var(--font-size-caption)" }}>Settings</span>
      </FooterRow>
    </aside>
  );
}

/** 分组标题：机器面的小字用 business/mono，字号 micro，大写加字距 */
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
      <span
        style={{
          fontFamily: "var(--font-family-business)",
          fontSize: "var(--font-size-micro)",
          letterSpacing: "0.06em",
          textTransform: "uppercase",
          color: "var(--color-text-secondary)",
        }}
      >
        {props.label}
      </span>
      <IconButton label={props.addLabel} size={26} onClick={props.onAdd}>
        <Icon name={props.addIcon} size={14} />
      </IconButton>
    </div>
  );
}

/**
 * 一条会话。状态槽在最前面——**状态优先用图标与文字，颜色是第二信号**；
 * hover / active 一律中性填充，绝不染 accent。
 */
function SessionRow(props: {
  title: string;
  running: boolean;
  failed: boolean;
  active: boolean;
  onClick?: (() => void) | undefined;
}) {
  const [hover, setHover] = useState(false);
  const status = props.running
    ? { icon: "loader-circle" as const, color: "var(--color-accent)", label: "Running", spin: true }
    : props.failed
      ? { icon: "triangle-alert" as const, color: "var(--color-danger)", label: "Failed", spin: false }
      : { icon: "check" as const, color: "var(--color-text-tertiary)", label: "Idle", spin: false };
  return (
    <button
      type="button"
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
        background: props.active || hover ? "var(--color-bg-hover)" : "transparent",
        color: "var(--color-text-primary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        fontWeight: props.active ? "var(--weight-semibold)" : "var(--weight-regular)",
        textAlign: "left",
        cursor: props.onClick === undefined ? "default" : "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      <span
        title={status.label}
        style={{ display: "grid", placeItems: "center", flex: "0 0 auto", color: status.color }}
      >
        <Icon name={status.icon} size={13} strokeWidth={1.8} spin={status.spin} />
      </span>
      <span
        style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}
      >
        {props.title}
      </span>
    </button>
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

function FooterRow(props: { children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
      {props.children}
    </div>
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
