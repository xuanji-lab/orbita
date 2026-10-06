/**
 * MCP 的 IPC —— 四层契约的第 2 层。
 *
 * 连接状态住在 agent 进程（连接是它建的），主进程只做**最后一次快照的缓存**：
 * 管理面开合频繁，不该为看一眼状态就去打扰 agent 进程。
 *
 * **配置分层**：列表 = 全局 mcp.json ∪ 各工作区自带的 `.mcp.json`（同名工作区赢）。
 * 写路径（加 / 删 / 启停）只落全局文件——工作区配置在用户的论文目录里，
 * 由用户自己编辑（与「加减 server 走文件」同一条哲学）。
 */
import { ipcMain, shell } from "electron";
import { join } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  describeServer,
  isMcpServerName,
  mergeServerSources,
  WORKSPACE_MCP_FILENAME,
  type McpListResult,
  type McpServer,
  type McpStatus,
  type McpStatusSnapshot,
} from "../../shared/mcp.ts";
import { readMcpConfigFile, type McpStore } from "./store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";

export function registerMcpIpc(
  store: McpStore,
  workspaces: WorkspaceStore,
  /** 让 agent 进程拆掉现有连接重来（host 注入；等 runtime 的 mcp 快照回来才返回） */
  reload: () => Promise<void>,
): {
  onAgentSnapshot: (servers: McpStatusSnapshot) => void;
  /** 缓存快照里一台 server 的状态（写盘回执给模型看连接结果用；没缓存过返回 undefined） */
  statusOf: (name: string) => { kind: "ready" | "failed" | "disabled" | "connecting"; message?: string } | undefined;
} {
  /** agent 进程报上来的最后一次连接状态。null = 还没连过（没建过会话）。 */
  let snapshot: McpStatusSnapshot | null = null;

  /** 上次快照里这台 server 的状态。没快照 / 快照里没这台 → undefined（调用方自己兜）。 */
  const statusOf = (name: string): McpStatus | undefined => {
    const found = snapshot?.find((s) => s.name === name);
    if (found === undefined) return undefined;
    return found.status;
  };

  /**
   * 全局一份 + 各工作区自带的 `.mcp.json` 一起读。**一个工作区的文件读坏不拖死整表**
   * （记一条警告，面板如实显示）；全局文件读坏如实抛（面板显示错误原文）。
   */
  const readAllSources = async (): Promise<{
    global: Record<string, McpServer>;
    workspaceFiles: { workspace: string; servers: Record<string, McpServer> }[];
    warnings: string[];
  }> => {
    const global = await store.read();
    const warnings: string[] = [];
    const workspaceFiles: { workspace: string; servers: Record<string, McpServer> }[] = [];
    for (const workspace of await workspaces.list()) {
      let servers: Record<string, McpServer>;
      try {
        servers = await readMcpConfigFile(join(workspace.path, WORKSPACE_MCP_FILENAME));
      } catch (error) {
        warnings.push(
          `${workspace.name} 的 ${WORKSPACE_MCP_FILENAME} 读不了：${error instanceof Error ? error.message : String(error)}`,
        );
        continue;
      }
      if (Object.keys(servers).length > 0) workspaceFiles.push({ workspace: workspace.name, servers });
    }
    return { global, workspaceFiles, warnings };
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
   */
  ipcMain.handle(ipcChannels.mcpList, async (): Promise<McpListResult> => {
    const { global, workspaceFiles, warnings } = await readAllSources();
    const servers = mergeServerSources(global, workspaceFiles).map((row) => ({
      name: row.name,
      detail: describeServer(row.server),
      disabled: row.server.disabled === true,
      scopedTo: row.server.workspaces ?? [],
      source: row.source,
      status:
        statusOf(row.name) ??
        (row.server.disabled === true ? { kind: "disabled" as const } : { kind: "connecting" as const }),
    }));
    return { servers, warnings };
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

  /**
   * 删 / 启停只落全局文件。这台只来自工作区自带的 `.mcp.json` 时，写全局文件
   * 够不着它——如实报错并指到真正的文件，不静默写一条同名的进全局（那是遮蔽，
   * 不是编辑）。
   */
  const requireGlobalEditable = async (name: string): Promise<void> => {
    const global = await store.read();
    if (name in global) return;
    const { workspaceFiles } = await readAllSources();
    const homes = workspaceFiles
      .filter((file) => name in file.servers)
      .map((file) => file.workspace);
    if (homes.length > 0) {
      throw new Error(
        `"${name}" 来自 ${homes.join("、")} 工作区的 ${WORKSPACE_MCP_FILENAME}，请编辑那个文件`,
      );
    }
    // 哪里都没有：让 store 自己抛 No such server（语义不变）
  };

  ipcMain.handle(
    ipcChannels.mcpAdd,
    async (_e, name: string, server: McpServer): Promise<void> => {
      if (!isMcpServerName(name)) throw new Error(`非法 server 名：${name}`);
      // 全局加一台与工作区配置同名的 server 是合法的：那个工作区里工作区配置赢
      await writeThenReload(() => store.add(name, server));
    },
  );

  ipcMain.handle(ipcChannels.mcpRemove, async (_e, name: string): Promise<void> => {
    await requireGlobalEditable(name);
    await writeThenReload(() => store.remove(name));
  });

  ipcMain.handle(
    ipcChannels.mcpSetDisabled,
    async (_e, name: string, disabled: boolean): Promise<void> => {
      await requireGlobalEditable(name);
      await writeThenReload(() => store.setDisabled(name, disabled));
    },
  );

  return {
    onAgentSnapshot: (servers) => {
      snapshot = servers;
    },
    statusOf,
  };
}
