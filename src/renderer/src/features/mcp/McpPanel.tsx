import { useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import {
  PanelButton,
  PanelHelp,
  PanelIconButton,
  PanelLine,
  RightPanelFrame,
} from "../../shell/RightPanel";
import { visibleTools, TOOL_CHIP_LIMIT } from "./tool-chips.ts";
import type { SkillsState } from "../skills/useSkills";
import type { McpServer, McpStatus, McpInstanceInfo, McpServerInfo } from "@shared/mcp";
import { isMcpServerName, parseMcpConfig } from "@shared/mcp";
import { headIconKind, statusLine, summarizeInstances } from "./row-display.ts";
import { mcpToken } from "../../shell/panel-token.ts";
import { useT } from "../../locale.ts";

/**
 * 一台 MCP 服务的详情（2026-10-30 能力面板）：列表在能力面板里（Skills 与 MCP 合成一张，
 * features/abilities/AbilitiesPanel.tsx），点一行打开这里——就是原来列表里那张卡，动作
 * 常显（命令、限定范围、工具、错误全文与重试；各工作区实例照旧点展开键才出——默认展开
 * 的话只有一个实例时同一段错误会出两遍：实例块一遍、整台的错误块一遍）。
 * 写盘在主进程，成功后自动重连；Reload 进行中非停用的实例转「连接中」。
 */
export function McpServerDetail(props: {
  skills: SkillsState;
  server: McpServerInfo;
  onBack: () => void;
  /** 「插入」：把 /mcp:<name> 插到主槽输入框当前光标处（面板不关） */
  onInsert: (token: string) => void;
}) {
  const t = useT();
  const { skills, server } = props;
  const [reloading, setReloading] = useState(false);
  /** 删除二次确认（面板内一行确认，不弹窗） */
  const [confirming, setConfirming] = useState(false);
  const [expandedTools, setExpandedTools] = useState(false);
  const [expandedInstances, setExpandedInstances] = useState(false);
  /** 启停 / 删除写失败的原因（一行红字） */
  const [error, setError] = useState<string | null>(null);
  const fail = (cause: unknown): void => setError(cause instanceof Error ? cause.message : String(cause));

  // Reload 期间：非 disabled 行都转 connecting（实时状态还没回来，不装作不变）
  const statusOf = (status: McpStatus): McpStatus =>
    reloading && status.kind !== "disabled" ? { kind: "connecting" } : status;
  /** Retry 与「更多」里的重新加载同一路（不新增契约） */
  const runReload = (): void => {
    setReloading(true);
    void Promise.resolve(skills.reloadMcp()).finally(() => setReloading(false));
  };

  return (
    <RightPanelFrame
      contentKey={`mcp:${server.name}`}
      header={
        <>
          <PanelIconButton title={t.mcp.backToList} onClick={props.onBack}>
            <Icon name="chevron-left" size={16} strokeWidth={2} />
          </PanelIconButton>
          <strong className="cap-title">{server.name}</strong>
        </>
      }
      headerExtra={<PanelHelp label={t.mcp.helpLabel} text={`${t.mcp.reloadNote} ${t.mcp.workspaceHint}`} />}
    >
      <div className="panel-list" style={{ paddingTop: "var(--space-2)" }}>
        {error !== null && (
          <p className="panel-empty" role="alert" style={{ color: "var(--color-danger)" }}>
            {error}
          </p>
        )}
        <McpServerCard
          server={server}
          reloading={reloading}
          statusOf={statusOf}
          confirming={confirming}
          expandedTools={expandedTools}
          expandedInstances={expandedInstances}
          onExpandTools={() => setExpandedTools(true)}
          onToggleInstances={() => setExpandedInstances((open) => !open)}
          onSetDisabled={(disabled) => {
            setError(null);
            void skills.setServerDisabled(server.name, disabled).catch(fail);
          }}
          onAskRemove={() => setConfirming(true)}
          onConfirmRemove={() => {
            setConfirming(false);
            setError(null);
            // 删掉之后这一项不在了：能力面板发现找不到就回列表
            void skills.removeServer(server.name).catch(fail);
          }}
          onCancelRemove={() => setConfirming(false)}
          onReload={runReload}
          onInsert={() => props.onInsert(mcpToken(server.name))}
        />
      </div>
    </RightPanelFrame>
  );
}

/*
 * 一台 server 的卡片：头行状态 + 名字 + 动作（插入 / 启停 / 删除，详情里常显——
 * 列表时代是悬停才浮现）+ 实例展开键；下面是命令、限定范围、定义来源、各工作区
 * 实例与错误块、工具 chips、删除确认行。
 */
function McpServerCard(props: {
  server: McpServerInfo;
  /** Reload 进行中：非 disabled 行实时转 connecting（状态换算在面板侧算好传进来） */
  reloading: boolean;
  statusOf: (status: McpStatus) => McpStatus;
  confirming: boolean;
  expandedTools: boolean;
  expandedInstances: boolean;
  onExpandTools: () => void;
  onToggleInstances: () => void;
  onSetDisabled: (disabled: boolean) => void;
  onAskRemove: () => void;
  onConfirmRemove: () => void;
  onCancelRemove: () => void;
  onReload: () => void;
  /** 「插入」键：插 token 进输入框（停用的 server 没有——展不开工具，token 没用） */
  onInsert: () => void;
}) {
  const t = useT();
  const { server } = props;
  const summary = summarizeInstances(server.instances);
  const line = statusLine(summary);
  const failedInstances = server.instances.filter(
    (instance): instance is McpInstanceInfo & { status: { kind: "failed"; message: string } } =>
      instance.status.kind === "failed",
  );
  return (
    <div className="mcp-card">
      <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        {/* 有实例失败就红三角——哪怕合并状态是就绪（失败不许被遮住） */}
        <StatusIcon kind={headIconKind(props.statusOf(server.status), summary)} />
        <strong className="mcp-name">{server.name}</strong>
        <StatusText status={props.statusOf(server.status)} />
        {/* 详情里动作常显（列表时代悬停才浮现，现在列表在能力面板，这张卡只在详情里） */}
        <span className="mcp-actions">
          {/* 「插入」排在启停 / 删除之前（建设性动作在前）。停用的 server 不给（展不开工具） */}
          {!server.disabled && (
            <PanelIconButton title={t.abilities.insertTip} onClick={props.onInsert}>
              <Icon name="corner-down-left" size={14} />
            </PanelIconButton>
          )}
          {/* 只来自工作区自带 .mcp.json 的：写全局文件够不着它，
              按钮禁用并指到真正的文件（遮蔽不是编辑） */}
          <PanelIconButton
            title={
              server.source.global
                ? server.disabled
                  ? t.mcp.enable
                  : t.mcp.disable
                : t.mcp.workspaceFileOnly
            }
            disabled={!server.source.global}
            onClick={() => props.onSetDisabled(!server.disabled)}
          >
            <Icon name="power" size={14} />
          </PanelIconButton>
          <PanelIconButton
            title={server.source.global ? t.mcp.removeTip : t.mcp.workspaceFileOnly}
            disabled={!server.source.global}
            onClick={props.onAskRemove}
          >
            <Icon name="trash-2" size={14} />
          </PanelIconButton>
        </span>
        {server.instances.length > 0 && (
          <button
            type="button"
            className="mcp-expand"
            aria-expanded={props.expandedInstances}
            title={props.expandedInstances ? t.mcp.collapseInstances : t.mcp.expandInstances}
            onClick={props.onToggleInstances}
          >
            <Icon name="chevron-right" size={13} />
          </button>
        )}
      </span>
      <code
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-tertiary)",
          overflowWrap: "anywhere",
        }}
      >
        {server.detail}
      </code>
      {/* 限定工作区：不显示的话，用户会以为「配了却没生效」是自己的错 */}
      {server.scopedTo.length > 0 && (
        <span className="mcp-scope">
          <Icon name="folder" size={12} />
          {t.mcp.scopedTo(server.scopedTo.join("、"))}
        </span>
      )}
      {/* 定义来源：工作区自带的 .mcp.json（配置跟文件夹走）。全局的不标——默认即全局 */}
      {server.source.workspaces.length > 0 && (
        <span className="mcp-scope">
          <Icon name="folder" size={12} />
          {server.source.global
            ? t.mcp.sourceOverride(server.source.workspaces.join("、"))
            : t.mcp.sourceWorkspace(server.source.workspaces.join("、"))}
        </span>
      )}
      {/* 实例状态行：独占一行不挤头行。全灭时 null——错误块接管，不重复说 */}
      {line !== null && (
        <span className={`mcp-ws-status${line.failed.length > 0 ? " bad" : ""}`}>
          {line.failed.length > 0
            ? t.mcp.instancesPartial(line.ready, line.total, line.failed.join("、"))
            : t.mcp.instancesReady(line.ready, line.total)}
        </span>
      )}
      {/* 实例明细：诊断层——哪一份坏了、它指向哪里；错误块就地放在明细尾 */}
      {props.expandedInstances && server.instances.length > 0 && (
        <div className="mcp-instances">
          {server.instances.map((instance) => (
            <div key={instance.scope} className="mcp-instance">
              <Icon
                name={instance.status.kind === "failed" ? "triangle-alert" : "folder"}
                size={13}
                style={{
                  color:
                    instance.status.kind === "failed"
                      ? "var(--color-danger)"
                      : "var(--color-text-tertiary)",
                }}
              />
              <span className="ws">{instance.workspace}</span>
              <span className={`st${instance.status.kind === "failed" ? " bad" : ""}`}>
                {instance.status.kind === "ready"
                  ? t.mcp.instanceReady(instance.status.tools.length)
                  : instance.status.kind === "failed"
                    ? t.mcp.connectFailed
                    : instance.status.kind === "connecting"
                      ? t.mcp.connecting
                      : t.mcp.notConnected}
              </span>
              {instance.label !== "" && <span className="bind">→ {instance.label}</span>}
            </div>
          ))}
          {failedInstances.map((instance) => (
            <div key={instance.scope} className="mcp-error">
              <p className="mcp-error-text">{instance.status.message}</p>
              <span className="mcp-error-actions">
                <button type="button" className="mcp-retry-btn" disabled={props.reloading} onClick={props.onReload}>
                  <Icon
                    name="refresh-cw"
                    size={11}
                    className={props.reloading ? "anim-continuous" : undefined}
                    style={props.reloading ? { animation: "mcp-spin 1s linear infinite" } : undefined}
                  />
                  {t.mcp.reload}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {server.status.kind === "ready" && server.status.tools.length > 0 && (
        <ToolChips tools={server.status.tools} expanded={props.expandedTools} onExpand={props.onExpandTools} />
      )}
      {server.status.kind === "failed" && (
        <div className="mcp-error">
          <p className="mcp-error-text">{server.status.message}</p>
          <span className="mcp-error-actions">
            <button type="button" className="mcp-retry-btn" disabled={props.reloading} onClick={props.onReload}>
              <Icon
                name="refresh-cw"
                size={11}
                // anim-continuous：窗口失焦时暂停（styles.css），持续动效不是 spin prop 的 orbita-spin
                className={props.reloading ? "anim-continuous" : undefined}
                style={props.reloading ? { animation: "mcp-spin 1s linear infinite" } : undefined}
              />
              {t.mcp.reload}
            </button>
          </span>
        </div>
      )}
      {props.confirming && (
        <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", flexWrap: "wrap" }}>
          <PanelLine>{t.mcp.removeConfirm(server.name)}</PanelLine>
          <PanelButton danger onClick={props.onConfirmRemove}>
            {t.mcp.remove}
          </PanelButton>
          <PanelButton onClick={props.onCancelRemove}>{t.common.cancel}</PanelButton>
        </span>
      )}
    </div>
  );
}

/**
 * 添加表单（4-2）：Form / Paste JSON 两态。Form 手填字段；Paste 收
 * Claude Desktop 的 `{"mcpServers":{...}}` 或单个 `{"name":{...}}`。
 * 解析在渲染层用 shared 的 parseMcpConfig（纯函数），坏的当场报错。
 */
export function AddServerForm(props: {
  skills: SkillsState;
  onCancel: () => void;
  onAdded: () => void;
}) {
  const t = useT();
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
          ? t.mcp.nameTaken
          : null
        : t.mcp.nameShape;

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
        setError(t.mcp.invalidJson);
        return null;
      }
      if (typeof parsed !== "object" || parsed === null) {
        setError(t.mcp.expectedObject);
        return null;
      }
      // Claude Desktop 整份配置，或单个 {"name":{...}} 映射
      const servers = "mcpServers" in (parsed as Record<string, unknown>)
        ? parseMcpConfig(parsed)
        : parseMcpConfig({ mcpServers: parsed });
      const entries = Object.entries(servers);
      if (entries.length !== 1) {
        setError(entries.length === 0 ? t.mcp.noValidServer : t.mcp.oneAtATime);
        return null;
      }
      const [jsonName, jsonServer] = entries[0] ?? [null, null];
      if (jsonName === null || jsonServer === undefined) return null;
      if (name !== jsonName && existing.has(jsonName)) {
        setError(t.mcp.jsonNameTaken(jsonName));
        return null;
      }
      return { name: name === "" ? jsonName : name, server: jsonServer };
    }
    if (transport === "stdio") {
      if (command.trim() === "") {
        setError(t.mcp.commandRequired);
        return null;
      }
      const env = parseKeyValueLines(envText);
      if (env === null) {
        setError(t.mcp.envShape);
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
      setError(t.mcp.urlShape);
      return null;
    }
    const headers = parseKeyValueLines(headersText);
    if (headers === null) {
      setError(t.mcp.headerShape);
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
      header={
        <>
          <PanelIconButton title={t.mcp.backToList} onClick={props.onCancel}>
            <Icon name="chevron-left" size={16} strokeWidth={2} />
          </PanelIconButton>
          <strong className="cap-title">{t.mcp.addServer}</strong>
        </>
      }
      footer={
        <>
          <PanelButton onClick={props.onCancel}>{t.common.cancel}</PanelButton>
          <span style={{ flex: 1 }} />
          <PanelButton onClick={submit} disabled={busy || (mode === "form" && name === "")}>
            {busy ? t.mcp.adding : t.common.add}
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
            {t.mcp.form}
          </Chip>
          <Chip active={mode === "json"} onClick={() => setMode("json")}>
            {t.mcp.pasteJson}
          </Chip>
        </span>

        <FormRow label={t.mcp.name} hint={t.mcp.nameHint}>
          <input value={name} onChange={(e) => setName(e.target.value.trim())} className="text-field" />
          {nameError !== null && <FieldError>{nameError}</FieldError>}
        </FormRow>

        {mode === "form" ? (
          <>
            <FormRow label={t.mcp.transport}>
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
                <FormRow label={t.mcp.command} hint={t.mcp.commandHint}>
                  <input value={command} onChange={(e) => setCommand(e.target.value)} className="text-field" />
                </FormRow>
                <FormRow label={t.mcp.args} hint={t.mcp.argsHint}>
                  <textarea
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    rows={3}
                    className="text-field"
                    style={{ fontFamily: "var(--font-family-mono)" }}
                  />
                </FormRow>
                <FormRow label={t.mcp.env} hint={t.mcp.keyValueHint}>
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
                <FormRow label={t.mcp.url} hint={t.mcp.urlHint}>
                  <input value={url} onChange={(e) => setUrl(e.target.value)} className="text-field" placeholder="https://example.com/mcp" />
                </FormRow>
                <FormRow label={t.mcp.headers} hint={t.mcp.keyValueHint}>
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
            label={t.mcp.serverJson}
            hint={t.mcp.serverJsonHint}
          >
            <textarea
              value={jsonText}
              onChange={(e) => setJsonText(e.target.value)}
              rows={10}
              className="text-field"
              style={{ fontFamily: "var(--font-family-mono)", lineHeight: "var(--line-height-code)" }}
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
      <span style={{ fontSize: "var(--font-size-sm)", fontWeight: "var(--weight-medium)" }}>
        {props.label}
      </span>
      {props.children}
      {props.hint !== undefined && (
        <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-tertiary)" }}>
          {props.hint}
        </span>
      )}
    </label>
  );
}

function FieldError(props: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: "var(--font-size-sm)", color: "var(--color-danger)" }}>
      {props.children}
    </span>
  );
}

/** 五状态图标对：ready=check / connecting=loader-circle 旋转 / failed=triangle-alert / disabled=circle-off / idle=circle-dashed（静态，不转）。 */
function StatusIcon(props: { kind: McpStatus["kind"] }) {
  const { kind } = props;
  const icon =
    kind === "ready"
      ? "check"
      : kind === "failed"
        ? "triangle-alert"
        : kind === "disabled"
          ? "circle-off"
          : kind === "idle"
            ? "circle-dashed"
            : "loader-circle";
  const color =
    kind === "failed"
      ? "var(--color-danger)"
      : kind === "ready"
        ? "var(--color-text-secondary)"
        : "var(--color-text-tertiary)";
  return (
    <Icon
      name={icon}
      size={14}
      // anim-continuous：窗口失焦时暂停（styles.css），持续动效不是 spin prop 的 orbita-spin
      className={kind === "connecting" ? "anim-continuous" : undefined}
      style={{
        color,
        flex: "0 0 auto",
        animation: kind === "connecting" ? "mcp-spin 1s linear infinite" : undefined,
      }}
    />
  );
}

function StatusText(props: { status: McpStatus }) {
  const t = useT();
  const { status } = props;
  const text =
    status.kind === "ready"
      ? t.mcp.tools(status.tools.length)
      : status.kind === "failed"
        ? t.common.failed
        : status.kind === "disabled"
          ? t.mcp.disabled
          : t.mcp.notConnected;
  return (
    <span
      className="mcp-status-text"
      style={{
        fontSize: "var(--font-size-sm)",
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
  const t = useT();
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
          {t.mcp.more(hidden.length)}
        </button>
      )}
    </div>
  );
}

