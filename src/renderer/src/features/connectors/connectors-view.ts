/**
 * 连接页签的视图模型：把「目录条目 + 实测状态」算成界面要显示的东西。纯函数，不碰 DOM、不碰 IPC。
 * 状态一律来自主进程实测（shared/connectors.ts 的 ConnectorStatus）；「检测中」是 renderer 自己的瞬时态。
 */
import {
  opensSetupSession,
  type ConnectorEntry,
  type ConnectorId,
  type ConnectorStatus,
  type TokenProblem,
} from "../../../../shared/connectors.ts";
import type { McpOauthLoginResult } from "../../../../shared/mcp-oauth.ts";
import type { Messages } from "../../messages-en.ts";
import type { IconName } from "../../shell/Icon";

export type ProbeState = { kind: "checking" } | ConnectorStatus;

export type Phase = "checking" | "logging-in" | "unset" | "connected" | "failed";

export function phaseOf(state: ProbeState): Phase {
  return state.kind;
}

/** messages.connectors.items 里一条的形状（有的有 tokenHint，各条字面量类型不同，这里统一读法） */
export interface ConnectorText {
  name: string;
  desc: string;
  caps: readonly string[];
  how: string;
  tokenHint?: string;
}

export function textOf(t: Messages["connectors"], id: ConnectorId): ConnectorText {
  return t.items[id] as ConnectorText;
}

/**
 * 按钮的语义。命令行 / 引导 / token 型：configure → reconfigure → manage；
 * OAuth 型：connect（浏览器登录）→ cancel（登录中，放弃）→ disconnect（已连接）/ login（失败后重新登录）。
 */
export type ActionKind = "configure" | "reconfigure" | "manage" | "connect" | "login" | "cancel" | "disconnect";

export interface ActionModel {
  kind: ActionKind;
  disabled: boolean;
  tip: string;
}

/** 卡片 / 行尾的那个按钮。每个阶段都有一个能点的事（OAuth 型登录中的那个是「取消」）。 */
export function actionOf(t: Messages["connectors"], entry: ConnectorEntry, state: ProbeState): ActionModel {
  const token = entry.kind === "mcp-token";
  if (entry.kind === "mcp-oauth") {
    switch (phaseOf(state)) {
      case "checking":
        return { kind: "connect", disabled: true, tip: t.actionTip.checking };
      case "logging-in":
        return { kind: "cancel", disabled: false, tip: t.actionTip.cancelLogin };
      case "connected":
        return { kind: "disconnect", disabled: false, tip: t.actionTip.disconnect };
      case "failed":
        return { kind: "login", disabled: false, tip: t.actionTip.login };
      case "unset":
        return { kind: "connect", disabled: false, tip: t.actionTip.connect };
    }
  }
  switch (phaseOf(state)) {
    case "checking":
    case "logging-in":
      return { kind: "configure", disabled: true, tip: t.actionTip.checking };
    case "connected":
      return { kind: "manage", disabled: false, tip: manageRoute(entry, state) === "installed" ? t.actionTip.manageInstalled : t.actionTip.manageSession };
    case "failed":
      return { kind: "reconfigure", disabled: false, tip: token ? t.actionTip.reconfigureToken : t.actionTip.reconfigure };
    case "unset":
      return { kind: "configure", disabled: false, tip: token ? t.actionTip.configureToken : t.actionTip.configure };
  }
}

/** 点「配置」：开会话（cli / guided）还是卡内贴 token（mcp-token）。OAuth 型不走「配置」（它的按钮是连接 / 登录），返回 null。 */
export function configureRoute(entry: ConnectorEntry): "session" | "token" | null {
  if (opensSetupSession(entry)) return "session";
  return entry.kind === "mcp-token" ? "token" : null;
}

/** 点「管理」：靠远程 MCP 连上的，去「已装」里停用 / 移除；其余开一条会话复核。 */
export function manageRoute(entry: ConnectorEntry, state: ProbeState): "installed" | "session" {
  return state.kind === "connected" && state.by === "mcp" && entry.mcp !== undefined ? "installed" : "session";
}

