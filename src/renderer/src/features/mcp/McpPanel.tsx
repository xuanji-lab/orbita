import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import {
  PanelButton,
  PanelIconButton,
  PanelLine,
  RightPanelFrame,
} from "../../shell/RightPanel";
import { visibleTools, TOOL_CHIP_LIMIT } from "./tool-chips.ts";
import type { SkillsState } from "../skills/useSkills";
import type { McpServer, McpStatus } from "@shared/mcp";
import { isMcpServerName, parseMcpConfig } from "@shared/mcp";

/**
 * MCP 面板（1-1 renderer / §7 + 4-2）：套共享模板，页头无 view toggle——MCP 不分
 * workspace、没有集合概念，map 视图对它没有意义。
 *
 * 4-2：页头 + 进添加表单（Form / Paste JSON 两态 Chip 切换）；每行启停（power）
 * 与删除（trash + 面板内二次确认行，不弹窗）。写盘在主进程，成功后自动 reload。
 * Reload 的进行中态：按钮 loading、非 disabled 行实时转 connecting、列表不清空
 * （invoke 在 agent 重连完、新快照已缓存时才返回，见 host 的回执等待）。
 */
export function McpPanel(props: {
  skills: SkillsState;
  onClose: () => void;
}) {
  const { servers, serversLoad, openMcpConfig, reloadMcp } = props.skills;
  const [reloading, setReloading] = useState(false);
  const [adding, setAdding] = useState(false);
  /** 删除二次确认：正要删哪一台（面板内一行确认，不弹窗） */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 工具 chips 已展开的 server 名字集合（简报 1，一次展开不再收回） */
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());
  const error = serversLoad.kind === "failed" ? serversLoad.message : null;

  // Reload 期间：非 disabled 行都转 connecting（实时状态还没回来，不装作不变）
  const statusOf = (status: McpStatus): McpStatus =>
    reloading && status.kind !== "disabled" ? { kind: "connecting" } : status;

  /** Retry 与页头 Reload 同一路（简报 2：不新增契约），忙的时候两处按钮一起禁用 */
  const runReload = (): void => {
    setReloading(true);
    void Promise.resolve(reloadMcp()).finally(() => setReloading(false));
  };

  const header = (
    <>
      <Icon name="plug" size={16} style={{ color: "var(--color-text-secondary)" }} />
      <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
        MCP servers
      </strong>
    </>
  );

  if (adding) {
    return (
      <AddServerForm
        skills={props.skills}
        onCancel={() => setAdding(false)}
        onAdded={() => setAdding(false)}
        onClose={props.onClose}
      />
    );
  }

  return (
    <RightPanelFrame
      header={header}
      contentKey="mcp"
      onClose={props.onClose}
      headerExtra={
        <PanelIconButton title="Add a server" onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} />
        </PanelIconButton>
      }
      footer={
        <>
          <PanelButton onClick={openMcpConfig}>
            <Icon name="pencil-line" size={14} /> Edit mcp.json
          </PanelButton>
          <PanelButton disabled={reloading} onClick={runReload}>
            <Icon
              name="refresh-cw"
              size={14}
              // anim-continuous：窗口失焦时暂停（styles.css），持续动效不是 spin prop 的 orbita-spin
              className={reloading ? "anim-continuous" : undefined}
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
              <span style={{ flex: 1 }} />
              <PanelIconButton
                title={server.status.kind === "disabled" ? "Enable this server" : "Disable this server"}
                onClick={() => props.skills.setServerDisabled(server.name, server.status.kind !== "disabled")}
              >
                <Icon name="power" size={14} />
              </PanelIconButton>
              <PanelIconButton title="Remove this server" onClick={() => setConfirming(server.name)}>
                <Icon name="trash-2" size={14} />
              </PanelIconButton>
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
              <ToolChips
                tools={server.status.tools}
                expanded={expandedTools.has(server.name)}
                onExpand={() =>
                  setExpandedTools((prev) => {
                    const next = new Set(prev);
                    next.add(server.name);
                    return next;
                  })
                }
              />
            )}
            {server.status.kind === "failed" && (
              <div className="mcp-error">
                <p className="mcp-error-text">{server.status.message}</p>
                <span className="mcp-error-actions">
                  <button type="button" className="mcp-retry-btn" disabled={reloading} onClick={runReload}>
                    <Icon
                      name="refresh-cw"
                      size={11}
                      // anim-continuous：窗口失焦时暂停（styles.css），持续动效不是 spin prop 的 orbita-spin
                      className={reloading ? "anim-continuous" : undefined}
                      style={reloading ? { animation: "mcp-spin 1s linear infinite" } : undefined}
                    />
                    Retry
                  </button>
                </span>
              </div>
            )}
            {confirming === server.name && (
              <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
                <PanelLine>Remove {server.name}?</PanelLine>
                <PanelButton
                  danger
                  onClick={() => {
                    setConfirming(null);
                    void props.skills.removeServer(server.name).catch(() => undefined);
                  }}
                >
                  Remove
                </PanelButton>
                <PanelButton onClick={() => setConfirming(null)}>Cancel</PanelButton>
              </span>
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

/**
 * 添加表单（4-2）：Form / Paste JSON 两态。Form 手填字段；Paste 收
 * Claude Desktop 的 `{"mcpServers":{...}}` 或单个 `{"name":{...}}`。
 * 解析在渲染层用 shared 的 parseMcpConfig（纯函数），坏的当场报错。
 */
function AddServerForm(props: {
  skills: SkillsState;
  onCancel: () => void;
  onAdded: () => void;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"form" | "json">("form");
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http">("stdio");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [envText, setEnvText] = useState("");
  const [url, setUrl] = useState("");
  const [headersText, setHeadersText] = useState("");
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const existing = new Set(props.skills.servers.map((s) => s.name));
  const nameError =
    name === ""
      ? null
      : isMcpServerName(name)
        ? existing.has(name)
          ? "A server with this name already exists."
          : null
        : "Use letters, digits, dashes or underscores.";

  /** KEY=VALUE 一行一个（# 开头的行是注释，空行跳过） */
  const parseKeyValueLines = (text: string): Record<string, string> | null => {
    const out: Record<string, string> = {};
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const at = trimmed.indexOf("=");
      if (at <= 0) return null;
      out[trimmed.slice(0, at)] = trimmed.slice(at + 1);
    }
    return out;
  };

  /** 组出要提交的 {name, server}；不合法返回 null 并把错误写进 state */
  const build = (): { name: string; server: McpServer } | null => {
    if (name === "" || nameError !== null) return null;
    if (mode === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(jsonText);
      } catch {
        setError("That’s not valid JSON.");
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) {
        setError("Expected a JSON object.");
        return null;
      }
      // Claude Desktop 整份配置，或单个 {"name":{...}} 映射
      const servers = "mcpServers" in (parsed as Record<string, unknown>)
        ? parseMcpConfig(parsed)
        : parseMcpConfig({ mcpServers: parsed });
      const entries = Object.entries(servers);
      if (entries.length !== 1) {
        setError(entries.length === 0 ? "No valid server in that JSON." : "Paste one server at a time.");
        return null;
      }
      const [jsonName, jsonServer] = entries[0] ?? [null, null];
      if (jsonName === null || jsonServer === undefined) return null;
      if (name !== jsonName && existing.has(jsonName)) {
        setError(`A server named “${jsonName}” already exists.`);
        return null;
      }
      return { name: name === "" ? jsonName : name, server: jsonServer };
    }
    if (transport === "stdio") {
      if (command.trim() === "") {
        setError("Command is required for a stdio server.");
        return null;
      }
      const env = parseKeyValueLines(envText);
      if (env === null) {
        setError("Env lines must look like KEY=VALUE.");
        return null;
      }
      return {
        name,
        server: {
          transport: "stdio",
          command: command.trim(),
          ...(argsText.trim() === "" ? {} : { args: argsText.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "") }),
          ...(Object.keys(env).length === 0 ? {} : { env }),
        },
      };
    }
    if (url.trim() === "" || !/^https?:\/\//.test(url.trim())) {
      setError("URL must start with http:// or https://.");
      return null;
    }
    const headers = parseKeyValueLines(headersText);
    if (headers === null) {
      setError("Header lines must look like KEY=VALUE.");
      return null;
    }
    return {
      name,
      server: {
        transport: "http",
        url: url.trim(),
        ...(Object.keys(headers).length === 0 ? {} : { headers }),
      },
    };
  };

  const submit = (): void => {
    setError(null);
    const payload = build();
    if (payload === null || busy) return;
    setBusy(true);
    props.skills
      .addServer(payload.name, payload.server)
      .then(props.onAdded)
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <RightPanelFrame
      contentKey="add-server"
      onClose={props.onClose}
      header={
        <>
          <PanelIconButton title="Back to the list" onClick={props.onCancel}>
            <Icon name="chevron-left" size={16} />
          </PanelIconButton>
          <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
            Add a server
          </strong>
        </>
      }
      footer={
        <>
          <PanelButton onClick={props.onCancel}>Cancel</PanelButton>
          <span style={{ flex: 1 }} />
          <PanelButton onClick={submit} disabled={busy || (mode === "form" && name === "")}>
            {busy ? "Adding…" : "Add"}
          </PanelButton>
        </>
      }
    >
      <div
        style={{
          padding: "var(--space-5) var(--space-4)",
          display: "grid",
          gap: "var(--space-4)",
          alignContent: "start",
        }}
      >
        <span style={{ display: "flex", gap: 4 }}>
          <Chip active={mode === "form"} onClick={() => setMode("form")}>
            Form
          </Chip>
          <Chip active={mode === "json"} onClick={() => setMode("json")}>
            Paste JSON
          </Chip>
        </span>

        <FormRow label="Name" hint="Tool names look like mcp__name__tool.">
          <input value={name} onChange={(e) => setName(e.target.value.trim())} className="text-field" />
          {nameError !== null && <FieldError>{nameError}</FieldError>}
        </FormRow>

        {mode === "form" ? (
          <>
            <FormRow label="Transport">
              <span style={{ display: "flex", gap: 4 }}>
                <Chip active={transport === "stdio"} onClick={() => setTransport("stdio")}>
                  stdio
                </Chip>
                <Chip active={transport === "http"} onClick={() => setTransport("http")}>
                  http
                </Chip>
              </span>
            </FormRow>
            {transport === "stdio" ? (
              <>
                <FormRow label="Command" hint="The executable to run, e.g. node or npx.">
                  <input value={command} onChange={(e) => setCommand(e.target.value)} className="text-field" />
                </FormRow>
                <FormRow label="Arguments" hint="One per line.">
                  <textarea
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    rows={3}
                    className="text-field"
                    style={{ fontFamily: "var(--font-family-mono)" }}
                  />
                </FormRow>
                <FormRow label="Environment" hint="One KEY=VALUE per line.">
                  <textarea
                    value={envText}
                    onChange={(e) => setEnvText(e.target.value)}
                    rows={3}
                    className="text-field"
                    style={{ fontFamily: "var(--font-family-mono)" }}
                  />
                </FormRow>
              </>
            ) : (
              <>
                <FormRow label="URL" hint="Streamable HTTP endpoint.">
                  <input value={url} onChange={(e) => setUrl(e.target.value)} className="text-field" placeholder="https://example.com/mcp" />
                </FormRow>
                <FormRow label="Headers" hint="One KEY=VALUE per line.">
                  <textarea
                    value={headersText}
                    onChange={(e) => setHeadersText(e.target.value)}
                    rows={3}
                    className="text-field"
                    style={{ fontFamily: "var(--font-family-mono)" }}
                  />
                </FormRow>
              </>
            )}
          </>
        ) : (
          <FormRow
            label="Server JSON"
            hint={'Claude Desktop format {"mcpServers":{…}} or a single {"name":{…}}.'}
          >
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={10}
              className="text-field"
              style={{ fontFamily: "var(--font-family-mono)", lineHeight: 1.6 }}
              placeholder={'{\n  "mcpServers": {\n    "demo": { "command": "node", "args": ["server.js"] }\n  }\n}'}
            />
          </FormRow>
        )}
        {error !== null && <FieldError>{error}</FieldError>}
      </div>
    </RightPanelFrame>
  );
}

