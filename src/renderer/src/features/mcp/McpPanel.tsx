import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { PanelButton, PanelLine, RightPanelFrame } from "../../shell/RightPanel";
import type { SkillsState } from "../skills/useSkills";
import type { McpStatus } from "@shared/mcp";

/**
 * MCP 面板（1-1 renderer / §7）：套共享模板，页头无 view toggle——MCP 不分
 * workspace、没有集合概念，map 视图对它没有意义。
 *
 * Reload 的进行中态：按钮 loading、非 disabled 行实时转 connecting、列表不清空
 * （invoke 在 agent 重连完、新快照已缓存时才返回，见 host 的回执等待）。
 */
export function McpPanel(props: { narrow: boolean; skills: SkillsState; onClose: () => void }) {
  const { servers, serversLoad, openMcpConfig, reloadMcp } = props.skills;
  const [reloading, setReloading] = useState(false);
  const error = serversLoad.kind === "failed" ? serversLoad.message : null;

  // Reload 期间：非 disabled 行都转 connecting（实时状态还没回来，不装作不变）
  const statusOf = (status: McpStatus): McpStatus =>
    reloading && status.kind !== "disabled" ? { kind: "connecting" } : status;

  const header = (
    <>
      <Icon name="plug" size={16} style={{ color: "var(--color-text-secondary)" }} />
      <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
        MCP servers
      </strong>
    </>
  );

  return (
    <RightPanelFrame
      narrow={props.narrow}
      header={header}
      contentKey="mcp"
      onClose={props.onClose}
      footer={
        <>
          <PanelButton onClick={openMcpConfig}>
            <Icon name="pencil-line" size={14} /> Edit mcp.json
          </PanelButton>
          <PanelButton
            disabled={reloading}
            onClick={() => {
              setReloading(true);
              // reloadMcp 落定后重拉列表；busy 只由这里管，失败也要复位
              void Promise.resolve(reloadMcp()).finally(() => setReloading(false));
            }}
          >
            <Icon
              name="refresh-cw"
              size={14}
              style={reloading ? { animation: "mcp-spin 1s linear infinite" } : undefined}
            />{" "}
            {reloading ? "Reloading…" : "Reload"}
          </PanelButton>
        </>
      }
    >
      <div
        style={{
          padding: "var(--space-4)",
          display: "grid",
          gap: "var(--space-2)",
          alignContent: "start",
        }}
      >
        {error !== null && <PanelLine danger>{error}</PanelLine>}
        {serversLoad.kind === "loading" && servers.length === 0 && (
          <PanelLine>Loading servers…</PanelLine>
        )}
        {servers.length === 0 && serversLoad.kind !== "loading" && (
          <>
            <p style={{ margin: 0, fontSize: "var(--font-size-body)" }}>
              No MCP server configured.
            </p>
            <PanelLine>Edit mcp.json to add one.</PanelLine>
          </>
        )}
        {servers.map((server) => (
          <div
            key={server.name}
            style={{
              display: "grid",
              gap: "var(--space-2)",
              padding: "var(--space-3)",
              background: "var(--color-bg-panel)",
              border: "1px solid var(--color-border-subtle)",
              borderRadius: "var(--radius-md)",
            }}
          >
            <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
              <StatusIcon status={statusOf(server.status)} />
              <strong style={{ fontSize: "var(--font-size-body)" }}>{server.name}</strong>
              <StatusText status={statusOf(server.status)} />
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
            {server.status.kind === "ready" && server.status.tools.length > 0 && (
              <PanelLine>{server.status.tools.join(" · ")}</PanelLine>
            )}
            {server.status.kind === "failed" && (
              <p
                style={{
                  margin: 0,
                  fontSize: "var(--font-size-caption)",
                  color: "var(--color-danger)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {server.status.message}
              </p>
            )}
          </div>
        ))}
        <span style={{ marginTop: "var(--space-2)" }}>
          <PanelLine>
            Reload reads mcp.json and reconnects. Running tasks keep their current tools; new
            tasks get the new set.
          </PanelLine>
        </span>
      </div>
    </RightPanelFrame>
  );
}

/** 四状态图标对（§7）：ready=check / connecting=loader-circle 旋转 / failed=triangle-alert / disabled=circle-off。 */
function StatusIcon(props: { status: McpStatus }) {
  const { status } = props;
  const icon =
    status.kind === "ready"
      ? "check"
      : status.kind === "failed"
        ? "triangle-alert"
        : status.kind === "disabled"
          ? "circle-off"
          : "loader-circle";
  const color =
    status.kind === "failed"
      ? "var(--color-danger)"
      : status.kind === "ready"
        ? "var(--color-text-secondary)"
        : "var(--color-text-tertiary)";
  return (
    <Icon
      name={icon}
      size={14}
      style={{
        color,
        flex: "0 0 auto",
        animation: status.kind === "connecting" ? "mcp-spin 1s linear infinite" : undefined,
      }}
    />
  );
}

function StatusText(props: { status: McpStatus }) {
  const { status } = props;
  const text =
    status.kind === "ready"
      ? `${status.tools.length} tool${status.tools.length === 1 ? "" : "s"}`
      : status.kind === "failed"
        ? "Failed"
        : status.kind === "disabled"
          ? "Disabled"
          : "Not connected yet";
  return (
    <span
      style={{
        fontSize: "var(--font-size-caption)",
        color: status.kind === "failed" ? "var(--color-danger)" : "var(--color-text-tertiary)",
      }}
    >
      {text}
    </span>
  );
}