/** 状态行：图标名 + 文字 + 一句具体说明（可为空）。 */
export function statusLine(t: Messages["connectors"], entry: ConnectorEntry, state: ProbeState): { icon: IconName; text: string; note: string } {
  switch (state.kind) {
    case "checking":
      return { icon: "loader-circle", text: t.status.checking, note: "" };
    case "logging-in":
      return { icon: "loader-circle", text: t.status.loggingIn, note: t.loggingInNote };
    case "connected":
      return {
        icon: "circle-check",
        text: t.status.connected,
        note: state.by === "mcp" ? t.connectedBy.mcp(state.tools ?? 0) : state.by === "cli" ? t.connectedBy.cli : t.connectedBy.local,
      };
    case "failed":
      return { icon: "triangle-alert", text: state.code === "login" ? t.status.login : t.status.failed, note: failedNote(t, entry, state) };
    case "unset": {
      const command = entry.cli?.command ?? "";
      const note =
        state.reason === "cli-missing" ? t.reason.cliMissing(command) : state.reason === "not-logged-in" ? t.reason.notLoggedIn : state.reason === "disabled" ? t.reason.disabled : t.reason.noConfig;
      // OAuth 型没有「配置」这回事，按钮是「连接」，状态也说「未连接」
      return { icon: "circle-dashed", text: entry.kind === "mcp-oauth" ? t.status.notConnected : t.status.unset, note };
    }
  }
}

/**
 * 失败原因的一句话：超时与「服务端回 401 / 403」（贴 token 的卡还有 400）说成本地话（几乎就是 token 无效或过期），
 * 其余原样给第一行。SDK 的错误文案是英文原文（「SSE error: Non-200 status code (401)」），直接摆出来用户看不懂。
 */
function failedNote(t: Messages["connectors"], entry: ConnectorEntry, state: Extract<ConnectorStatus, { kind: "failed" }>): string {
  if (state.code === "timeout") return t.failedTimeout;
  if (state.code === "login") return t.failedLogin;
  // 贴 token 的那两家：服务端对不对的 token 有回 401 / 403 的，也有回 400 的（百度网盘 SSE 实测是 400）
  const rejected = entry.kind === "mcp-token" ? /\b(400|401|403)\b/ : /\b(401|403)\b/;
  if (state.code === "mcp" && rejected.test(state.message)) return t.failedAuth;
  return firstLine(state.message);
}

/** 错误原文只取第一行、限长：卡片上一行放得下，全文在 title 里 */
export function firstLine(message: string): string {
  const line = message.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** 窄档行的小字：已连接 / 失败写具体情形，其余写接入方式。 */
export function rowSubline(t: Messages["connectors"], entry: ConnectorEntry, state: ProbeState): string {
  const line = statusLine(t, entry, state);
  const how = textOf(t, entry.id).how;
  if (state.kind === "connected" || state.kind === "failed" || state.kind === "logging-in") return line.note === "" ? how : line.note;
  if (state.kind === "unset" && line.note !== "") return line.note;
  return how;
}

/** 登录没成时卡上那一句（取消不算失败，不显示）。已知的几种说成本地话，其余原样给原因。 */
export function loginFailureText(t: Messages["connectors"]["oauth"], failure: Exclude<McpOauthLoginResult, { ok: true }>): string | null {
  switch (failure.code) {
    case "cancelled":
      return null;
    case "timeout":
      return t.errorTimeout;
    case "denied":
      return t.errorDenied;
    case "discovery":
      return t.errorDiscovery(firstLine(failure.message));
    case "unsupported":
    case "failed":
      return t.errorFailed(firstLine(failure.message));
  }
}

export function tokenProblemText(t: Messages["connectors"]["token"], problem: TokenProblem | "unsupported" | "write-failed", message: string): string {
  switch (problem) {
    case "empty":
      return t.errorEmpty;
    case "invalid":
      return t.errorInvalid;
    case "too-long":
      return t.errorTooLong;
    case "unsupported":
      return t.errorUnsupported;
    case "write-failed":
      return t.errorWrite(message);
  }
}

/** 页头筛选框：按名字、说明、能力词、接入方式搜（大小写不敏感）。 */
export function filterConnectors(t: Messages["connectors"], entries: readonly ConnectorEntry[], query: string): ConnectorEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...entries];
  return entries.filter((entry) => {
    const text = textOf(t, entry.id);
    return [entry.id, text.name, text.desc, text.how, ...text.caps].some((part) => part.toLowerCase().includes(needle));
  });
}
