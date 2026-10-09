import { useEffect, useRef, useState } from "react";
import { Icon } from "../../shell/Icon";
import { Chip } from "../../shell/Chip";
import { IconButton } from "../../shell/IconButton";
import {
  PanelButton,
  PanelIconButton,
  PanelLine,
  RightPanelFrame,
} from "../../shell/RightPanel";
import { visibleTools, TOOL_CHIP_LIMIT } from "./tool-chips.ts";
import type { SkillsState } from "../skills/useSkills";
import type { McpServer, McpStatus, McpInstanceInfo, McpServerInfo } from "@shared/mcp";
import { isMcpServerName, parseMcpConfig } from "@shared/mcp";
import { headIconKind, statusLine, summarizeInstances } from "./row-display.ts";
import { mcpToken, type TokenPickerControl } from "../../shell/panel-token.ts";
import { useT } from "../../locale.ts";

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
  /** 「/ + 空格」右栏选取模式（panel-token.ts）：从 Skills 侧 Tab 切过来 */
  picker?: TokenPickerControl;
}) {
  const t = useT();
  const { servers, serversLoad, serverWarnings, openMcpConfig, reloadMcp } = props.skills;
  const [reloading, setReloading] = useState(false);
  const [adding, setAdding] = useState(false);
  /** 删除二次确认：正要删哪一台（面板内一行确认，不弹窗） */
  const [confirming, setConfirming] = useState<string | null>(null);
  /** 工具 chips 已展开的 server 名字集合（简报 1，一次展开不再收回） */
  const [expandedTools, setExpandedTools] = useState<ReadonlySet<string>>(new Set());
  /** 实例明细展开的 server 名字集合。**不记**：面板关掉组件就卸载——
      失败行自己会穿透红字，诊断入口不需要记忆 */
  const [expandedInstances, setExpandedInstances] = useState<ReadonlySet<string>>(new Set());
  const toggleInstances = (name: string): void =>
    setExpandedInstances((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const error = serversLoad.kind === "failed" ? serversLoad.message : null;

  // ── 选取模式（「/ + 空格」从 Skills 侧 Tab 切过来）─────────────────
  const picker = props.picker;
  /** 选取模式的过滤词（面板平时没有过滤行，选取时才出现） */
  const [query, setQuery] = useState("");
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** 选取模式的高亮卡（↑↓ 移动，Enter 选中）；-1 = 无高亮 */
  const [pickIndex, setPickIndex] = useState(-1);
  // 可选行：没被文件停用的 server（停用的展不开工具，token 落进输入框也没用）
  const pickRows =
    picker !== undefined
      ? servers.filter(
          (s) => !s.disabled && s.name.toLowerCase().includes(query.trim().toLowerCase()),
        )
      : [];
  useEffect(() => {
    if (picker === undefined) return;
    setQuery("");
    setPickIndex(-1);
    filterRef.current?.focus();
  }, [picker?.request]);
  // 列表还在读盘 / 过滤后越界：补首行高亮 / 夹回
  useEffect(() => {
    if (picker === undefined) return;
    setPickIndex((i) => (pickRows.length === 0 ? -1 : i === -1 ? 0 : Math.min(i, pickRows.length - 1)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickRows.length]);
  useEffect(() => {
    listRef.current?.querySelector('[data-picker-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [pickIndex]);
  const onPickerKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (picker === undefined) return;
    const count = pickRows.length;
    if (event.key === "ArrowDown" && count > 0) {
      event.preventDefault();
      setPickIndex((i) => (i === -1 ? 0 : (i + 1) % count));
    } else if (event.key === "ArrowUp" && count > 0) {
      event.preventDefault();
      setPickIndex((i) => (i === -1 ? count - 1 : (i - 1 + count) % count));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = pickRows[pickIndex >= 0 ? pickIndex : 0];
      if (row !== undefined) picker.onSelect(mcpToken(row.name));
    } else if (event.key === "Tab") {
      event.preventDefault();
      picker.onSwitch();
    } else if (event.key === "Escape") {
      event.stopPropagation();
      if (query !== "") setQuery("");
      else picker.onCancel();
    }
  };

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
        {t.mcp.title}
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
        <PanelIconButton title={t.mcp.addServer} onClick={() => setAdding(true)}>
          <Icon name="plus" size={16} />
        </PanelIconButton>
      }
      footer={
        <>
          <PanelButton onClick={openMcpConfig}>
            <Icon name="pencil-line" size={14} /> {t.mcp.editConfig}
          </PanelButton>
          <PanelButton disabled={reloading} onClick={runReload}>
            <Icon
              name="refresh-cw"
              size={14}
              // anim-continuous：窗口失焦时暂停（styles.css），持续动效不是 spin prop 的 orbita-spin
              className={reloading ? "anim-continuous" : undefined}
              style={reloading ? { animation: "mcp-spin 1s linear infinite" } : undefined}
            />{" "}
            {reloading ? t.mcp.reloading : t.mcp.reload}
          </PanelButton>
        </>
      }
    >
      {picker !== undefined && (
        <>
          <div className="skills-filter-row">
            <Icon name="search" size={14} />
            <input
              ref={filterRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onPickerKeyDown}
              placeholder={t.mcp.filterPlaceholder}
              aria-label={t.mcp.filterPlaceholder}
            />
            {query !== "" && (
              <IconButton label={t.skills.clear} size={20} onClick={() => setQuery("")}>
                <Icon name="x" size={12} />
              </IconButton>
            )}
          </div>
          <div className="panel-picker-hint" aria-hidden="true">
            {t.mcp.pickerHint}
          </div>
        </>
      )}
      <div
        ref={listRef}
        style={{
          padding: "var(--space-4)",
          display: "grid",
          gap: "var(--space-2)",
          alignContent: "start",
        }}
      >
        {error !== null && <PanelLine danger>{error}</PanelLine>}
        {serverWarnings.map((warning) => (
          <PanelLine key={warning} danger>{warning}</PanelLine>
        ))}
        {serversLoad.kind === "loading" && servers.length === 0 ? (
          <PanelLine>{t.mcp.loadingServers}</PanelLine>
        ) : servers.length === 0 ? (
          <McpEmptyState onAdd={() => setAdding(true)} onEditConfig={openMcpConfig} />
        ) : (
          <>
            {servers
              .filter(
                (server) =>
                  picker === undefined ||
                  (!server.disabled && server.name.toLowerCase().includes(query.trim().toLowerCase())),
              )
              .map((server, index) => (
                <McpServerCard
                  key={server.name}
                  server={server}
                  reloading={reloading}
                  statusOf={statusOf}
                  confirming={confirming === server.name}
                  expandedTools={expandedTools.has(server.name)}
                  expandedInstances={expandedInstances.has(server.name)}
                  onExpandTools={() =>
                    setExpandedTools((prev) => {
                      const next = new Set(prev);
                      next.add(server.name);
                      return next;
                    })
                  }
                  onToggleInstances={() => toggleInstances(server.name)}
                  onSetDisabled={(disabled) => props.skills.setServerDisabled(server.name, disabled)}
                  onAskRemove={() => setConfirming(server.name)}
                  onConfirmRemove={() => {
                    setConfirming(null);
                    void props.skills.removeServer(server.name).catch(() => undefined);
                  }}
                  onCancelRemove={() => setConfirming(null)}
                  onReload={runReload}
                  pickerActive={picker !== undefined && index === pickIndex}
                  onPickerSelect={
                    picker !== undefined ? () => picker.onSelect(mcpToken(server.name)) : undefined
                  }
                />
              ))}
            <button type="button" className="mcp-add-card" onClick={() => setAdding(true)}>
              <Icon name="plus" size={14} /> {t.mcp.addServer}
            </button>
            <span style={{ marginTop: "var(--space-2)" }}>
              <PanelLine>
                {t.mcp.reloadNote}
              </PanelLine>
              <PanelLine>
                {t.mcp.workspaceHint}
              </PanelLine>
            </span>
          </>
        )}
      </div>
    </RightPanelFrame>
  );
}

/*
 * 一台 server 的卡片（从 McpPanel 列表里提出来的组件）：选取模式下点选即插
 * token、高亮卡随 ↑↓ 移动；短按的原行为（启停 / 删除 / 展开实例与工具）不变。
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
  pickerActive?: boolean;
  onPickerSelect?: () => void;
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
    <div
      className={`mcp-card glass-card${props.pickerActive === true ? " picker-active" : ""}`}
      data-picker-active={props.pickerActive === true ? "true" : undefined}
      onClick={(event) => {
        if (props.onPickerSelect === undefined) return;
        // 行内动作键（启停 / 删除 / 展开实例与工具）各自干活，不当作整卡选取
        if ((event.target as HTMLElement).closest("button, a, input, textarea") !== null) return;
        props.onPickerSelect();
      }}
      style={{ cursor: props.onPickerSelect !== undefined ? "pointer" : undefined }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
        {/* 有实例失败就红三角——哪怕合并状态是就绪（失败不许被遮住） */}
        <StatusIcon kind={headIconKind(props.statusOf(server.status), summary)} />
        <strong className="mcp-name">{server.name}</strong>
        <StatusText status={props.statusOf(server.status)} />
        {/* 悬停/键盘聚焦浮现（简报 3）；删除确认行出现时强制常显，见 .reveal 注释 */}
        <span
          className="mcp-actions reveal"
          style={{ opacity: props.confirming ? 1 : undefined }}
        >
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
          fontSize: "var(--font-size-caption)",
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
function AddServerForm(props: {
  skills: SkillsState;
  onCancel: () => void;
  onAdded: () => void;
  onClose: () => void;
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
      onClose={props.onClose}
      header={
        <>
          <PanelIconButton title={t.mcp.backToList} onClick={props.onCancel}>
            <Icon name="chevron-left" size={16} />
          </PanelIconButton>
          <strong style={{ fontSize: "var(--font-size-title)", fontWeight: "var(--weight-bold)" }}>
            {t.mcp.addServer}
          </strong>
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

/** 空态（简报 4）：一台 server 都没有时的主画面，两个出口都是现成动作，不新增契约 */
function McpEmptyState(props: { onAdd: () => void; onEditConfig: () => void }) {
  const t = useT();
  return (
    <div className="mcp-empty">
      <Icon name="plug" size={26} strokeWidth={1.5} className="mcp-empty-icon" />
      <p className="mcp-empty-title">{t.mcp.emptyTitle}</p>
      <p className="mcp-empty-desc">
        {t.mcp.emptyDesc}
      </p>
      <span className="mcp-empty-actions">
        <PanelButton onClick={props.onAdd}>
          <Icon name="plus" size={14} /> {t.mcp.addServer}
        </PanelButton>
        <PanelButton onClick={props.onEditConfig}>
          <Icon name="pencil-line" size={14} /> {t.mcp.editConfig}
        </PanelButton>
      </span>
    </div>
  );
}
