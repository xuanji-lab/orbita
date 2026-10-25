/**
 * agent 域的 IPC handler —— 四层契约的第 2 层。
 * 事件是单向广播：主进程收到 agent 进程的消息就原样转给所有窗口，不在中间加工。
 */
import { ipcMain } from "electron";
import { join } from "node:path";
import { mainWindows } from "../window/main-windows.ts";
import {
  ipcChannels,
  type CompactAgentInput,
  type ProviderSecrets,
  type SubmitAgentInput,
} from "../../shared/agent-ipc.ts";
import { parseChannelPrompt } from "../../shared/channel.ts";
import {
  composeInvocationPrompt,
  findInvocationTokens,
  type InvokedMcp,
  type InvokedSkill,
} from "../../shared/invocation.ts";
import { isSkillAvailable, matchSkillTarget } from "../../shared/skill.ts";
import { withoutQuotes } from "../../shared/quote.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";
import type { IntentConfirmDecision } from "../../shared/intent-confirm.ts";
import type { ThinkingLevel } from "../../shared/thinking.ts";
import { endpointHintsOf, knownProviderOf } from "../../shared/known-providers.ts";
import type { CompactionSetting } from "../../shared/settings.ts";
import { COMPACTION_DEFAULT, effectiveLanguage, type Language } from "../../shared/settings.ts";
import type { ChannelStore } from "../channel/store.ts";
import type { ProviderStore } from "../provider/store.ts";
import { oauthRequestAuth } from "../provider/oauth-flows.ts";
import type { SessionStore } from "../session/store.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { McpStore } from "../mcp/store.ts";
import { readMcpConfigFile } from "../mcp/store.ts";
import type { SkillStore } from "../skill/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { getIntentEdges, getIntentHealth } from "./intent-lab-client.ts";
import { intentTurnEnv } from "./intent-env.ts";
import { effectiveIntentSettings, type AppSettings } from "../../shared/settings.ts";
import { INTENT_MODELS_BY_CHANNEL } from "../../shared/intent-lab.ts";
import type { IntentTurnContext } from "../../shared/agent-ipc.ts";
import {
  mergeMcpConfigs,
  resolveServersForWorkspace,
  WORKSPACE_MCP_FILENAME,
  type McpServer,
  type McpWorkspace,
} from "../../shared/mcp.ts";
import type { SentImage } from "../../shared/prompt-images.ts";
import type { SentFileRef } from "../../shared/prompt-attachments.ts";
import type { TurnDirectories } from "../../shared/agent-ipc.ts";
import { resolveTurnDirectories } from "./turn-directories.ts";
import { turnFields } from "./turn-fields.ts";
import { applyModeCascade } from "./mode-cascade.ts";
import { browserDownloadDir } from "../browser/download-dir.ts";
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
  const known = knownProviderOf(dto);
  // OAuth 凭据优先：快到点会自动续期并落盘（非 oauth provider 返回 null）。
  // 续期失败不能静默拿旧 token 硬发一轮——换成一句用户能行动的话
  const credential = await providers.resolveOauthCredential(providerId).catch((cause: unknown) => {
    throw new Error(
      `${known.label} 登录已失效，请到设置 › 模型服务里重新登录（${
        cause instanceof Error ? cause.message : String(cause)
      }）`,
    );
  });
  // 凭据 → 请求鉴权：多数就是令牌本身；Copilot 的令牌里还写着这个账号该打的地址（proxy-ep）
  const oauth = credential === null ? null : await oauthRequestAuth(known.id, credential);
  const apiKey = oauth?.apiKey ?? (await providers.resolveApiKey(providerId));
  if (apiKey === null) {
    throw new Error(`provider "${providerId}" has no API key stored`);
  }
  const headers =
    dto.endpoint.headers === undefined && oauth?.headers === undefined
      ? undefined
      : { ...dto.endpoint.headers, ...oauth?.headers };
  const baseUrl = oauth?.baseUrl ?? dto.endpoint.baseUrl;
  // 明文密钥只在主进程 → agent 进程这一跳出现，永不进 renderer
  return {
    id: dto.id,
    api: dto.endpoint.api,
    baseUrl,
    apiKey,
    ...(headers === undefined ? {} : { headers }),
    /**
     * 声明的模型原样过线。型号白名单（known-models.ts）不在这里叠：它要和 pi 目录比
     * （「目录说了算」的服务商在本家目录命中时不吃白名单），而目录只在 agent 进程里有——
     * 以前在这里把白名单窗口 / 输出当用户覆盖塞进声明，思考档却塞不进去，菜单与会话
     * 对同一个型号说两套话。叠加统一在 agent 侧 model-registration 做。
     */
    models: dto.models.declared,
    // pi 目录里这家叫什么。**模型官方参数按它查**——我们的 id 与目录 id 不是一回事
    // （zhipu-coding ↔ zai-coding-cn），拿自己的 id 查一无所获，1M 会被拍成 128k。
    // 按条目认（knownProviderOf）而不是按 id：第二个 DeepSeek 实例（deepseek-2）同样吃目录参数
    // 多协议网关（OpenCode Go）还带上实例地址所在那一组官方端点：型号各走各的协议时地址从那里取
    ...endpointHintsOf(known, { api: dto.endpoint.api, baseUrl }),
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
  /** 附图原图目录的解析画（`sessions/<id>.attachments/`）：图片字节预算的占位拼路径用 */
  attachmentDirOf: (sessionId: string) => string,
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
  /** 意图存档跟踪器（实验功能 intent-system；undefined = 旧测试夹具不传）。submit /
   *  interrupt 判定要存档时 begin，事件泵在 index.ts 里喂 onEvent */
  intentIngest?: { begin(sessionId: string, text: string, pasted: readonly string[]): void },
): { submitTurn(input: SubmitAgentInput): Promise<void> } {
  /**
   * 某条会话所属的工作区。找不到（工作区被删了）就当作没有工作区：白名单与工作区
   * 变量都按 Home 处理，**不拦开轮**（同「一台坏的 MCP server 不该把会话堵死」）。
   */
  const scopeOf = async (workspaceId: string | null): Promise<McpWorkspace | null> => {
    if (workspaceId === null) return null;
    const found = (await workspaces.list()).find((workspace) => workspace.id === workspaceId);
    return found === undefined ? null : { id: found.id, name: found.name, path: found.path };
  };

  /**
   * 读配置并**解析成这一条会话该看到的那一份**：全局 mcp.json ∪ 工作区自带的
   * `.mcp.json`（同名工作区赢），再按白名单筛、把 `${workspaceFolder}` 换成该工作区
   * 的根。解析放主进程——只有它知道工作区路径（与 `skillDirs` 同一条纪律：
   * agent 进程只收数据）。
   *
   * 读不出来不拦开轮：全局文件坏了记日志、这一轮没有 MCP 工具；工作区文件坏了
   * 记日志、只用全局（管理面会把读错原文显示出来）。一份写坏的配置不该让用户
   * 连对话都开不了（与 D-3 不矛盾：那条纪律是「不把失败伪装成空」且不披露，
   * 这里两者都做到）。
   */
  const readMcpServers = async (workspaceId: string | null): Promise<Record<string, McpServer>> => {
    const configured = await mcp.read().catch((error: unknown) => {
      console.error("[main] mcp.json 读不了，这一轮没有 MCP 工具", error);
      return {};
    });
    const scope = await scopeOf(workspaceId);
    const local =
      scope === null
        ? {}
        : await readMcpConfigFile(join(scope.path, WORKSPACE_MCP_FILENAME)).catch((error: unknown) => {
            console.error(
              `[main] ${scope.name} 的 ${WORKSPACE_MCP_FILENAME} 读不了，这一轮只用全局配置`,
              error,
            );
            return {};
          });
    return resolveServersForWorkspace(mergeMcpConfigs(configured, local), scope);
  };

  /**
   * 这轮开轮的工作区名字（给 store-tools 的 scope 指引讲归属用）：
   * workspaceId 为 null → 不带（不属于任何工作区）；翻不到（旧夹具 /
   * 工作区已删）→ 也不带——提示词里如实说「未知」，不猜。
   */
  const workspaceNameOf = async (workspaceId: string | null): Promise<string | undefined> => {
    if (workspaceId === null) return undefined;
    return (await workspaces.list()).find((workspace) => workspace.id === workspaceId)?.name;
  };

  /** 每轮现读压缩偏好：设置改动下一轮即生效，无需重启会话 */
  const readCompaction = async (): Promise<CompactionSetting> =>
    (await settings.read()).compaction ?? COMPACTION_DEFAULT;

  /**
   * 命令超时的硬上限同款每轮现读（设置改动下一轮即生效）。缺席 = 不带字段，
   * runtime 的 `commandTimeoutPolicy` 落回 3600——**不在这里预先算三档**：
   * 推导是 shared 的一处真源，主进程只负责把用户的原始选择送过去。
   */
  const readCommandTimeoutMax = async (): Promise<number | undefined> =>
    (await settings.read()).commandTimeoutMaxSeconds;

  /** Git 标识同款每轮现读；缺席 = 开启（兼容从没动过这个开关的旧设置文件） */
  const readGitAttribution = async (): Promise<boolean> =>
    (await settings.read()).gitAttribution ?? true;

  /** 实验功能「PDF 引用」的开关同款每轮现读；缺席 = 关（与设置契约同一口径） */
  const readPdfCitations = async (): Promise<boolean> =>
    (await settings.read()).experimentalFeatures?.["pdf-citations"] === true;

  /** 署名语言同样每轮现读：换主题 / 改语言，下一轮的署名就跟上（规则在 shared 的 effectiveLanguage） */
  const readAttributionLanguage = async (): Promise<Language> => {
    const current = await settings.read();
    return effectiveLanguage(current.theme, current.language);
  };

  /**
   * 意图系统的开轮装配（实验功能 intent-system）：每轮现读设置与 meta，开关
   * 关着返回空对象（命令形状与 main 一字不差）。存档跟记也在这一处判。
   */
  const readIntentEnv = async (
    sessionId: string,
    text: string,
  ): Promise<{ intent?: IntentTurnContext; backfill?: string[]; ingest: boolean }> => {
    const current: AppSettings = await settings.read();
    if (current.experimentalFeatures?.["intent-system"] !== true) return { ingest: false };
    const effective = effectiveIntentSettings(current.intent);
    const meta = await sessions.readMeta(sessionId);
    const detail = meta === null ? null : await sessions.load(sessionId);
    return intentTurnEnv({
      experimentOn: true,
      // 会话级覆写优先，没碰过的跟新会话默认
      sessionIntentEnabled: meta?.intentEnabled ?? effective.newSessionOn,
      baseUrl: effective.baseUrl,
      // 按渠道的模型覆盖（一处常量表；proma 渠道不带字段，跟随服务端配置）
      models: INTENT_MODELS_BY_CHANNEL[effective.channel],
      meta: meta === null ? null : { title: meta.title, ...(meta.parentId !== undefined ? { parentId: meta.parentId } : {}) },
      transcript: detail?.transcript ?? null,
      text,
    });
  };

  // 意图系统的两条拉取通道（探活 / 拉图）：地址每轮现读，改了设置立即生效
  ipcMain.handle(ipcChannels.intentHealth, async (): Promise<unknown> => {
    const effective = effectiveIntentSettings((await settings.read()).intent);
    return getIntentHealth(effective.baseUrl);
  });
  ipcMain.handle(
    ipcChannels.intentEdges,
    async (_e, sessionId: string, turnId: string): Promise<unknown> => {
      const effective = effectiveIntentSettings((await settings.read()).intent);
      return getIntentEdges(effective.baseUrl, sessionId, turnId);
    },
  );


  /**
   * 开轮目录清单每轮现读现装配：工作区挂新目录、换工作区，下一轮即生效。
   * 逻辑在 turn-directories.ts（纯模块，可直接测）；这里只做路由。
   */
  // 受管浏览器的下载目录一并告诉 agent（用户在浏览器里下的论文 / 导出文件在那里，agent 帮着整理）
  const readDirectories = async (input: SubmitAgentInput | CompactAgentInput): Promise<TurnDirectories> => ({
    ...(await resolveTurnDirectories(workspaces, sessions, channels, input)),
    browserDownloads: await browserDownloadDir(settings),
  });

  /**
   * 家务活模型（设置里的 choreModel：起名、收尾扫描、迁移的随手一句检查）装配成
   * 带密钥的载荷。没指定、指的 provider 已删、或密钥取不到，一律返回 undefined
   * 让 runtime 退回会话模型——家务是易耗品，不该因为一个删掉的 provider 就停掉；
   * 但原因要落到 dev 终端，否则「我选了模型为什么没生效」无从查起。
   */
  const readChoreModel = async (): Promise<
    { provider: ProviderSecrets; modelId: string } | undefined
  > => {
    const choice = (await settings.read()).choreModel;
    if (choice === undefined) return undefined;
    try {
      return {
        provider: await resolveProviderSecrets(providers, choice.providerId),
        modelId: choice.modelId,
      };
    } catch (error: unknown) {
      console.error(
        `[main] 家务活模型 ${choice.providerId}/${choice.modelId} 装配失败，这件家务退回会话模型`,
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
   * `/skill:<target>` / `/mcp:<server>` → 指令式调用块（任意位置、任意多条）：
   * 在用户原文**前面**拼一段硬措辞指令，点名的 skill 写明 SKILL.md 绝对路径、
   * 要求模型先用 read 工具读了再干活（渐进式披露：索引常驻 system prompt，正文
   * 以 tool result 身份按需进上下文，不内联进 user message）；点名的 MCP server
   * 写明 mcp__<server>__<tool> 工具名。查不到 / 读不出不再拦下整条消息，指令里
   * 如实写明「不要假装加载」。**组装在主进程**：名字与启用状态的真源在 store；
   * transcript 落组装后的全文，重放历史所见即所得（pi 无状态，每轮把历史喂回去，
   * 存原文再改写会打断 provider 的前缀缓存）。
   * target 先按 slug 匹配（面板插入的形态、文件系统安全字符集），再按 frontmatter 名。
   * 通道信封（子会话的投递文本）不组装：首行是 `<channel …>` 头，前面拼块会破
   * parseChannelPrompt 的识别；那不是用户输入，父模型要用 skill 自会在任务说明里
   * 写明路径。
   */
  const prependInvocationDirectives = async (
    text: string,
    workspaceId: string | null,
  ): Promise<string> => {
    if (parseChannelPrompt(text) !== null) return text;
    const tokens = findInvocationTokens(text);
    if (tokens.length === 0) return text;
    const skillTargets = [...new Set(tokens.filter((t) => t.kind === "skill").map((t) => t.target))];
    const mcpTargets = [...new Set(tokens.filter((t) => t.kind === "mcp").map((t) => t.target))];
    // 可用性判定与右栏选取模式共用 isSkillAvailable（选取面认的，发送时必然认）
    const available =
      skillTargets.length > 0
        ? (await skills.list()).filter((meta) => isSkillAvailable(meta, workspaceId))
        : [];
    const invokedSkills: InvokedSkill[] = [];
    for (const target of skillTargets) {
      const meta = matchSkillTarget(available, target);
      if (meta === null) {
        invokedSkills.push({ target, problem: "not-found" });
        continue;
      }
      // 正文不进消息，read 只为探知可读（存储损坏的 skill 与查不到同样如实写明）
      const content = await skills.read(meta.slug);
      if (content === null) {
        invokedSkills.push({ target, problem: "unreadable" });
        continue;
      }
      invokedSkills.push({ target, location: join(skills.storeRoot(), meta.slug, "SKILL.md") });
    }
    const invokedMcps: InvokedMcp[] = [];
    if (mcpTargets.length > 0) {
      // 与这一轮实际装配的 MCP 同一份：全局 ∪ 工作区 .mcp.json——工作区里配的 server 也要认得出
      const servers = await readMcpServers(workspaceId);
      for (const target of mcpTargets) {
        const server = servers[target];
        invokedMcps.push({ target, available: server !== undefined && server.disabled !== true });
      }
    }
    return composeInvocationPrompt(text, invokedSkills, invokedMcps);
  };

  /**
   * 发一轮（`agent:submit` handler 的函数体，抽出来是因为子会话的派出/投递
   * 也要开同一种轮——`applyDelegate` / `deliverToChild`（channel/requests.ts）
   * 拿的就是这个函数，不重新拼一遍 turnFields/readDirectories 那一整套装配）。
   */
  async function submitTurn(input: SubmitAgentInput): Promise<void> {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    const text = await prependInvocationDirectives(input.text, input.workspaceId);
    // 意图系统（实验）：开关开着才装配（intent / backfill）与存档（ingest）。
    // 返回空对象时命令与 main 一字不差
    const intentEnv = await readIntentEnv(input.sessionId, text);
    if (intentEnv.ingest) intentIngest?.begin(input.sessionId, text, input.pasted ?? []);
    const piSessionFile = await host.submit({
      type: "submit",
      text,
      ...(await sentImages(input)),
      ...(await sentFileRefs(input)),
      ...(input.pasted !== undefined && input.pasted.length > 0 ? { pasted: input.pasted } : {}),
      ...(intentEnv.intent !== undefined ? { intent: intentEnv.intent } : {}),
      ...(intentEnv.backfill !== undefined ? { backfill: intentEnv.backfill } : {}),
      ...turnFields(input, provider, piSessionDir, attachmentDirOf(input.sessionId), protectedPaths, {
        skillsDirs: skillDirs(input.workspaceId),
        directories: await readDirectories(input),
        mcpServers: await readMcpServers(input.workspaceId),
        compaction: await readCompaction(),
        commandTimeoutMaxSeconds: await readCommandTimeoutMax(),
        gitAttribution: await readGitAttribution(),
        attributionLanguage: await readAttributionLanguage(),
        workspaceName: await workspaceNameOf(input.workspaceId),
        pdfCitations: await readPdfCitations(),
      }),
    });
    await settleFirstTurn(input, piSessionFile);
    // 遗留清单「继续」开的轮：记下这条会话在接着做哪条遗留事项（收尾确认时自动标做完）。
    // 必须在 settleFirstTurn 之后：新会话的 meta 在那里才建出来
    if (input.carryoverId !== undefined) {
      await sessions.addResumedCarryover(input.sessionId, input.carryoverId).catch((error: unknown) => {
        console.error("[carryover] 记不下接着做的遗留事项（不影响发送）", error);
      });
    }
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
      host.generateTitle(input.sessionId, ownWords, await readChoreModel());
    }
  }

  ipcMain.handle(ipcChannels.agentSubmit, (_e, input: SubmitAgentInput): Promise<void> => submitTurn(input));
  ipcMain.handle(ipcChannels.agentAbort, (_e, sessionId: string) => host.abort(sessionId));
  ipcMain.handle(ipcChannels.agentInterrupt, async (_e, input: SubmitAgentInput): Promise<void> => {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    // interrupt 是排队消息的「立即发送」分支（会话还忙碌时）：与 submit 同一份组装，
    // 否则 /skill: 在这条路径以字面文本喂给模型
    const text = await prependInvocationDirectives(input.text, input.workspaceId);
    const intentEnv = await readIntentEnv(input.sessionId, text);
    if (intentEnv.ingest) intentIngest?.begin(input.sessionId, text, input.pasted ?? []);
    const piSessionFile = await host.interrupt({ type: "interrupt", text, ...(await sentImages(input)), ...(await sentFileRefs(input)), ...(input.pasted !== undefined && input.pasted.length > 0 ? { pasted: input.pasted } : {}), ...(intentEnv.intent !== undefined ? { intent: intentEnv.intent } : {}), ...(intentEnv.backfill !== undefined ? { backfill: intentEnv.backfill } : {}), ...turnFields(input, provider, piSessionDir, attachmentDirOf(input.sessionId), protectedPaths, { skillsDirs: skillDirs(input.workspaceId), directories: await readDirectories(input), mcpServers: await readMcpServers(input.workspaceId), compaction: await readCompaction(), commandTimeoutMaxSeconds: await readCommandTimeoutMax(), gitAttribution: await readGitAttribution(), attributionLanguage: await readAttributionLanguage(), workspaceName: await workspaceNameOf(input.workspaceId), pdfCitations: await readPdfCitations() }) });
    await settleFirstTurn(input, piSessionFile);
  });
  ipcMain.handle(ipcChannels.agentCompact, async (_e, input: CompactAgentInput): Promise<void> => {
    const provider = await resolveProviderSecrets(providers, input.providerId);
    const piSessionFile = await host.compact({ type: "compact", ...(input.instructions !== undefined ? { instructions: input.instructions } : {}), ...turnFields(input, provider, piSessionDir, attachmentDirOf(input.sessionId), protectedPaths, { skillsDirs: skillDirs(input.workspaceId), directories: await readDirectories(input), mcpServers: await readMcpServers(input.workspaceId), compaction: await readCompaction(), commandTimeoutMaxSeconds: await readCommandTimeoutMax(), gitAttribution: await readGitAttribution(), attributionLanguage: await readAttributionLanguage(), workspaceName: await workspaceNameOf(input.workspaceId), pdfCitations: await readPdfCitations() }) });
    if (piSessionFile !== null) await sessions.setPiSessionFile(input.sessionId, piSessionFile);
  });

  ipcMain.handle(
    ipcChannels.agentSetMode,
    async (_e, sessionId: string, mode: PermissionMode) => {
      // 用户切档：自己 + 名下直接子会话一起切（单向：父带子，2026-09-30 用户裁决；
      // 语义与理由见 mode-cascade.ts）。档位也落盘：重开这条会话时不该静默换档，
      // 而这一档决定 bash 能不能跑
      await applyModeCascade(
        {
          listSessions: () => sessions.list(),
          setRuntimeMode: (id, next) => host.setMode(id, next),
          setStoredMode: (id, next) => sessions.setMode(id, next),
        },
        sessionId,
        mode,
      );
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
  ipcMain.handle(
    ipcChannels.agentAnswerIntentConfirm,
    (_e, requestId: string, decision: IntentConfirmDecision) => host.answerIntentConfirm(requestId, decision),
  );

  return { submitTurn };
}

/** agent 进程的事件 → 所有主窗口（沙盒浏览器窗口的工具条不收，见 window/main-windows.ts） */
export function broadcastAgentEvent(event: unknown): void {
  for (const window of mainWindows.list()) {
    window.webContents.send(ipcChannels.agentEvent, event);
  }
}
