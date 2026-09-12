/**
 * agent 域的 IPC handler —— 四层契约的第 2 层。
 * 事件是单向广播：主进程收到 agent 进程的消息就原样转给所有窗口，不在中间加工。
 */
import { BrowserWindow, ipcMain } from "electron";
import {
  ipcChannels,
  type CompactAgentInput,
  type ProviderSecrets,
  type SubmitAgentInput,
} from "../../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";
import { KNOWN_PROVIDERS, knownModelParams } from "../../shared/known-providers.ts";
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
    /**
     * 声明的模型 + **我们自己补的参数**（快速适配通道）。用户显式填过的优先，
     * 其次是白名单，再其次由 runtime 走「pi 目录 → 兜底」。
     * 白名单存在的理由：pi 目录只收录它已知的模型，厂商新上线的型号要等 1–2 周。
     */
    models: dto.models.declared.map((decl) => {
      const patch = knownModelParams(dto.id, decl.id);
      return {
        ...decl,
        ...(decl.contextWindow === undefined && patch.contextWindow !== undefined
          ? { contextWindow: patch.contextWindow }
          : {}),
        ...(decl.maxTokens === undefined && patch.maxTokens !== undefined
          ? { maxTokens: patch.maxTokens }
          : {}),
      };
    }),
    // pi 目录里这家叫什么。**模型官方参数按它查**——我们的 id 与目录 id 不是一回事
    // （zhipu-coding ↔ zai-coding-cn），拿自己的 id 查一无所获，1M 会被拍成 128k。
    ...(catalogIdOf(dto.id) === undefined ? {} : { catalogId: catalogIdOf(dto.id) }),
  };
}

/** 这家在 pi 目录里的 id。自建 provider 不在表里 → undefined，由 runtime 落兜底。 */
function catalogIdOf(providerId: string): string | undefined {
  return KNOWN_PROVIDERS.find((item) => item.id === providerId)?.catalogId;
}

/** AgentTurnContext 的 renderer 载荷 → AgentCommand 的公共字段（submit / interrupt / compact 共用）。 */
function turnFields(
  input: SubmitAgentInput | CompactAgentInput,
  provider: ProviderSecrets,
  piSessionDir: string,
) {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    provider,
    modelId: input.modelId,
    mode: input.mode,
    piSessionDir,
    ...(input.resume ? { piSessionFile: input.resume.piSessionFile } : {}),
  };
}

export function registerAgentIpc(
  host: AgentHost,
  providers: ProviderStore,
  sessions: SessionStore,
  /** pi 把自己的 session 文件放在哪。**路径策略在主进程**，agent 进程只收数据 */
  piSessionDir: string,
): void {
  ipcMain.handle(ipcChannels.providerBuiltins, () => host.listBuiltins());

  /**
   * 首轮开机的收尾：拿到 pi 本子真路径后，真新会话建 meta（建成之后才落盘——
   * 开机失败时不在磁盘上留一条永远打不开的会话），旧会话（pi 本子曾经缺席）校准回去。
   *
   * **函数体里不得在 `ensureSession` 之前 await 任何东西。**紧跟 `created` 的第一个
   * progress 事件会把首条用户消息交给 `record`，两者排同一条 meta 写入链：
   * `created` 的处理是微任务、progress 是下一个端口消息（宏任务），只要本函数
   * 同步入链就一定排在它前面；中间多一次 await（原本的 `sessions.load`）就把顺序
   * 让出去了——那正是 2026-09-12「新会话第一句不落盘」的成因。
   */
  function settleFirstTurn(input: SubmitAgentInput, piSessionFile: string | null): Promise<void> {
    if (piSessionFile === null) return Promise.resolve();
    const now = Date.now();
    return sessions.ensureSession({
      id: input.sessionId,
      title: "",
      titleSource: "derived",
      cwd: input.cwd,
      workspaceId: input.workspaceId,
      piSessionFile,
      pinned: false,
      archived: false,
      recentQueries: [],
      // 还没跑过一轮 = 没有账本。第一次 agent_settled 才落真值
      stats: null,
      providerId: input.providerId,
      modelId: input.modelId,
      mode: input.mode,
      createdAt: now,
      updatedAt: now,
    });
  }

  ipcMain.handle(ipcChannels.agentSubmit, async (_e, input: SubmitAgentInput): Promise<void> => {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    const piSessionFile = await host.submit({ type: "submit", text: input.text, ...turnFields(input, provider, piSessionDir) });
    await settleFirstTurn(input, piSessionFile);
    // 标题生成（C-3）：门禁是 meta 的 titleSource 仍是 derived——用户改过名（user）
    // 或已生成过（auto）就不试；失败不改门禁，下一条用户消息自然重试。
    // fire-and-forget：生成在 agent 进程并发跑，这里不等它，成败也不碰发送。
    if (await sessions.needsAutoTitle(input.sessionId)) host.generateTitle(input.sessionId, input.text);
  });
  ipcMain.handle(ipcChannels.agentAbort, (_e, sessionId: string) => host.abort(sessionId));
  ipcMain.handle(ipcChannels.agentInterrupt, async (_e, input: SubmitAgentInput): Promise<void> => {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    const piSessionFile = await host.interrupt({ type: "interrupt", text: input.text, ...turnFields(input, provider, piSessionDir) });
    await settleFirstTurn(input, piSessionFile);
  });
  ipcMain.handle(ipcChannels.agentCompact, async (_e, input: CompactAgentInput): Promise<void> => {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    const piSessionFile = await host.compact({ type: "compact", ...(input.instructions !== undefined ? { instructions: input.instructions } : {}), ...turnFields(input, provider, piSessionDir) });
    if (piSessionFile !== null) await sessions.setPiSessionFile(input.sessionId, piSessionFile);
  });

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
