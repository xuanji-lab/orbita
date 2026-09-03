/**
 * agent 域的 IPC handler —— 四层契约的第 2 层。
 * 事件是单向广播：主进程收到 agent 进程的消息就原样转给所有窗口，不在中间加工。
 */
import { BrowserWindow, ipcMain } from "electron";
import {
  ipcChannels,
  type CreateAgentInput,
  type ProviderSecrets,
} from "../../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SessionStore } from "../session/store.ts";
import { AgentHost } from "./host.ts";

/**
 * 按 id 取 provider 并装配成给 agent 进程的完整载荷（含明文 key）。
 * create 与 setModel 共用——「能不能用某个 provider」两条路必须同一套校验与报错。
 */
async function resolveProviderSecrets(
  providers: ProviderStore,
  providerId: string,
): Promise<ProviderSecrets> {
  const dto = (await providers.list()).find((p) => p.id === providerId);
  if (!dto) throw new Error(`unknown provider "${providerId}"`);
  const apiKey = await providers.resolveApiKey(providerId);
  if (apiKey === null) {
    throw new Error(`provider "${providerId}" has no API key stored`);
  }
  // 明文密钥只在主进程 → agent 进程这一跳出现，永不进 renderer
  return {
    id: dto.id,
    api: dto.endpoint.api,
    baseUrl: dto.endpoint.baseUrl,
    apiKey,
    ...(dto.endpoint.headers ? { headers: dto.endpoint.headers } : {}),
    models: dto.models.declared,
  };
}

export function registerAgentIpc(
  host: AgentHost,
  providers: ProviderStore,
  sessions: SessionStore,
  /** pi 把自己的 session 文件放在哪。**路径策略在主进程**，agent 进程只收数据 */
  piSessionDir: string,
): void {
  ipcMain.handle(
    ipcChannels.agentCreate,
    async (_event, input: CreateAgentInput): Promise<string> => {
      const provider = await resolveProviderSecrets(providers, input.providerId);
      const { sessionId, piSessionFile } = await host.createSession(
        {
          cwd: input.cwd,
          modelId: input.modelId,
          mode: input.mode,
          piSessionDir,
          // 续会话：把 pi 自己那份本子还给它（guideline §四）
          ...(input.resume ? { piSessionFile: input.resume.piSessionFile } : {}),
          provider,
        },
        input.resume?.sessionId,
      );

      if (input.resume) {
        // 续会话不新建记录：新消息接着写进同一份 jsonl。
        // 但 pi 那本子的路径可能变了（open 失败退回新建时就会），所以要更新回去。
        await sessions.setPiSessionFile(sessionId, piSessionFile);
      } else {
        // **建成之后才落 meta**：createSession 会等 runtime 回 created，
        // 失败时抛错——不该在磁盘上留下一条永远打不开的会话。标题等第一条用户消息填。
        const now = Date.now();
        await sessions.create({
          id: sessionId,
          title: "",
          titleSource: "derived",
          cwd: input.cwd,
          workspaceId: input.workspaceId,
          piSessionFile,
          pinned: false,
          archived: false,
          recentQueries: [],
          providerId: input.providerId,
          modelId: input.modelId,
          mode: input.mode,
          createdAt: now,
          updatedAt: now,
        });
      }
      return sessionId;
    },
  );

  ipcMain.handle(ipcChannels.providerBuiltins, () => host.listBuiltins());

  ipcMain.handle(ipcChannels.agentSubmit, async (_e, sessionId: string, text: string) => {
    await host.submit(sessionId, text);
    // 标题生成（C-3）：门禁是 meta 的 titleSource 仍是 derived——用户改过名（user）
    // 或已生成过（auto）就不试；失败不改门禁，下一条用户消息自然重试。
    // fire-and-forget：生成在 agent 进程并发跑，这里不等它，成败也不碰发送。
    if (await sessions.needsAutoTitle(sessionId)) host.generateTitle(sessionId, text);
  });
  ipcMain.handle(ipcChannels.agentAbort, (_e, sessionId: string) => host.abort(sessionId));
  ipcMain.handle(
    ipcChannels.agentQueueEdit,
    (
      _e,
      sessionId: string,
      op: "promote" | "cancel" | "edit",
      index: number,
      text: string,
      newText?: string,
    ) => host.queueEdit(sessionId, op, index, text, newText),
  );
  ipcMain.handle(
    ipcChannels.agentCompact,
    (_e, sessionId: string, instructions?: string) => host.compact(sessionId, instructions),
  );

  ipcMain.handle(
    ipcChannels.agentSetMode,
    async (_e, sessionId: string, mode: PermissionMode) => {
      await host.setMode(sessionId, mode);
      // 档位也落盘：重开这条会话时不该静默换档，而这一档决定 bash 能不能跑
      await sessions.setMode(sessionId, mode);
    },
  );

  ipcMain.handle(
    ipcChannels.agentSetModel,
    async (_e, sessionId: string, providerId: string, modelId: string) => {
      // provider 在这里装配（含 key）再传给 runtime——renderer 永远不碰密钥。
      // meta 不在此落：成功与否由 runtime 的 model / failed 事件定，recorder 统一落盘。
      const provider = await resolveProviderSecrets(providers, providerId);
      await host.setModel(sessionId, provider, modelId);
    },
  );

  // 用户对工具审批的回答，原样送回 agent 进程（按 requestId 对号）
  ipcMain.handle(
    ipcChannels.agentAnswerPermission,
    (_e, requestId: string, answer: PermissionAnswer) => host.answerPermission(requestId, answer),
  );
}

/** agent 进程的事件 → 所有窗口 */
export function broadcastAgentEvent(event: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(ipcChannels.agentEvent, event);
  }
}
