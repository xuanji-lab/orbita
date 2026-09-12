import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import type { RightPanelKind } from "./RightRail";
import type { SkillsState } from "../features/skills/useSkills";

/**
 * 右侧分屏面板的共享壳（规格 §3）：页头（view toggle 位 + 标题 + x）、内容区
 * （原地替换，120ms 淡入）、footer 动作区（发丝顶线分隔）。Skills / MCP 两个
 * 面板共用这一副骨架。
 *
 * 两种容器形态（规格 §1.3）：
 * - **分屏**：320px 固定宽，插在聊天面与右图标条之间，chat 保持挂载可交互；
 * - **窄窗覆盖**（<960px）：绝对定位于 layer 右缘，宽 320、内容区全高，阴影升
 *   `--shadow-popover`。不是 modal：无遮罩、点外面不关（关闭只有三个出口：
 *   再点图标 / x / Esc）。
 *
 * 进入 220ms `--duration-enter --ease-out-quint` 向右滑入——动效只解释「东西
 * 去哪了」。内容在两个面板之间切换时 120ms fade（key 换帧触发）。
 *
 * S-0 的内容是最小平铺（链路是真的：数据、link/unlink、Reload 都接通）；
 * 1-4 / 1-1 renderer 按设计稿重写内容区。
 */
