/**
 * 开轮装配（B-2 从 ipc.ts 抽出）：「给 sessionId 装 OpenInput 并 submit」。
 *
 * 无状态 runtime 下「谁发起一轮」与「这一轮怎么跑」已经解耦——本模块就是发起侧：
 * renderer 的 submit / interrupt / compact 与 agent 工具 start_task（B-2 派发）
 * 走同一个装配函数，密钥解析、继承规则、meta 校准只有一套真相。
 *
 * start_task 的继承规则（grill 2026-09-19）：cwd / workspace / provider / model /
 * skillsDirs / mcpServers 全继承父，mode 没有覆盖入口（恒继承，「不高于父」因此
 * 天然成立）；唯一可覆盖的是 model（便宜模型干杂活）。深度恒为 1：子会话拿不到
 * 工具（canDispatch），这里再兜一道同因的门——两处防的是同一个事故。
 */
import { randomUUID } from "node:crypto";
import {
  type AgentEvent,
  type CompactAgentInput,
  type ProviderSecrets,
  type StartTaskOutcome,
  type SubmitAgentInput,
} from "../../shared/agent-ipc.ts";
import { KNOWN_PROVIDERS, knownModelParams } from "../../shared/known-providers.ts";
import type { McpServer } from "../../shared/mcp.ts";
import type { CompactionSetting } from "../../shared/settings.ts";
import { COMPACTION_DEFAULT } from "../../shared/settings.ts";
import type { SessionMeta } from "../../shared/session.ts";
import { deriveSessionTitle } from "../../shared/session.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SessionStore } from "../session/store.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { McpStore } from "../mcp/store.ts";
import type { AgentHostCore } from "./host-core.ts";

/** 同一父会话**在跑**的子 task 上限。常量保险不是预算——账本化的 dispatchBudget 是 B-9。 */
export const MAX_RUNNING_CHILDREN = 3;

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
export function turnFields(
  input: SubmitAgentInput | CompactAgentInput,
  provider: ProviderSecrets,
  piSessionDir: string,
  /** 工具禁区（sessions/ 与 pi-sessions/）：主进程定，随每轮发给闸门 */
  protectedPaths: string[],
  /** 开轮环境（skill 集合目录 + MCP 配置 + 压缩偏好）：无状态化后每轮命令都要带全 */
  environment: {
    skillsDirs: string[];
    mcpServers: Record<string, McpServer>;
    compaction: CompactionSetting;
  },
  /** B-2：这条会话能不能派子 task（每轮按 meta 现算，子会话恒 false） */
  canDispatch: boolean,
) {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    provider,
    modelId: input.modelId,
    mode: input.mode,
    piSessionDir,
    protectedPaths,
    ...environment,
    canDispatch,
    ...(input.resume ? { piSessionFile: input.resume.piSessionFile } : {}),
  };
}

export interface TurnAssemblerDeps {
  host: Pick<AgentHostCore, "submit" | "interrupt" | "compact" | "generateTitle">;
  providers: ProviderStore;
  sessions: SessionStore;
  /** pi 把自己的 session 文件放在哪。**路径策略在主进程**，agent 进程只收数据 */
  piSessionDir: string;
  /** 工具禁区（sessions/ 与 pi-sessions/）。**路径策略在主进程**，随每轮发给闸门 */
  protectedPaths: string[];
  /** 某条会话该拿哪些 skill 集合目录（global 恒在 + 它的工作区）；路径策略在主进程 */
  skillDirs: (workspaceId: string | null) => string[];
  /** MCP 配置。**主进程读文件**，agent 进程只收解析好的结果 */
  mcp: McpStore;
  /** 应用设置。压缩偏好（A-1）从这里装配进每轮开轮命令 */
  settings: SettingsStore;
}

