/**
 * agent 域的 IPC handler —— 四层契约的第 2 层。
 * 事件是单向广播：主进程收到 agent 进程的消息就原样转给所有窗口，不在中间加工。
 */
import { BrowserWindow, ipcMain } from "electron";
import { join } from "node:path";
import {
  ipcChannels,
  type CompactAgentInput,
  type ProviderSecrets,
  type SubmitAgentInput,
} from "../../shared/agent-ipc.ts";
import { parseChannelPrompt } from "../../shared/channel.ts";
import {
  formatSkillBlock,
  matchSkillTarget,
  parseSkillInvocation,
  SKILL_NOT_FOUND_CODE,
  SKILL_UNREADABLE_CODE,
} from "../../shared/skill.ts";
import { withoutQuotes } from "../../shared/quote.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { KNOWN_PROVIDERS, knownModelParams } from "../../shared/known-providers.ts";
import type { CompactionSetting } from "../../shared/settings.ts";
import { COMPACTION_DEFAULT, effectiveLanguage, type Language } from "../../shared/settings.ts";
import type { ChannelStore } from "../channel/store.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SessionStore } from "../session/store.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { McpStore } from "../mcp/store.ts";
import type { SkillStore } from "../skill/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import type { McpServer } from "../../shared/mcp.ts";
import type { SentImage } from "../../shared/prompt-images.ts";
import type { SentFileRef } from "../../shared/prompt-attachments.ts";
import type { TurnDirectories } from "../../shared/agent-ipc.ts";
import { resolveTurnDirectories } from "./turn-directories.ts";
import { AgentHost } from "./host.ts";

/**
 * 按 id 取 provider 并装配成给 agent 进程的完整载荷（含明文 key）。
 * create 与 setModel 共用——「能不能用某个 provider」两条路必须同一套校验与报错。
 */
export async function resolveProviderSecrets(
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
      const patch = knownModelParams(decl.id);
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
  /** 工具禁区（sessions/ 与 pi-sessions/）：主进程定，随每轮发给闸门 */
  protectedPaths: string[],
  /** 开轮环境（skill 集合目录 + MCP 配置 + 压缩偏好 + Git 标识 + 目录清单）：无状态化后每轮命令都要带全 */
  environment: {
    skillsDirs: string[];
    directories: TurnDirectories;
    mcpServers: Record<string, McpServer>;
    compaction: CompactionSetting;
    gitAttribution: boolean;
    attributionLanguage: Language;
  },
) {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    provider,
    modelId: input.modelId,
    mode: input.mode,
    thinkingLevel: input.thinkingLevel,
    piSessionDir,
    protectedPaths,
    ...environment,
    ...(input.resume ? { piSessionFile: input.resume.piSessionFile } : {}),
  };
}