export function RightPanel(props: {
  panel: RightPanelKind;
  narrow: boolean;
  skills: SkillsState;
  onClose: () => void;
}) {
  const { panel, narrow } = props;

  useEffect(() => {
    if (panel === null) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [panel, props]);

  const title = panel === "skills" ? "Skills" : "MCP servers";
  return (
    <aside
      className={narrow ? "pane right-panel-overlay" : "pane"}
      style={{
        flex: narrow ? undefined : "0 0 320px",
        width: narrow ? 320 : undefined,
        display: "grid",
        gridTemplateRows: "auto minmax(0,1fr)",
        animation: "right-panel-in var(--duration-enter) var(--ease-out-quint)",
        ...(narrow
          ? {
              position: "absolute",
              top: "var(--space-3)",
              bottom: "var(--space-3)",
              right: "calc(var(--space-3) + 32px + var(--space-3))",
              boxShadow: "var(--shadow-popover)",
              zIndex: 20,
            }
          : {}),
      }}
    >
      <header
        className="titlebar"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          minWidth: 0,
          height: 30,
          padding: "12px 14px",
          boxSizing: "content-box",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        {/* view toggle 的位置（1-4 的 list/blend chips 长在这里；MCP 面板没有它） */}
        <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
          {title}
        </strong>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          title="Close"
          onClick={props.onClose}
          className="no-drag"
          style={{
            width: 26,
            height: 26,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 0,
            border: 0,
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--color-bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
          }}
        >
          <Icon name="x" size={16} />
        </button>
      </header>

      {/* key 换帧：skills ↔ mcp 切内容时 120ms 淡入（原地替换，不关再开） */}
      <div
        key={panel}
        className="scroll"
        style={{
          minHeight: 0,
          padding: "var(--space-5) var(--space-4)",
          display: "grid",
          gap: "var(--space-2)",
          alignContent: "start",
          animation: "right-panel-fade 120ms var(--ease-out-quint)",
        }}
      >
        {panel === "skills" ? <SkillsBody skills={props.skills} /> : <McpBody skills={props.skills} />}
      </div>
    </aside>
  );
}

/** S-0 的 skills 平铺：每行名字 + 归属一句话。1-4 按设计稿重写（分组 / N sets / missing 徽标）。 */
function SkillsBody(props: { skills: SkillsState }) {
  const { skills } = props;
  if (skills.load.kind === "loading" && skills.skills.length === 0) {
    return <PanelLine>Loading skills…</PanelLine>;
  }
  if (skills.load.kind === "failed" && skills.skills.length === 0) {
    return <PanelLine>Couldn’t load skills. {skills.load.message}</PanelLine>;
  }
  if (skills.skills.length === 0) {
    return <PanelLine>No skill yet. Put a folder with a SKILL.md into the skills directory.</PanelLine>;
  }
  return (
    <>
      {skills.skills.map((skill) => (
        <div
          key={skill.slug}
          style={{
            display: "grid",
            gap: 2,
            padding: "var(--space-3)",
            background: "var(--color-bg-panel)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <span style={{ fontSize: "var(--font-size-body)" }}>{skill.name}</span>
          <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
            {skill.missing
              ? "Missing · links exist but the folder is gone"
              : [
                  skill.global ? "Global" : "",
                  ...skills.workspaces
                    .filter((ws) => skill.workspaces.includes(ws.id))
                    .map((ws) => ws.name),
                ]
                  .filter(Boolean)
                  .join(", ") || "Not linked"}
          </span>
        </div>
      ))}
    </>
  );
}

/** S-0 的 MCP 平铺：server + 状态 + Edit/Reload（1-1 的链路保活，1-1 renderer 重写样式）。 */
function McpBody(props: { skills: SkillsState }) {
  const { servers, serversLoad } = props.skills;
  const [busy, setBusy] = useState(false);
  if (serversLoad.kind === "loading" && servers.length === 0) {
    return <PanelLine>Loading servers…</PanelLine>;
  }
  if (serversLoad.kind === "failed" && servers.length === 0) {
    return <PanelLine>Couldn’t load MCP config. {serversLoad.message}</PanelLine>;
  }
  if (servers.length === 0) return <PanelLine>No MCP server configured.</PanelLine>;
  return (
    <>
      {servers.map((server) => (
        <div
          key={server.name}
          style={{
            display: "grid",
            gap: 2,
            padding: "var(--space-3)",
            background: "var(--color-bg-panel)",
            border: "1px solid var(--color-border-subtle)",
            borderRadius: "var(--radius-md)",
          }}
        >
          <span style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
            <strong style={{ fontSize: "var(--font-size-body)" }}>{server.name}</strong>
            <span
              style={{
                fontSize: "var(--font-size-caption)",
                color: server.status.kind === "failed" ? "var(--color-danger)" : "var(--color-text-tertiary)",
              }}
            >
              {server.status.kind === "ready"
                ? `${server.status.tools.length} tool${server.status.tools.length === 1 ? "" : "s"}`
                : server.status.kind === "failed"
                  ? `Failed · ${server.status.message}`
                  : server.status.kind === "disabled"
                    ? "Disabled"
                    : "Not connected yet"}
            </span>
          </span>
          <code
            style={{
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
              overflowWrap: "anywhere",
            }}
          >
            {server.detail}
          </code>
        </div>
      ))}
      <div style={{ display: "flex", gap: "var(--space-2)", marginTop: "var(--space-2)" }}>
        <PanelButton onClick={() => props.skills.openMcpConfig()}>
          <Icon name="pencil-line" size={14} /> Edit mcp.json
        </PanelButton>
        <PanelButton
          onClick={() => {
            setBusy(true);
            // reloadMcp 自己会把状态拉回来；busy 只管按钮在途
            window.setTimeout(() => setBusy(false), 400);
            props.skills.reloadMcp();
          }}
        >
          <Icon name="refresh-cw" size={14} /> {busy ? "Reloading…" : "Reload"}
        </PanelButton>
      </div>
      <PanelLine>Changes apply to the next task the agent starts.</PanelLine>
    </>
  );
}

function PanelLine(props: { children: React.ReactNode }) {
  return (
    <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
      {props.children}
    </p>
  );
}

function PanelButton(props: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "var(--space-2)",
        height: "var(--control-height-sm)",
        padding: "0 var(--space-3)",
        background: "var(--color-bg-muted)",
        color: "var(--color-text-primary)",
        border: 0,
        borderRadius: "var(--radius-md)",
        font: "inherit",
        fontSize: "var(--font-size-control)",
        cursor: "pointer",
      }}
    >
      {props.children}
    </button>
  );
}
