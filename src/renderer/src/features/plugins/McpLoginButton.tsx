/**
 * 「已装」里需要登录的远程 MCP 的「登录」入口。列表行、卡片、详情的状态行共用一个状态来源（McpLoginContext），
 * 登录走的是连接目录的同一套流程（主进程开系统浏览器、本机回调、加密存凭据）。
 * 只有 `origin === "user-mcp"` 的视图、且运行时快照报了「需要登录」的才出现；登录中的那一台按钮换成「取消」。
 */
import { createContext, useContext } from "react";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { parsePluginViewId, type PluginView } from "@shared/plugin";
import type { McpLogin } from "./useMcpLogin.ts";

export interface McpLoginState {
  /** 运行时快照里报「需要登录」的 server 名 */
  needed: ReadonlySet<string>;
  login: McpLogin;
}

export const McpLoginContext = createContext<McpLoginState | null>(null);

/** 一个视图对应的 mcp.json server 名；不是自己配的 MCP 返回 null */
export function mcpServerNameOf(view: Pick<PluginView, "id" | "name" | "origin">): string | null {
  return view.origin === "user-mcp" ? (parsePluginViewId(view.id)?.key ?? view.name) : null;
}

/** 按 server 名的登录钮（详情状态行用）；`needed` 已由调用方判过 */
export function McpLoginAction(props: { serverName: string; label?: string }) {
  const p = useT().plugins;
  const state = useContext(McpLoginContext);
  if (state === null) return null;
  const busy = state.login.busy === props.serverName;
  return (
    <button
      type="button"
      className="pl-btn pl-login"
      title={busy ? p.mcpLoginCancelTip : p.mcpLoginTip(props.label ?? props.serverName)}
      // 卡片整张可点开详情：登录钮的点击不该同时进详情
      onClick={(event) => {
        event.stopPropagation();
        if (busy) state.login.cancel(props.serverName);
        else void state.login.start(props.serverName);
      }}
    >
      <Icon name={busy ? "loader-circle" : "lock"} size={12} strokeWidth={1.8} spin={busy} />
      {busy ? p.mcpLoginCancel : p.mcpLogin}
    </button>
  );
}

/** 列表行 / 卡片上的登录钮：这个视图不需要登录就不渲染 */
export function McpLoginButton(props: { view: Pick<PluginView, "id" | "name" | "origin"> }) {
  const state = useContext(McpLoginContext);
  const name = mcpServerNameOf(props.view);
  if (state === null || name === null) return null;
  if (!state.needed.has(name) && state.login.busy !== name) return null;
  return <McpLoginAction serverName={name} label={props.view.name} />;
}
