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
import type { Messages } from "../../messages-en.ts";
import type { IconName } from "../../shell/Icon";

export type ProbeState = { kind: "checking" } | ConnectorStatus;

export type Phase = "checking" | "unset" | "connected" | "failed" | "soon";

export function phaseOf(state: ProbeState): Phase {
  return state.kind === "coming-soon" ? "soon" : state.kind;
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

export type ActionKind = "configure" | "reconfigure" | "manage";

export interface ActionModel {
  kind: ActionKind;
  disabled: boolean;
  tip: string;
}

/**
 * 卡片 / 行尾的那个按钮。即将支持的**没有按钮**（返回 null）：它没有可点的事，
 * 灰着一个「配置」会让人以为是暂时点不了——其实是做不了。
 */
export function actionOf(t: Messages["connectors"], entry: ConnectorEntry, state: ProbeState): ActionModel | null {
  const token = entry.kind === "mcp-token";
  switch (phaseOf(state)) {
    case "soon":
      return null;
    case "checking":
      return { kind: "configure", disabled: true, tip: t.actionTip.checking };
    case "connected":
      return { kind: "manage", disabled: false, tip: manageRoute(entry, state) === "installed" ? t.actionTip.manageInstalled : t.actionTip.manageSession };
    case "failed":
      return { kind: "reconfigure", disabled: false, tip: token ? t.actionTip.reconfigureToken : t.actionTip.reconfigure };
    case "unset":
      return { kind: "configure", disabled: false, tip: token ? t.actionTip.configureToken : t.actionTip.configure };
  }
}

/** 点「配置」：开会话（cli / guided）还是卡内贴 token（mcp-token）。 */
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
    case "coming-soon":
      return { icon: "clock", text: t.status.soon, note: "" };
    case "connected":
      return {
        icon: "circle-check",
        text: t.status.connected,
        note: state.by === "mcp" ? t.connectedBy.mcp(state.tools ?? 0) : state.by === "cli" ? t.connectedBy.cli : t.connectedBy.local,
      };
    case "failed":
      return { icon: "triangle-alert", text: t.status.failed, note: state.code === "timeout" ? t.failedTimeout : firstLine(state.message) };
    case "unset": {
      const command = entry.cli?.command ?? "";
      const note =
        state.reason === "cli-missing" ? t.reason.cliMissing(command) : state.reason === "not-logged-in" ? t.reason.notLoggedIn : state.reason === "disabled" ? t.reason.disabled : t.reason.noConfig;
      return { icon: "circle-dashed", text: t.status.unset, note };
    }
  }
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
  if (state.kind === "connected" || state.kind === "failed") return line.note === "" ? how : line.note;
  if (state.kind === "unset" && line.note !== "") return line.note;
  return how;
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
