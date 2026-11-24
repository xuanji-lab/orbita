/**
 * 「已装」里需要登录的远程 MCP：判定（纯函数）。
 * 状态来自 agent 进程的快照（连接时服务端回 401 + 要求 OAuth，或已存的授权失效，见 agent/mcp-auth.ts），
 * 一台 server 在几个工作区里各有实例——任一实例报「需要登录」就给登录入口（登录是对这台 server 的，不分工作区）。
 */
import type { McpInstanceInfo, McpStatus } from "@shared/mcp";

export function statusNeedsLogin(status: McpStatus | null, instances: readonly Pick<McpInstanceInfo, "status">[] = []): boolean {
  const needs = (each: McpStatus | null): boolean => each?.kind === "failed" && each.needsLogin === true;
  return needs(status) || instances.some((instance) => needs(instance.status));
}
