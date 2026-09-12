/**
 * MCP 的 IPC —— 四层契约的第 2 层。
 *
 * 连接状态住在 agent 进程（连接是它建的），主进程只做**最后一次快照的缓存**：
 * 管理面开合频繁，不该为看一眼状态就去打扰 agent 进程。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { describeServer, type McpServer, type McpServerInfo } from "../../shared/mcp.ts";
import type { McpStore } from "./store.ts";

export function registerMcpIpc(
  store: McpStore,
  /** 把新配置交给 agent 进程重连（host 注入；等 runtime 的 mcp 快照回来才返回） */
  reload: (servers: Record<string, McpServer>) => Promise<void>,
): { onAgentSnapshot: (servers: McpServerInfo[]) => void } {
  /** agent 进程报上来的最后一次连接状态。null = 还没连过（没建过会话）。 */
  let snapshot: McpServerInfo[] | null = null;

  ipcMain.handle(ipcChannels.mcpList, async (): Promise<McpServerInfo[]> => {
    if (snapshot !== null) return snapshot;
    /*
     * 还没建过会话时也要能看到配了什么。**不在这里连接**——连接是 agent 进程的事，
     * 主进程连一遍等于多一份子进程和第二套生命周期。所以这里只列配置，
     * 状态如实标成「还没连」（disabled 之外的都归到 connecting）。
     */
    const servers = await store.read();
    return Object.entries(servers)
      .map(([name, server]) => ({
        name,
        detail: describeServer(server),
        status:
          server.disabled === true
            ? ({ kind: "disabled" } as const)
            : ({ kind: "connecting" } as const),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  });

  /** 加减 server 走编辑文件：命令 / 参数 / 环境变量做成表单不如直接给文件。 */
  ipcMain.handle(ipcChannels.mcpOpenConfig, async (): Promise<void> => {
    await store.ensureFile();
    await shell.openPath(store.path());
  });

  /**
   * 热重载（1-1）：重读 mcp.json，让 agent 进程按新配置重连。读错如实抛——
   * reload 是显式动作，用户在等结果；这比开轮路径上「读不了就静默空」的要求严。
   * 生效范围：已在跑的轮工具集已定格，下一轮开机拿新集。
   */
  ipcMain.handle(ipcChannels.mcpReload, async (): Promise<void> => {
    await reload(await store.read());
  });

  return {
    onAgentSnapshot: (servers) => {
      snapshot = servers;
    },
  };
}