export function registerAgentIpc(
  host: AgentHost,
  providers: ProviderStore,
  sessions: SessionStore,
  /** 工作区存储：开轮目录清单的 attached 从这里查（turn-directories.ts） */
  workspaces: WorkspaceStore,
  /** 通道账本：开轮目录清单的 related 从这里查子会话列表（turn-directories.ts） */
  channels: ChannelStore,
  /** pi 把自己的 session 文件放在哪。**路径策略在主进程**，agent 进程只收数据 */
  piSessionDir: string,
  /** 工具禁区（sessions/ 与 pi-sessions/）。**路径策略在主进程**，随每轮发给闸门 */
  protectedPaths: string[],
  /** 某条会话该拿哪些 skill 集合目录（global 恒在 + 它的工作区）；路径策略在主进程 */
  skillDirs: (workspaceId: string | null) => string[],
  /** skill 中心存储：`/skill:` 展开在这里查名与读正文（真源在 store，别人不再认一遍） */
  skills: SkillStore,
  /** MCP 配置。**主进程读文件**，agent 进程只收解析好的结果（同 skillDirs 的纪律） */
  mcp: McpStore,
  /** 应用设置。压缩偏好（A-1）从这里装配进每轮开轮命令 */
  settings: SettingsStore,
): { submitTurn(input: SubmitAgentInput): Promise<void> } {
  /**
   * 读一份 mcp.json。读不出来不拦开轮：失败当场打日志、管理面会把读错原文显示出来；
   * 一份写坏的 mcp.json 不该让用户连对话都开不了（与 D-3 不矛盾：那条纪律是
   * 「不把失败伪装成空」且不披露，这里两者都做到）。
   */
  const readMcpServers = (): Promise<Record<string, McpServer>> =>
    mcp.read().catch((error: unknown) => {
      console.error("[main] mcp.json 读不了，这一轮没有 MCP 工具", error);
      return {};
    });

  /** 每轮现读压缩偏好：设置改动下一轮即生效，无需重启会话 */
  const readCompaction = async (): Promise<CompactionSetting> =>
    (await settings.read()).compaction ?? COMPACTION_DEFAULT;

  /** Git 标识同款每轮现读；缺席 = 开启（兼容从没动过这个开关的旧设置文件） */
  const readGitAttribution = async (): Promise<boolean> =>
    (await settings.read()).gitAttribution ?? true;

  /** 署名语言同样每轮现读：换主题 / 改语言，下一轮的署名就跟上（规则在 shared 的 effectiveLanguage） */
  const readAttributionLanguage = async (): Promise<Language> => {
    const current = await settings.read();
    return effectiveLanguage(current.theme, current.language);
  };


  /**
   * 开轮目录清单每轮现读现装配：工作区挂新目录、换工作区，下一轮即生效。
   * 逻辑在 turn-directories.ts（纯模块，可直接测）；这里只做路由。
   */
  const readDirectories = (input: SubmitAgentInput | CompactAgentInput): Promise<TurnDirectories> =>
    resolveTurnDirectories(workspaces, sessions, channels, input);

  /**
   * 命名专用模型（设置里的 titleModel）装配成带密钥的载荷。没指定、指的
   * provider 已删、或密钥取不到，一律返回 undefined 让 runtime 退回会话模型——
   * 标题是易耗品，不该因为一个删掉的 provider 就停掉；但原因要落到 dev 终端，
   * 否则「我选了模型为什么没生效」无从查起。
   */
  const readTitleModel = async (): Promise<
    { provider: ProviderSecrets; modelId: string } | undefined
  > => {
    const choice = (await settings.read()).titleModel;
    if (choice === undefined) return undefined;
    try {
      return {
        provider: await resolveProviderSecrets(providers, choice.providerId),
        modelId: choice.modelId,
      };
    } catch (error: unknown) {
      console.error(
        `[main] 标题模型 ${choice.providerId}/${choice.modelId} 装配失败，这条退回会话模型`,
        error,
      );
      return undefined;
    }
  };

  /**
   * 附图装配：原图先落进会话目录（看大图用），带着引用发给 agent 进程（它缩放后发模型）。
   * 没图就不带字段——纯文字消息的命令与以前一字不差。
   */
  const sentImages = async (input: SubmitAgentInput): Promise<{ images?: SentImage[] }> =>
    input.images !== undefined && input.images.length > 0
      ? { images: await sessions.saveOriginals(input.sessionId, input.images) }
      : {};

  /**
   * 文件引用装配（sentImages 的文件版）：external 的复制进会话目录、路径改指副本，
   * 全部 realpath 成规范形后交给 agent 进程。没文件就不带字段。
   */
  const sentFileRefs = async (input: SubmitAgentInput): Promise<{ files?: SentFileRef[] }> =>
    input.files !== undefined && input.files.length > 0
      ? { files: await sessions.saveExternalFiles(input.sessionId, input.files) }
      : {};

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
      thinkingLevel: input.thinkingLevel,
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * 发一轮（`agent:submit` handler 的函数体，抽出来是因为子会话的派出/投递
   * 也要开同一种轮——`applyDelegate` / `deliverToChild`（channel/requests.ts）
   * 拿的就是这个函数，不重新拼一遍 turnFields/readDirectories 那一整套装配）。
   */
  /**
   * `/skill:<target> 附加指示` → `<skill>` 块用户消息。**展开在主进程**：
   * name→正文的真源在 skill store，agent 进程与 renderer 都不必再认一遍 skill；
   * transcript 落的是展开后原文，重放历史所见即所得。找不到或读不出就抛错——
   * 发送失败如实上屏，而不是把 `/skill:xxx` 原文喂给模型让它角色扮演。
   * target 先按 slug 匹配（面板插入的形态、文件系统安全字符集），再按 frontmatter 名。
   */
  const expandSkillInvocation = async (text: string, workspaceId: string | null): Promise<string> => {
    const parsed = parseSkillInvocation(text);
    if (parsed === null) return text;
    const available = (await skills.list()).filter(
      (meta) =>
        !meta.missing && (meta.global || (workspaceId !== null && meta.workspaces.includes(workspaceId))),
    );
    const meta = matchSkillTarget(available, parsed.target);
    if (meta === null) throw new Error(`${SKILL_NOT_FOUND_CODE}${parsed.target}`);
    const content = await skills.read(meta.slug);
    if (content === null) throw new Error(`${SKILL_UNREADABLE_CODE}${parsed.target}`);
    return formatSkillBlock({
      name: content.name,
      location: join(skills.storeRoot(), meta.slug, "SKILL.md"),
      body: content.body,
      instructions: parsed.rest,
    });
  };

  async function submitTurn(input: SubmitAgentInput): Promise<void> {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    const text = await expandSkillInvocation(input.text, input.workspaceId);
    const piSessionFile = await host.submit({
      type: "submit",
      text,
      ...(await sentImages(input)),
      ...(await sentFileRefs(input)),
      ...(input.pasted !== undefined && input.pasted.length > 0 ? { pasted: input.pasted } : {}),
      ...turnFields(input, provider, piSessionDir, protectedPaths, {
        skillsDirs: skillDirs(input.workspaceId),
        directories: await readDirectories(input),
        mcpServers: await readMcpServers(),
        compaction: await readCompaction(),
        gitAttribution: await readGitAttribution(),
        attributionLanguage: await readAttributionLanguage(),
      }),
    });
    await settleFirstTurn(input, piSessionFile);
    // 标题生成（C-3）：门禁是 meta 的 titleSource 仍是 derived——用户改过名（user）
    // 或已生成过（auto）就不试；失败不改门禁，下一条用户消息自然重试。
    // fire-and-forget：生成在 agent 进程并发跑，这里不等它，成败也不碰发送。
    // 子会话（2026-09-23）：input.text 是投递信封时不生成标题——信封不是用户说的话，
    // 拿它起标题会把 `<channel from="parent" …>` 这类机器文本喂给标题模型。
    // 只发图、没有字的消息同样不生成——标题模型拿不到图，对着空串只会编；门禁不动，下一条带字的消息再试。
    // 引用块剥掉再判：标题要概括的是用户这句话，不是被引用的那段（只发引用同理不生成）。
    const ownWords = withoutQuotes(input.text);
    if (
      ownWords.trim() !== "" &&
      parseChannelPrompt(input.text) === null &&
      (await sessions.needsAutoTitle(input.sessionId))
    ) {
      host.generateTitle(input.sessionId, ownWords, await readTitleModel());
    }
  }

  ipcMain.handle(ipcChannels.agentSubmit, (_e, input: SubmitAgentInput): Promise<void> => submitTurn(input));
  ipcMain.handle(ipcChannels.agentAbort, (_e, sessionId: string) => host.abort(sessionId));
  ipcMain.handle(ipcChannels.agentInterrupt, async (_e, input: SubmitAgentInput): Promise<void> => {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    // interrupt 是排队消息的「立即发送」分支（会话还忙碌时）：与 submit 同一份展开，
    // 否则 /skill: 在这条路径以字面文本喂给模型
    const text = await expandSkillInvocation(input.text, input.workspaceId);
    const piSessionFile = await host.interrupt({ type: "interrupt", text, ...(await sentImages(input)), ...(await sentFileRefs(input)), ...(input.pasted !== undefined && input.pasted.length > 0 ? { pasted: input.pasted } : {}), ...turnFields(input, provider, piSessionDir, protectedPaths, { skillsDirs: skillDirs(input.workspaceId), directories: await readDirectories(input), mcpServers: await readMcpServers(), compaction: await readCompaction(), gitAttribution: await readGitAttribution(), attributionLanguage: await readAttributionLanguage() }) });
    await settleFirstTurn(input, piSessionFile);
  });
  ipcMain.handle(ipcChannels.agentCompact, async (_e, input: CompactAgentInput): Promise<void> => {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    const piSessionFile = await host.compact({ type: "compact", ...(input.instructions !== undefined ? { instructions: input.instructions } : {}), ...turnFields(input, provider, piSessionDir, protectedPaths, { skillsDirs: skillDirs(input.workspaceId), directories: await readDirectories(input), mcpServers: await readMcpServers(), compaction: await readCompaction(), gitAttribution: await readGitAttribution(), attributionLanguage: await readAttributionLanguage() }) });
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
    ipcChannels.agentSetThinkingLevel,
    async (_e, sessionId: string, level: ThinkingLevel) => {
      // 只落 meta，不经 agent 进程：无状态 runtime 每轮从 meta 装配开轮载荷，
      // 改档即改下一轮。clamp 后的真值由开轮的 thinking 事件回来说
      await sessions.setThinkingLevel(sessionId, level);
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

  return { submitTurn };
}

/** agent 进程的事件 → 所有窗口 */
export function broadcastAgentEvent(event: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(ipcChannels.agentEvent, event);
  }
}
