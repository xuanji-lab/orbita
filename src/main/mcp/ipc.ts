/**
 * MCP 的 IPC —— 四层契约的第 2 层。
 *
 * 连接状态住在 agent 进程（连接是它建的），主进程只做**最后一次快照的缓存**：
 * 管理面开合频繁，不该为看一眼状态就去打扰 agent 进程。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { describeServer, isMcpServerName, type McpServer, type McpServerInfo, type McpStatus } from "../../shared/mcp.ts";
import type { McpStore } from "./store.ts";

export function registerMcpIpc(
  store: McpStore,
  /** 让 agent 进程拆掉现有连接重来（host 注入；等 runtime 的 mcp 快照回来才返回） */
  reload: () => Promise<void>,
): {
  onAgentSnapshot: (servers: McpServerInfo[]) => void;
  /** 缓存快照里一台 server 的状态（写盘回执给模型看连接结果用；没缓存过返回 undefined） */
  statusOf: (name: string) => { kind: "ready" | "failed" | "disabled" | "connecting"; message?: string } | undefined;
} {
  /** agent 进程报上来的最后一次连接状态。null = 还没连过（没建过会话）。 */
  let snapshot: McpServerInfo[] | null = null;

  /** 上次快照里这台 server 的状态。没快照 / 快照里没这台 → undefined（调用方自己兜）。 */
  const statusOf = (name: string): McpStatus | undefined => {
    const found = snapshot?.find((s) => s.name === name);
    if (found === undefined) return undefined;
    return found.status;
  };

  /*
   * 列表**每次都从文件读**，状态才用 agent 的快照。
   *
   * 不能拿快照当列表：连接按 (工作区, server) 分片，agent 只见过「打开过的工作区」
   * 里那些 server——拿快照当列表，一台限定在 paper3 的 server 在你在写稿工作区时
   * 就会从面板上消失，用户会以为自己的配置丢了。文件才是「配了什么」的真源。
   *
   * **不在这里连接**——连接是 agent 进程的事，主进程连一遍等于多一份子进程和
   * 第二套生命周期。所以快照缺席时状态如实标成「还没连」（disabled 之外的归 connecting）。
   * 读错如实抛：面板把错误原文显示出来。
   */
  ipcMain.handle(ipcChannels.mcpList, async (): Promise<McpServerInfo[]> => {
    const servers = await store.read();
    return Object.entries(servers)
      .map(([name, server]) => ({
        name,
        detail: describeServer(server),
        scopedTo: server.workspaces ?? [],
        status:
          statusOf(name) ??
          (server.disabled === true ? { kind: "disabled" as const } : { kind: "connecting" as const }),
      }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  });

  /** 加减 server 走编辑文件：命令 / 参数 / 环境变量做成表单不如直接给文件。 */
  ipcMain.handle(ipcChannels.mcpOpenConfig, async (): Promise<void> => {
    await store.ensureFile();
    await shell.openPath(store.path());
  });

  /**
   * 热重载（1-1）：让 agent 进程把现有连接全拆，下一轮开轮按新配置重建。读错如实抛——
   * reload 是显式动作，用户在等结果；这比开轮路径上「读不了就静默空」的要求严。
   * 生效范围：已在跑的轮工具集已定格，下一轮开机拿新集。
   */
  ipcMain.handle(ipcChannels.mcpReload, async (): Promise<void> => {
    await reload();
  });

  /**
   * 加删启停（4-2）：写盘后自动重连，返回前新快照已缓存并广播。重连失败不视为
   * 写盘失败（配置已经在了，连接是另一层的事）——打日志，让列表的刷新如实反映。
   */
  const writeThenReload = async (write: () => Promise<void>): Promise<void> => {
    await write();
    await reload().catch((cause: unknown) => {
      console.error("[main] mcp.json 改了但重连失败（下次开轮会用新配置）", cause);
    });
  };

  ipcMain.handle(
    ipcChannels.mcpAdd,
    async (_e, name: string, server: McpServer): Promise<void> => {
      if (!isMcpServerName(name)) throw new Error(`非法 server 名：${name}`);
      await writeThenReload(() => store.add(name, server));
    },
  );

  ipcMain.handle(ipcChannels.mcpRemove, (_e, name: string): Promise<void> =>
    writeThenReload(() => store.remove(name)),
  );

  ipcMain.handle(
    ipcChannels.mcpSetDisabled,
    (_e, name: string, disabled: boolean): Promise<void> =>
      writeThenReload(() => store.setDisabled(name, disabled)),
  );

  return {
    onAgentSnapshot: (servers) => {
      snapshot = servers;
    },
    statusOf,
  };
}
