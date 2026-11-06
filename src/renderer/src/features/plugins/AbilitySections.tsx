/**
 * 「能力」面板里零散技能 / 零散 MCP 详情的几节（PluginDetail 按 detailParts 决定画哪几节）：
 * 技能的内容三格（失焦即存）、MCP 的状态 / 工具、两者共用的「在哪儿可用」小标，
 * 以及列表行右侧的种类小标。样式沿用插件详情的 .pl-card / .pl-field / .pl-tag，不另起一套。
 * 旧实现取自旧技能面板与旧 MCP 面板（git 0a8561b1 的 SkillsPanel.tsx / McpPanel.tsx），按详情页的节样式重写。
 */
import { useEffect, useRef, useState } from "react";
import type { McpInstanceInfo, McpServerInfo, McpStatus } from "@shared/mcp";
import type { PluginScope, PluginView } from "@shared/plugin";
import type { SkillContent } from "@shared/skill";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { useT } from "../../locale.ts";
import { Chip } from "../../shell/Chip";
import { Icon } from "../../shell/Icon";
import { mcpErrors, readyWorkspaces } from "./mcp-row-display.ts";
import { TOOL_CHIP_LIMIT, shortToolName, visibleTools } from "./mcp-tool-chips.ts";
import { availabilityScopeOf, nextAvailability, rowKind, type AvailabilityChip } from "./plugin-view.ts";

/** 列表行 / 选取行右侧的小字种类标：插件 / 内置 / 技能 / MCP。 */
export function KindTag(props: { view: Pick<PluginView, "origin" | "install"> }) {
  const t = useT().plugins;
  return <span className="pl-kind-tag">{t.rowKind[rowKind(props.view)]}</span>;
}

// ---------- 技能：内容三格 ----------

/**
 * 名称 / 什么时候用 / 说明（SKILL.md 正文）三格。**失焦即存**，只写改过的那一格；写失败一行红字。
 * 已落盘的那一份放 ref 里，用来判断失焦时有没有真的改过（没改不写盘，不白动文件的修改时间）。
 */
