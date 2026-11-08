/**
 * 连接目录「保存 token」。单独成文件（不 import electron），好用 `node --test` 直接测。
 */
import {
  connectorServerConfig,
  findConnector,
  normalizeConnectorToken,
  type ConnectorSaveResult,
  type ConnectorStatus,
} from "../../shared/connectors.ts";
import type { McpServer } from "../../shared/mcp.ts";

/** 保存 token 用到的 MCP 配置面（McpStore 的子集，测试注入假的） */
export interface ConnectorMcpStore {
  upsert(name: string, server: McpServer): Promise<void>;
}

/**
 * 保存 token：校验 → 原子写 mcp.json（同名替换、并清掉旧的停用标记）→ 让 agent 进程重连 → 真连一次实测。
 * 重连失败不算保存失败（配置已在，连接是另一层的事）；实测失败如实带回 failed，条目留着，用户可以「重新配置」。
 * **token 不进任何日志与错误文案。**
 */
export async function saveConnectorToken(
  id: string,
  token: string,
  deps: { store: ConnectorMcpStore; reload: () => Promise<void>; probe: (entryId: string) => Promise<ConnectorStatus> },
): Promise<ConnectorSaveResult> {
  const entry = findConnector(id);
  if (entry === undefined) return { ok: false, code: "unsupported", message: "unknown connector" };
  const checked = normalizeConnectorToken(entry, token);
  if (!checked.ok) return { ok: false, code: checked.problem, message: checked.problem };
  const config = connectorServerConfig(entry, checked.token);
  if (config === null || entry.mcp === undefined) return { ok: false, code: "unsupported", message: "this connector has no token entry" };
  try {
    await deps.store.upsert(entry.mcp.serverName, config);
  } catch (cause) {
    return { ok: false, code: "write-failed", message: cause instanceof Error ? cause.message : String(cause) };
  }
  await deps.reload().catch((cause: unknown) => {
    console.error("[main] 连接目录：mcp.json 已写入，重连失败（下次开轮会用新配置）", cause instanceof Error ? cause.message : "");
  });
  return { ok: true, status: await deps.probe(id) };
}
