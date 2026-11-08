/**
 * 连接目录的 IPC —— 四层契约的第 2 层。
 *
 * 两个通道：逐卡实测（connectorProbe）与保存 token（connectorSaveToken）。
 * 同一家同时在飞的探测合成一份（卡片一进页就探、窗口聚焦又探，不该并发跑两遍同一条命令）。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { findConnector, type ConnectorSaveResult, type ConnectorStatus } from "../../shared/connectors.ts";
import { probeConnector, type ProbeDeps } from "./probe.ts";
import { saveConnectorToken, type ConnectorMcpStore } from "./save-token.ts";

export function registerConnectorIpc(store: ConnectorMcpStore, reload: () => Promise<void>, makeDeps: () => ProbeDeps): void {
  const inFlight = new Map<string, Promise<ConnectorStatus>>();
  /** 逐卡实测。同一家在飞的合成一份。 */
  const probe = (id: string): Promise<ConnectorStatus> => {
    const entry = findConnector(id);
    if (entry === undefined) return Promise.resolve({ kind: "failed", code: "error", message: "unknown connector" });
    const running = inFlight.get(id);
    if (running !== undefined) return running;
    const next = probeConnector(entry, makeDeps()).finally(() => inFlight.delete(id));
    inFlight.set(id, next);
    return next;
  };
  /** 保存之后的实测必须是新的一次：不能搭在保存前就在飞的那次探测上（它测的是旧配置） */
  const probeFresh = (id: string): Promise<ConnectorStatus> => {
    const entry = findConnector(id);
    return entry === undefined ? Promise.resolve({ kind: "failed", code: "error", message: "unknown connector" }) : probeConnector(entry, makeDeps());
  };

  ipcMain.handle(ipcChannels.connectorProbe, (_e, id: string): Promise<ConnectorStatus> => probe(String(id)));
  ipcMain.handle(
    ipcChannels.connectorSaveToken,
    (_e, id: string, token: string): Promise<ConnectorSaveResult> =>
      saveConnectorToken(String(id), String(token), { store, reload, probe: probeFresh }),
  );
}