function FormRow(props: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: "var(--space-2)" }}>
      <span style={{ fontSize: "var(--font-size-caption)", fontWeight: "var(--weight-medium)" }}>
        {props.label}
      </span>
      {props.children}
      {props.hint !== undefined && (
        <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
          {props.hint}
        </span>
      )}
    </label>
  );
}

function FieldError(props: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
      {props.children}
    </span>
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
      // anim-continuous：窗口失焦时暂停（styles.css），持续动效不是 spin prop 的 orbita-spin
      className={status.kind === "connecting" ? "anim-continuous" : undefined}
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

/**
 * ready 卡的工具列表（简报 1）：纯函数 `visibleTools` 算出这一刻该显示哪些、
 * 折起来几个，这里只管渲染。展示用的 chip 是 `<span>`，「+N more」是
 * `<button>`（键盘可达，点击后在卡片内展开全部、不再收回）。
 */
function ToolChips(props: { tools: string[]; expanded: boolean; onExpand: () => void }) {
  const { shown, hidden } = visibleTools(props.tools, TOOL_CHIP_LIMIT, props.expanded);
  return (
    <div className="mcp-tool-chips">
      {shown.map((tool) => (
        <span key={tool} className="mcp-tool-chip">
          {tool}
        </span>
      ))}
      {hidden.length > 0 && (
        <button type="button" className="mcp-tool-chip mcp-tool-chip-more" onClick={props.onExpand}>
          +{hidden.length} more
        </button>
      )}
    </div>
  );
}