export function createTurnAssembler(deps: TurnAssemblerDeps) {  const { host, providers, sessions, piSessionDir, protectedPaths, skillDirs, mcp, settings } = deps;

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

  /**
   * 会话在跑的真值（phase 事件驱动，observe 灌入）：start_task 并发上限的计数来源。
   * 主进程重启即清零——runtime 是它的子进程，同生死，两边对「谁在跑」永远一致。
   */
  const running = new Map<string, boolean>();

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
      parentSessionId: null,
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

  /** 这条会话能不能派子 task：顶层（或还没落盘的首轮）可以，派出来的不行。 */
  async function canDispatch(sessionId: string): Promise<boolean> {
    const meta = await sessions.getMeta(sessionId);
    return meta === null || meta.parentSessionId === null;
  }

  return {
    /** renderer / start_task 共用的开轮入口。首轮等 `created` 建 meta，续轮发完即回。 */
    async submit(input: SubmitAgentInput): Promise<void> {
      const provider = await resolveProviderSecrets(providers, input.providerId);
      const piSessionFile = await host.submit({
        type: "submit",
        text: input.text,
        ...turnFields(
          input,
          provider,
          piSessionDir,
          protectedPaths,
          {
            skillsDirs: skillDirs(input.workspaceId),
            mcpServers: await readMcpServers(),
            compaction: await readCompaction(),
          },
          await canDispatch(input.sessionId),
        ),
      });
      await settleFirstTurn(input, piSessionFile);
      // 标题生成（C-3）：门禁是 meta 的 titleSource 仍是 derived——用户改过名（user）
      // 或已生成过（auto）就不试；失败不改门禁，下一条用户消息自然重试。
      // fire-and-forget：生成在 agent 进程并发跑，这里不等它，成败也不碰发送。
      if (await sessions.needsAutoTitle(input.sessionId)) host.generateTitle(input.sessionId, input.text);
    },

    /** 停下当前这一轮（含工具调用），把这句话作为新一轮发出去 */
    async interrupt(input: SubmitAgentInput): Promise<void> {
      const provider = await resolveProviderSecrets(providers, input.providerId);
      const piSessionFile = await host.interrupt({
        type: "interrupt",
        text: input.text,
        ...turnFields(
          input,
          provider,
          piSessionDir,
          protectedPaths,
          {
            skillsDirs: skillDirs(input.workspaceId),
            mcpServers: await readMcpServers(),
            compaction: await readCompaction(),
          },
          await canDispatch(input.sessionId),
        ),
      });
      await settleFirstTurn(input, piSessionFile);
    },

    /** 手动压缩。忙碌态与界碑走 compaction 事件链 */
    async compact(input: CompactAgentInput): Promise<void> {
      const provider = await resolveProviderSecrets(providers, input.providerId);
      const piSessionFile = await host.compact({
        type: "compact",
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
        ...turnFields(
          input,
          provider,
          piSessionDir,
          protectedPaths,
          {
            skillsDirs: skillDirs(input.workspaceId),
            mcpServers: await readMcpServers(),
            compaction: await readCompaction(),
          },
          await canDispatch(input.sessionId),
        ),
      });
      if (piSessionFile !== null) await sessions.setPiSessionFile(input.sessionId, piSessionFile);
    },

    /**
     * B-2：start_task 的落点。继承解析 → 两道门 → 先落 meta 再代开一轮（写入链
     * 纪律：meta 必须先于子会话的第一个 progress 事件在链上，否则首句被存在性
     * 守卫丢掉——2026-09-12 同一条沟）。**发完即回**：子跑成什么样不随本回执，
     * 结果回传是 B-3（wait_task）的事。
     */
    async startTask(event: {
      sessionId: string;
      title: string;
      prompt: string;
      model?: string;
    }): Promise<StartTaskOutcome> {
      const fail = (error: string): StartTaskOutcome => ({ ok: false, error });
      try {
        const parent = await sessions.getMeta(event.sessionId);
        if (parent === null) return fail(`task "${event.sessionId}" is not on disk (yet); retry in a moment`);
        // 工具不发给子会话是第一道门；这里是同因兜底（契约注释与 commit 讲过分工）
        if (parent.parentSessionId !== null) return fail("child tasks cannot start further tasks (depth limit is 1)");
        const all = await sessions.list();
        const runningChildren = all.filter(
          (meta) => meta.parentSessionId === parent.id && running.get(meta.id) === true,
        ).length;
        if (runningChildren >= MAX_RUNNING_CHILDREN) {
          return fail(
            `${runningChildren} child tasks are already running; wait for one to settle (or stop one) before starting another`,
          );
        }
        const requested = event.model?.trim() ?? "";
        const modelId = requested !== "" ? requested : parent.modelId;
        const provider = await resolveProviderSecrets(providers, parent.providerId);
        const childId = randomUUID();
        // 标题：模型起的算 auto（auto-title 不再抢）；空着退 prompt 首行（derived，
        // 用户后续进这条子会话时 auto-title 还有机会接手）
        const given = deriveSessionTitle(event.title);
        const title = given !== "" ? given : deriveSessionTitle(event.prompt);
        const now = Date.now();
        await sessions.ensureSession({
          id: childId,
          title,
          titleSource: given !== "" ? "auto" : "derived",
          cwd: parent.cwd,
          workspaceId: parent.workspaceId,
          providerId: parent.providerId,
          modelId,
          mode: parent.mode,
          piSessionFile: null,
          pinned: false,
          archived: false,
          parentSessionId: parent.id,
          recentQueries: [],
          stats: null,
          createdAt: now,
          updatedAt: now,
        });
        const piSessionFile = await host.submit({
          type: "submit",
          sessionId: childId,
          text: event.prompt,
          cwd: parent.cwd,
          provider,
          modelId,
          mode: parent.mode,
          piSessionDir,
          protectedPaths,
          skillsDirs: skillDirs(parent.workspaceId),
          mcpServers: await readMcpServers(),
          compaction: await readCompaction(),
          // 子会话不注册 start_task：深度恒为 1 的机制本体
          canDispatch: false,
        });
        if (piSessionFile !== null) await sessions.setPiSessionFile(childId, piSessionFile);
        return {
          ok: true,
          card: { sessionId: childId, title: title === "" ? "(untitled)" : title },
          text:
            `Task started: "${title === "" ? "(untitled)" : title}" (id ${childId}). ` +
            "It runs in the background in parallel; you will NOT be notified when it finishes — " +
            "do not wait for it or report it as done.",
        };
      } catch (error: unknown) {
        return fail(error instanceof Error ? error.message : String(error));
      }
    },

    /**
     * 主进程事件回调的挂入口：phase 真值在这里记账。放在各域分支**之前**——
     * 被 (不存在的) 分支吃掉的事件也要计数。
     */
    observe(event: AgentEvent): void {
      if (event.type === "phase") running.set(event.sessionId, event.phase !== "idle");
      // 轮失败的 failed 与 finally 的 idle 先后没有契约保证——先记「不在跑」，
      // 迟到的 idle 再写一遍是幂等的
      if (event.type === "failed" && event.sessionId !== null) running.set(event.sessionId, false);
    },
  };
}

export type TurnAssembler = ReturnType<typeof createTurnAssembler>;