export function SkillContentBody(props: { slug: string; onSaved: () => Promise<void> }) {
  const t = useT();
  const p = t.plugins;
  const [content, setContent] = useState<SkillContent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const saved = useRef<SkillContent | null>(null);

  useEffect(() => {
    let live = true;
    setContent(null);
    setError(null);
    void api.skill
      .read(props.slug)
      .then((next) => {
        if (!live) return;
        saved.current = next;
        setContent(next);
        if (next === null) setError(p.contentReadFailed(props.slug));
      })
      .catch((cause: unknown) => {
        if (live) setError(p.contentReadFailed(cause instanceof Error ? cause.message : String(cause)));
      });
    return () => {
      live = false;
    };
    // p 是文案表（随语言换），读盘只跟着 slug
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.slug]);

  const commit = (field: keyof SkillContent): void => {
    const draft = content;
    const base = saved.current;
    if (draft === null || base === null || draft[field] === base[field]) return;
    setSaving(true);
    setError(null);
    void api.skill
      .write(props.slug, { [field]: draft[field] })
      .then(() => {
        saved.current = { ...base, [field]: draft[field] };
        return props.onSaved();
      })
      .catch((cause: unknown) => setError(p.contentSaveFailed(cause instanceof Error ? cause.message : String(cause))))
      .finally(() => setSaving(false));
  };

  if (content === null) {
    return error === null ? (
      <span className="pl-muted">{t.common.loading}</span>
    ) : (
      <span className="pl-field-error" role="alert">
        {error}
      </span>
    );
  }
  return (
    <div className="pl-form">
      <label className="pl-field">
        <span className="pl-field-label">{p.fieldName}</span>
        <input className="text-field" spellCheck={false} value={content.name} onChange={(event) => setContent({ ...content, name: event.target.value })} onBlur={() => commit("name")} />
      </label>
      <label className="pl-field">
        <span className="pl-field-label">{p.fieldWhen}</span>
        <textarea className="text-field" rows={3} value={content.description} onChange={(event) => setContent({ ...content, description: event.target.value })} onBlur={() => commit("description")} />
      </label>
      <label className="pl-field">
        <span className="pl-field-label">{p.fieldBody}</span>
        <textarea className="text-field pl-mono-area" rows={8} value={content.body} onChange={(event) => setContent({ ...content, body: event.target.value })} onBlur={() => commit("body")} />
      </label>
      {saving && <span className="pl-field-hint">{p.contentSaving}</span>}
      {error !== null && (
        <span className="pl-field-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

// ---------- 在哪儿可用 ----------

/**
 * 全局 / 各工作区小标（原来的 link / unlink）。技能：全取消 = 哪儿都用不了；
 * MCP：不许点空（名单为空会被当成停用——那是「启用」开关的事），点空的那一下不动并给一行提示。
 */
export function AvailabilityBody(props: { view: PluginView; workspaces: readonly Workspace[]; onScope: (scope: PluginScope) => void }) {
  const p = useT().plugins;
  const { view } = props;
  const scope = availabilityScopeOf(view);
  const keepOne = view.origin === "user-mcp";
  const [blocked, setBlocked] = useState(false);
  const pick = (chip: AvailabilityChip): void => {
    const next = nextAvailability(scope, chip, keepOne);
    setBlocked(next === null);
    if (next !== null) props.onScope(next);
  };
  const ids = scope.kind === "workspaces" ? scope.ids : [];
  return (
    <div className="pl-col" style={{ gap: "var(--space-2)" }}>
      <span className="pl-chips" role="group" aria-label={p.availableTitle}>
        <Chip active={scope.kind === "global"} onClick={() => pick({ kind: "global" })}>
          {p.availableGlobal}
        </Chip>
        {props.workspaces.map((workspace) => (
          <Chip key={workspace.id} active={ids.includes(workspace.id)} onClick={() => pick({ kind: "workspace", id: workspace.id })}>
            {workspace.name}
          </Chip>
        ))}
      </span>
      {props.workspaces.length === 0 && <span className="pl-field-hint">{p.availableNoWorkspaces}</span>}
      {/* 生效范围贴着动作常驻：用户改完可能很久才开新会话，toast 早没了 */}
      <span className="pl-field-hint">{blocked ? p.availableKeepOne : scope.kind === "off" && !keepOne ? p.availableNone : p.availableNext}</span>
    </div>
  );
}

// ---------- MCP：状态 / 工具 ----------

function StatusIcon(props: { kind: McpStatus["kind"] }) {
  const { kind } = props;
  const icon = kind === "ready" ? "check" : kind === "failed" ? "triangle-alert" : kind === "disabled" ? "circle-off" : kind === "idle" ? "circle-dashed" : "loader-circle";
  return (
    <Icon
      name={icon}
      size={14}
      strokeWidth={1.8}
      // anim-continuous：窗口失焦时暂停（styles.css）；idle 是静态的虚圈，不转
      className={kind === "connecting" ? "anim-continuous pl-mcp-spin" : undefined}
      style={{ flex: "0 0 auto", color: kind === "failed" ? "var(--color-danger)" : kind === "ready" ? "var(--color-success)" : "var(--color-text-tertiary)" }}
    />
  );
}

/** 一台服务的连接状态一行 + 错误全文（带重试）。你的 MCP 与插件自带的 MCP 共用。 */
export function McpStatusLine(props: {
  status: McpStatus | null;
  instances: McpInstanceInfo[];
  /** 重连进行中：非停用的都显示成连接中（实时状态还没回来，不装作不变） */
  reconnecting: boolean;
  onRetry: (() => void) | null;
}) {
  const t = useT();
  const p = t.plugins;
  if (props.status === null) return <span className="pl-muted">{t.common.loading}</span>;
  const status: McpStatus = props.reconnecting && props.status.kind !== "disabled" ? { kind: "connecting" } : props.status;
  const errors = mcpErrors(status, props.instances);
  const ready = readyWorkspaces(props.instances);
  // 有实例失败就按失败画：哪怕合并状态是就绪，一个实例的失败不许被另一个实例的就绪遮住
  const kind: McpStatus["kind"] = errors.length > 0 && status.kind !== "connecting" ? "failed" : status.kind;
  return (
    <div className="pl-mcp-status">
      <span className="pl-mcp-state" data-kind={kind}>
        <StatusIcon kind={kind} />
        <span>{ready.length > 0 && kind === "ready" ? p.mcpReadyIn(ready.join("、")) : p.mcpState[kind]}</span>
      </span>
      {errors.map((error) => (
        <div key={error.message} className="pl-mcp-error">
          {error.workspaces.length > 0 && <small>{p.mcpErrorIn(error.workspaces.join("、"))}</small>}
          <p>{error.message}</p>
        </div>
      ))}
      {errors.length > 0 && props.onRetry !== null && (
        <span>
          <button type="button" className="pl-btn" disabled={props.reconnecting} onClick={props.onRetry}>
            <Icon name="refresh-cw" size={12} strokeWidth={1.8} className={props.reconnecting ? "anim-continuous pl-mcp-spin" : undefined} />
            {p.mcpRetry}
          </button>
        </span>
      )}
    </div>
  );
}

/** 工具名 chip：默认前几个，其余折进「还有 N 个」，点开展开全部。 */
export function McpToolChips(props: { /** 服务名（运行时前缀 mcp__<它>__ 从工具名上去掉） */ server: string; tools: readonly string[] }) {
  const p = useT().plugins;
  const [expanded, setExpanded] = useState(false);
  const { shown, hidden } = visibleTools(
    props.tools.map((tool) => shortToolName(props.server, tool)),
    TOOL_CHIP_LIMIT,
    expanded,
  );
  return (
    <span className="pl-chips">
      {shown.map((tool) => (
        <span key={tool} className="pl-tag">
          {tool}
        </span>
      ))}
      {hidden.length > 0 && (
        <button type="button" className="pl-tag pl-tag-more" onClick={() => setExpanded(true)}>
          {p.mcpToolsMore(hidden.length)}
        </button>
      )}
    </span>
  );
}

/** 就绪时的工具名；没就绪为空数组。 */
export function toolsOfStatus(status: McpStatus | null): string[] {
  return status !== null && status.kind === "ready" ? status.tools : [];
}

/**
 * 你的 MCP 此刻的状态：没读到 = null（读取中）；读到了但没有这一行（刚加 / 还没连过）= 还没连上；
 * 文件里写着停用的就是已停用——运行时快照可能还留着停用前的那一行（停用后重连的快照里它是「没连」），
 * 以文件事实为准，不让开关关着、状态却说「还没连上」。
 */
export function serverStatusOf(server: McpServerInfo | null, loaded: boolean): McpStatus | null {
  if (server === null) return loaded ? { kind: "idle" } : null;
  return server.disabled ? { kind: "disabled" } : server.status;
}

/** 插件自带的 MCP：状态 + 工具，跟着插件启停（没有自己的开关）。`disabled` = 插件此刻没启用。 */
export function PluginMcpRuntime(props: {
  /** 插件 MCP 的运行时服务名（plugin_<插件>_<服务>） */
  server: string;
  row: { status: McpStatus; instances: McpInstanceInfo[] } | null;
  loaded: boolean;
  disabled: boolean;
  reconnecting: boolean;
  onRetry: () => void;
}) {
  const status: McpStatus | null = props.disabled ? { kind: "disabled" } : props.row !== null ? props.row.status : props.loaded ? { kind: "idle" } : null;
  const tools = toolsOfStatus(status);
  return (
    <div className="pl-mcp-runtime">
      <McpStatusLine status={status} instances={props.disabled ? [] : (props.row?.instances ?? [])} reconnecting={props.reconnecting} onRetry={props.onRetry} />
      {tools.length > 0 && <McpToolChips server={props.server} tools={tools} />}
    </div>
  );
}
