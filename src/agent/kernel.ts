/**
 * 新内核（pi-durable）的库池：一棵会话树一个 SQLite 库，按需打开、按需迁旧会话。
 * 不 import electron，`node --test` 直接测（存储与模型可注入）；进程壳在 kernel-runtime.ts。
 *
 * 这一步**只装配、存储与迁移，不跑任何一轮**：对话主循环仍是 pi-coding-agent（runtime.ts）。
 * 所以 Harness 打开后从不 resume()——库里没有在途任务；以后主循环迁过来，「重启后前台会话
 * 不自动续跑」的策略在那一步定，这里只保证数据层撑得住（在途任务都在库里）。
 *
 * 并发与幂等（剧本第 13 条）：
 * - 同一个库只有一个 Harness（durable 不做跨进程锁，一个库同一时刻只能有一个写者——
 *   kernel 进程就是那个写者，库池保证进程内不重复打开）。
 * - 同一条会话的 open 在进程内排队（inflight），第二个调用拿第一个的结果。
 * - 迁移是**一次提交**：建会话、写全部 entry、写「会话 id → 会话号」索引同在 createConversation
 *   的 init 里，SQLite 事务要么全落要么全不落——迁到一半崩溃，重开后库里没有半份。
 *   init 里先查索引，已有就抛哨兵回滚——即使绕过进程内排队，也只会有一份。
 */
import { open as openFile, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Api, Model, Models, ModelsSimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineDoc,
  Harness,
  LiveDoc,
  ProviderDoc,
  type AgentChange,
  type ConversationId,
  type EntryId,
  type HarnessSettings,
  type JsonObject,
  type Registry,
  type Storage,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { addTombstones, purgeFile, purgeTombstoned, removeTombstone } from "./kernel-purge.ts";
import type { ProviderSecrets } from "../shared/agent-ipc.ts";
import { isDurableBookRef, KERNEL_LIBRARY_NAME } from "../shared/kernel.ts";
import type { ThinkingLevel } from "../shared/thinking.ts";
import { COMPACTION_DEFAULT } from "../shared/settings.ts";
import { chooseCacheRetention, type SessionRole } from "./cache-retention.ts";
import { compactionKeepRecentTokens, compactionReserveTokens } from "./compaction-settings.ts";
import { LEGACY_KINDS, planLegacyMigrationFile, type LegacyDraft } from "./legacy-migrate.ts";
import { messageSignature, WireDoc } from "./kernel-wire.ts";
import { RETRY_BASE_DELAY_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_DELAY_MS } from "./retry-policy.ts";
import type { KernelTurnTarget } from "./kernel-turn.ts";
import { piRequestOptions } from "./kernel-prompt.ts";
import { ccBillingPatch } from "./cc-billing-patch.ts";
import { turnToolFlags, type TurnInput } from "./turn-tools.ts";
import { withOpencodeSession } from "./opencode-session.ts";

/**
 * 库里的「Orbita 会话 id → durable 会话号」索引（session 作用域的单例文档）。
 * 与迁移写在同一次提交里：它在，迁移就完整；它不在，库里就没有这条会话的任何东西。
 */
export const SessionIndexDoc = defineDoc<{ sessions: Record<string, number> }>({
  kind: "orbita.sessions",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {} }),
  checkpointWhen: () => true,
});

/**
 * 每条会话用过的全部 durable 会话号（session 作用域的单例文档）：迁移 / 新建时是 [号]，每回退一次追加 fork 出来的那条。
 * 用量按它累计（旧内核的 getSessionStats 数整本本子，含回退留下的废枝；durable 的 pi.usage 在 fork 时从零开始），
 * 删树里的一条时按它清行。缺席（第三步建的库）= 只有索引里那一条。
 */
export const SessionHistoryDoc = defineDoc<{ sessions: Record<string, number[]> }>({
  kind: "orbita.session-history",
  version: 1,
  scope: "session",
  initial: () => ({ sessions: {} }),
  checkpointWhen: () => true,
});

/**
 * 迁移时原件的指纹（库里按会话记，与迁移同一次提交）：大小 + 修改时刻 + 末尾 64 KiB 的 sha256。
 * 新内核要发消息时先比它——原件之后又被旧内核续写过（指纹变了），库里那份就过期了，丢掉重迁。
 * 末尾那一段是兜底：同秒内改了同样字节数的极端情形，mtime 与大小都分不出来（pi 本子只追加，变化总在末尾）。
 */
export type LegacyPrint = {
  bytes: number;
  mtimeMs: number;
  tail: string;
};
const PRINT_TAIL_BYTES = 64 * 1024;

/** 迁移每批提交的原文量（字节）：批越大提交次数越少、峰值越高；8 MB 时 139 MB 的本子约 18 批 */
const MIGRATION_BATCH_BYTES = 4 * 1024 * 1024;

export const LegacyPrintDoc = defineDoc<{ prints: Record<string, LegacyPrint> }>({
  kind: "orbita.legacy-prints",
  version: 1,
  scope: "session",
  initial: () => ({ prints: {} }),
  checkpointWhen: () => true,
});

function tailHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes.subarray(Math.max(0, bytes.length - PRINT_TAIL_BYTES))).digest("hex");
}

/** 不读整份原件就算指纹：stat + 读末尾一段（几百 MB 的本子每次发消息前都要比一次） */
export async function legacyPrint(file: string): Promise<LegacyPrint> {
  const info = await stat(file);
  const length = Math.min(info.size, PRINT_TAIL_BYTES);
  const handle = await openFile(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, info.size - length);
    return { bytes: info.size, mtimeMs: info.mtimeMs, tail: tailHash(buffer) };
  } finally {
    await handle.close();
  }
}

function samePrint(left: LegacyPrint | undefined, right: LegacyPrint): boolean {
  return left !== undefined && left.bytes === right.bytes && left.mtimeMs === right.mtimeMs && left.tail === right.tail;
}

/** 新内核为一条会话要的 agent 设定（由开轮命令装配，见 turn） */
export interface KernelAgent {
  /** null = 没有可用的服务商，只开库不配模型 */
  provider: ProviderSecrets | null;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  /** 根会话 / 子会话：决定 Claude 官方直连的缓存时长（cache-retention.ts 的同一个判定） */
  role: "root" | "child";
  /** 自动压缩：同设置项「剩余百分比」，按模型窗口换算（compaction-settings.ts） */
  compaction: { enabled: boolean; reservePercent: number };
}

/** 打开一条会话的结局 */
export type KernelOpenResult =
  | {
      ok: true;
      conversationId: number;
      /** 这一次打开做了迁移（false = 库里的副本还是最新的 / 全新会话已建过） */
      migrated: boolean;
      /** 这次迁移是重迁：库里原来那份比原件旧，换成了新的一份（旧那份留在库里不再被索引指着） */
      remigrated: boolean;
      /** 迁进库的 entry 条数（没迁为 0） */
      entries: number;
      /** 迁移时原件的大小与修改时刻；新建为 null */
      legacy: { bytes: number; mtimeMs: number } | null;
      ms: number;
    }
  | { ok: false; reason: string };

/** 运行策略：与旧内核的设置逐项对齐（见 kernelSettings 的注释）；读时现算，不落库 */
export function kernelSettings(): HarnessSettings {
  return {
    // 重试节奏同旧内核（retry-policy.ts：8 次、1 秒起指数退避、单次等待封顶 128 秒）
    retry: { enabled: true, maxRetries: RETRY_MAX_ATTEMPTS, baseDelayMs: RETRY_BASE_DELAY_MS, maxAgentDelayMs: RETRY_MAX_DELAY_MS },
    // 流式回答 30ms 提交一次（durable 默认 100ms；watch 即时可见，落库仍按 persistWithinMs）
    progress: { partialIntervalMs: 30 },
    // 失败的一轮后面排着的消息留着等用户（durable 默认同值，写明是因为它是 Esc / 排队语义的一部分）
    afterFailedRun: "keep",
  };
}

/**
 * 压缩设定（每条会话自己的，存在 pi.agent 里）：阈值按「剩余百分比」× 本会话模型窗口换算，
 * 与旧内核 runtime.ts 的 applyOverrides({ compaction }) 同一个公式；**不开后台压缩**（backgroundTokens 0）——
 * 旧内核没有这个行为，换内核这一步不悄悄加。
 */
export function kernelCompaction(agent: KernelAgent, contextWindow: number | undefined): NonNullable<AgentChange["compaction"]> {
  const window = contextWindow ?? 0;
  return {
    enabled: agent.compaction.enabled,
    reserveTokens: compactionReserveTokens(agent.compaction.reservePercent ?? COMPACTION_DEFAULT.reservePercent, window),
    keepRecentTokens: compactionKeepRecentTokens(window),
    backgroundTokens: 0,
  };
}

/**
 * 给 Models 包一层：调用方没指定 cacheRetention 时，按「这次请求的模型 + 这条会话是根还是子」补
 * （cache-retention.ts 的同一个判定：只有 Anthropic 官方直连的根会话用 1 小时）。
 * durable 的 settings 是整库共用的，分不出根与子；它随请求带着 provider sessionId，
 * 库池记下「sessionId → 角色」，在这里按它判。压缩显式传的 cacheRetention 原样保留。
 */
export function withCacheRetention(inner: Models, roleOf: (providerSessionId: string | undefined) => SessionRole): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options?: ModelsSimpleStreamOptions) => {
    if (options?.cacheRetention !== undefined) return inner.streamSimple(model, context, options);
    const retention = chooseCacheRetention({ api: String(model.api), baseUrl: model.baseUrl }, roleOf(options?.sessionId));
    if (retention === undefined) return inner.streamSimple(model, context, options);
    return inner.streamSimple(model, context, { ...options, cacheRetention: retention });
  };
  return new Proxy(inner, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * 给 Models 包一层：**每一个**出站请求（对话主循环的 streamSimple 与压缩摘要的 completeSimple）都过一遍
 * Claude 订阅车道的最小改写（cc-billing-patch.ts，只对带 pi OAuth 身份块的 Anthropic 请求生效，其余原样）。
 * 旧内核分两处挂（主循环的 before_provider_request + 压缩绕过主循环时的 streamFunction 包装，cc-billing-stream.ts），
 * durable 的模型调用都经 Models，一处就全覆盖。durable 自己的 onPayload（beforeProviderRequest 钩子链）先跑，改写在它之后。
 */
export function withBillingPatch(inner: Models): Models {
  const shape = <O extends { onPayload?: ModelsSimpleStreamOptions["onPayload"] }>(options: O | undefined): O => {
    const previous = options?.onPayload;
    return {
      ...(options ?? ({} as O)),
      onPayload: async (payload: unknown, model: Model<Api>) => {
        const replaced = previous === undefined ? undefined : await previous(payload, model);
        const current = replaced ?? payload;
        return ccBillingPatch(current) ?? replaced;
      },
    };
  };
  const streamSimple: Models["streamSimple"] = (model, context, options) => inner.streamSimple(model, context, shape(options));
  const completeSimple: Models["completeSimple"] = (model, context, options) => inner.completeSimple(model, context, shape(options));
  return new Proxy(inner, {
    get(target, property) {
      if (property === "streamSimple") return streamSimple;
      if (property === "completeSimple") return completeSimple;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** KernelPool.target 的结局：durable 那一侧备好的会话（一轮要的 KernelTurnTarget + 它的 Harness 与压缩设定） */
export type KernelTarget =
  | (KernelTurnTarget & {
      ok: true;
      harness: Harness;
      compaction: NonNullable<AgentChange["compaction"]>;
      migration: "none" | "migrated" | "remigrated";
    })
  | { ok: false; reason: string; migrationFailed?: true };

export interface KernelPoolOptions {
  /** 库目录（`<userData>/durable`）；库文件名都相对它 */
  dir: string;
  /** 当前的模型访问（服务商注册在调用方）；每次用时现取 */
  models: () => Models;
  /** 每条会话打开 / 跑轮时把服务商注册进模型目录，返回解析出的模型（压缩阈值要它的窗口）；没有服务商时不调 */
  registerProvider?: (agent: KernelAgent) => Model<Api> | undefined;
  /** 测试注入：不落 SQLite，用 MemoryStorage 之类 */
  openStorage?: (file: string) => Promise<Storage>;
  now?: () => number;
  log?: (text: string) => void;
  /** 迁移大本子时定期收一次垃圾（kernel 进程里注入，见 kernel-gc.ts）；缺席 = 交给 V8 自己 */
  collectGarbage?: () => void;
}

interface OpenLibrary {
  harness: Harness;
  /** 这个库的扩展注册表：每条会话一个 `orbita-session-<id>` 扩展，跑轮时按开轮命令重建装上 */
  registry: Registry;
  /** 正在进行的 open（按会话 id），并发调用共享 */
  inflight: Map<string, Promise<KernelOpenResult>>;
}

/** init 里发现索引已有这条会话：抛它回滚整次提交，再读已有的 */
class AlreadyIndexed extends Error {
  readonly conversationId: number;
  constructor(conversationId: number) {
    super("already indexed");
    this.conversationId = conversationId;
  }
}

export class KernelPool {
  private readonly options: KernelPoolOptions;
  /** 库名 → 打开中 / 已打开的库（Promise 让并发的第一次打开只开一次） */
  private readonly libraries = new Map<string, Promise<OpenLibrary>>();
  /** provider sessionId → 会话角色（缓存时长判定用，见 withCacheRetention） */
  private readonly roles = new Map<string, SessionRole>();

  constructor(options: KernelPoolOptions) {
    this.options = options;
  }

  /** 给 withCacheRetention 用：认不出的 sessionId 当子会话（保守：不给 1 小时缓存） */
  roleOf(providerSessionId: string | undefined): SessionRole {
    return providerSessionId === undefined ? "child" : (this.roles.get(providerSessionId) ?? "child");
  }

  private filePath(library: string): string {
    if (!KERNEL_LIBRARY_NAME.test(library)) throw new Error(`invalid library name "${library}"`);
    return join(this.options.dir, library);
  }

  /** 打开（或拿已打开的）库。打开失败不缓存失败：下一次再试。 */
  library(library: string): Promise<OpenLibrary> {
    const existing = this.libraries.get(library);
    if (existing !== undefined) return existing;
    const opening = (async (): Promise<OpenLibrary> => {
      const file = this.filePath(library);
      // 上次删了树里的一条、还没来得及清行（关库前进程就没了）：打开之前清掉
      if (this.options.openStorage === undefined) await this.purge(file);
      const storage = await (this.options.openStorage ?? ((path: string) => openNodeSqliteStorage(path)))(file);
      // 扩展（工具、系统提示、钩子）按会话在跑轮时装：迁移与开库用不到
      const registry = createRegistry();
      const harness = await Harness.open(
        storage,
        {
          models: () => withBillingPatch(withCacheRetention(this.options.models(), (id) => this.roleOf(id))),
          registry,
          // 请求身份（User-Agent、署名）与请求层选项（超时、SDK 内重试、思考预算）从 pi 的同一份设置读，与旧内核同值
          identity: piRequestOptions().identity,
          settings: () => ({ ...kernelSettings(), stream: piRequestOptions().stream }),
          ...(this.options.now === undefined ? {} : { now: this.options.now }),
          onReport: (report) => this.options.log?.(`[kernel] ${library} 报告 ${report.kind}：${String(report.error)}`),
        },
        BACKGROUND_CONTEXT,
      );
      await this.stopInterrupted(harness, library);
      // 存储出错 durable 会自己关掉 Harness：从池里摘掉，下次打开重来
      void harness.closed.then(() => {
        if (this.libraries.get(library) === opening) this.libraries.delete(library);
      });
      return { harness, registry, inflight: new Map() };
    })();
    this.libraries.set(library, opening);
    opening.catch(() => {
      if (this.libraries.get(library) === opening) this.libraries.delete(library);
    });
    return opening;
  }

  /**
   * 上一个进程留下的在途工作（崩溃 / 被杀时正在跑的轮、阻塞式压缩）：**前台会话不自动续跑**（方案 §2.2 第 10 行的默认）——
   * durable 重开后 resume() 会把它们接着跑完，在用户不在场时花钱、跑命令。打开库时先 abortTask 它们（队列与上下文都留着），
   * 等它们收尾；界面上这条会话是「上次被中断」，由用户点「继续」（submit continue）再接着答。
   */
  private async stopInterrupted(harness: Harness, library: string): Promise<void> {
    const index = (await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions ?? {};
    const stopped: ConversationId[] = [];
    for (const id of Object.values(index)) {
      const conversationId = id as ConversationId;
      const live = await harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
      const tasks = [...(live?.run === undefined ? [] : [live.run.taskId]), ...(live?.compactions ?? []).map((status) => status.taskId)];
      if (tasks.length === 0) continue;
      for (const task of tasks) await harness.abortTask(task, BACKGROUND_CONTEXT);
      stopped.push(conversationId);
    }
    for (const conversationId of stopped) await (await harness.conversation(conversationId, BACKGROUND_CONTEXT))?.waitForIdle(BACKGROUND_CONTEXT);
    if (stopped.length > 0) this.options.log?.(`[kernel] ${library}：上次留下 ${stopped.length} 条会话在跑，已停下（不自动续跑）`);
  }

  /**
   * 打开一条会话：索引里有就用（不重复迁），没有就建——有旧本子就把它的当前分支复制进来。
   * 不抛错：失败折成 `{ ok: false, reason }`，原件不动，调用方据此把会话标成只读可看。
   */
  async open(input: {
    library: string;
    sessionId: string;
    legacy: { piSessionFile: string } | null;
    agent: KernelAgent;
  }): Promise<KernelOpenResult> {
    let opened: OpenLibrary;
    try {
      opened = await this.library(input.library);
    } catch (error) {
      return { ok: false, reason: `新内核的库打不开：${error instanceof Error ? error.message : String(error)}` };
    }
    const running = opened.inflight.get(input.sessionId);
    if (running !== undefined) return running;
    const work = this.openIn(opened.harness, input).finally(() => opened.inflight.delete(input.sessionId));
    opened.inflight.set(input.sessionId, work);
    return work;
  }

  private async openIn(
    harness: Harness,
    input: { library: string; sessionId: string; legacy: { piSessionFile: string } | null; agent: KernelAgent },
  ): Promise<KernelOpenResult> {
    const started = (this.options.now ?? Date.now)();
    const elapsed = (): number => (this.options.now ?? Date.now)() - started;
    try {
      const registered = input.agent.provider === null ? undefined : this.options.registerProvider?.(input.agent);
      const indexed = (await harness.snapshot(SessionIndexDoc, BACKGROUND_CONTEXT))?.sessions[input.sessionId];
      // 库里已有：原件没变（或本来就没有原件）就用库里那份；原件之后又被旧内核续写过（指纹变了 / 没记过指纹）就重迁
      let replacing: number | undefined;
      if (indexed !== undefined) {
        if (input.legacy === null) {
          await this.remember(harness, indexed, input.agent.role);
          return { ok: true, conversationId: indexed, migrated: false, remigrated: false, entries: 0, legacy: null, ms: elapsed() };
        }
        const stored = (await harness.snapshot(LegacyPrintDoc, BACKGROUND_CONTEXT))?.prints[input.sessionId];
        if (samePrint(stored, await legacyPrint(input.legacy.piSessionFile))) {
          await this.remember(harness, indexed, input.agent.role);
          return { ok: true, conversationId: indexed, migrated: false, remigrated: false, entries: 0, legacy: null, ms: elapsed() };
        }
        replacing = indexed;
        this.options.log?.(`[kernel] ${input.sessionId} 库里的副本比原件旧（原件之后又被旧内核续写过），按原件重迁`);
      }
      const agent: AgentChange = {
        ...(input.agent.provider === null ? {} : { model: { provider: input.agent.provider.id, modelId: input.agent.modelId } }),
        thinkingLevel: input.agent.thinkingLevel,
        cwd: input.agent.cwd,
        compaction: kernelCompaction(input.agent, registered?.contextWindow),
      };
      if (input.legacy === null) {
        // 新内核里新建的会话：一次提交建会话 + 索引 + 历史
        let conversationId: number;
        try {
          const conversation = await harness.createConversation(
            {
              ownership: { kind: "ownerless" },
              agent,
              init: async (tx, id) => {
                const index = await tx.doc(SessionIndexDoc);
                const already = index.sessions[input.sessionId];
                if (already !== undefined) throw new AlreadyIndexed(already);
                index.sessions[input.sessionId] = id;
                (await tx.doc(SessionHistoryDoc)).sessions[input.sessionId] = [id];
              },
            },
            BACKGROUND_CONTEXT,
          );
          conversationId = conversation.id;
        } catch (error) {
          if (!(error instanceof AlreadyIndexed)) throw error;
          conversationId = error.conversationId;
        }
        await this.remember(harness, conversationId, input.agent.role);
        return { ok: true, conversationId, migrated: false, remigrated: false, entries: 0, legacy: null, ms: elapsed() };
      }
      return await this.migrate(harness, input.library, input.sessionId, input.legacy.piSessionFile, agent, replacing, input.agent.role, elapsed);
    } catch (error) {
      return { ok: false, reason: `迁移失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /**
   * 迁一本旧本子：**流式读、分批写**，整份内容从不同时在内存里（第三步验收：139 MB 的本子迁移时 kernel 进程冲到 1.25 GB，
   * 闲置后停在 0.8 GB——读整份 + 拆字符串 + 解析出的对象 + 一次提交里攒着的全部草稿）。
   * 1. 建一条**还没被索引指着**的会话，会话号先记进墓碑（迁到一半进程没了：下次关库 / 开库时按墓碑清掉这半份）；
   * 2. 两遍读本子（legacy-migrate.ts 的 planLegacyMigrationFile），草稿每攒满 MIGRATION_BATCH_BYTES 原文提交一次；
   * 3. 原件指纹前后一致才算数（迁移途中原件变了 = 读到的不是同一份，作废）；
   * 4. 最后一次提交写索引、历史、指纹、provider 会话 id 与跨轮账——**它落了迁移才算完成**，之前的提交对谁都不可见；
   *    然后从墓碑里摘掉这条会话。
   * 被否决：一次提交（第三步的做法）——原子性最好，但一次提交要把全部草稿攒在内存里，峰值是本子大小的好几倍。
   */
  private async migrate(
    harness: Harness,
    library: string,
    sessionId: string,
    file: string,
    agent: AgentChange,
    replacing: number | undefined,
    role: SessionRole,
    elapsed: () => number,
  ): Promise<KernelOpenResult> {
    const libraryFile = this.filePath(library);
    const before = await legacyPrint(file);
    const conversation = await harness.createConversation({ ownership: { kind: "ownerless" }, agent }, BACKGROUND_CONTEXT);
    await addTombstones(libraryFile, [conversation.id]);
    const ids: EntryId[] = [];
    const customs: string[] = [];
    let batch: LegacyDraft[] = [];
    let batchBytes = 0;
    let written = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const drafts = batch;
      batch = [];
      batchBytes = 0;
      await harness.commit((tx) => appendDrafts(tx, conversation.id, drafts, ids), BACKGROUND_CONTEXT);
      written += drafts.length;
    };
    const planned = await planLegacyMigrationFile(
      file,
      async (draft, bytes) => {
        if (draft.kind === LEGACY_KINDS.custom) for (const message of draft.model) customs.push(messageSignature(message));
        batch.push(draft);
        batchBytes += bytes;
        if (batchBytes >= MIGRATION_BATCH_BYTES) await flush();
      },
      this.options.collectGarbage,
    );
    if (!planned.ok) return { ok: false, reason: planned.reason };
    await flush();
    const after = await legacyPrint(file);
    if (!samePrint(before, after)) return { ok: false, reason: "迁移途中原件变了（读到的不是同一份），这次不迁" };
    const wire = planned.wire;
    let conversationId: number = conversation.id;
    try {
      await harness.commit(async (tx) => {
        const index = await tx.doc(SessionIndexDoc);
        const already = index.sessions[sessionId];
        // 已有索引且不是我们要换掉的那一份（别人刚迁过 / 刚重迁过）：用它，这一份留在墓碑里等清
        if (already !== undefined && already !== replacing) throw new AlreadyIndexed(already);
        index.sessions[sessionId] = conversation.id;
        // 新建 / 迁移 / 重迁都从这一条重新开始记（重迁丢掉的旧副本不再算这条会话的）
        (await tx.doc(SessionHistoryDoc)).sessions[sessionId] = [conversation.id];
        (await tx.doc(LegacyPrintDoc)).prints[sessionId] = before;
        // 沿用旧本子的会话 id 作 provider sessionId：提示缓存的亲和不因换内核断掉
        if (planned.providerSessionId !== null) (await tx.doc(ProviderDoc, conversation.id)).sessionId = planned.providerSessionId;
        // 逐请求注入的跨轮账（图片水位与引用、各轮记忆块）从本子读来；迁来的扩展消息记指纹（kernel-wire.ts）
        const state = await tx.doc(WireDoc, conversation.id);
        state.imageMark = wire.imageMark;
        state.imageRefs = wire.imageRefs;
        state.memory = wire.memory;
        if (wire.legacyTools.length > 0) state.legacyTools = JSON.parse(JSON.stringify(wire.legacyTools)) as JsonObject[];
        state.legacyUsage = { ...wire.legacyUsage };
        state.customs = customs;
      }, BACKGROUND_CONTEXT);
      await removeTombstone(libraryFile, conversation.id);
      // 迁完把解析留下的垃圾收掉：紧接着这一轮要读上下文，堆里腾出来的地方先给它用，峰值不叠
      this.options.collectGarbage?.();
    } catch (error) {
      if (!(error instanceof AlreadyIndexed)) throw error;
      conversationId = error.conversationId;
      await this.remember(harness, conversationId, role);
      return { ok: true, conversationId, migrated: false, remigrated: false, entries: 0, legacy: null, ms: elapsed() };
    }
    await this.remember(harness, conversationId, role);
    return { ok: true, conversationId, migrated: true, remigrated: replacing !== undefined, entries: written, legacy: { bytes: before.bytes, mtimeMs: before.mtimeMs }, ms: elapsed() };
  }

  /** 记下这条会话的 provider sessionId → 角色（缓存时长按它判） */
  private async remember(harness: Harness, conversationId: number, role: SessionRole): Promise<void> {
    const provider = await harness.snapshot(ProviderDoc, conversationId as ConversationId, BACKGROUND_CONTEXT);
    if (provider !== undefined) this.roles.set(provider.sessionId, role);
  }

  /**
   * 为一条会话的这一轮备好 durable 那一侧：开库、迁 / 重迁旧会话（发消息之前，见 open）、注册模型。
   * 不抛错：失败折成 `{ ok: false, reason }`；迁移那一步失败另带 migrationFailed（会话回落只读）。
   */
  async target(input: { library: string; command: TurnInput; compaction: KernelAgent["compaction"] }): Promise<KernelTarget> {
    const { command } = input;
    try {
      const agent: KernelAgent = {
        // OpenCode Go 的会话头按会话注入（与旧内核 openTurn 同一个包装；官方 DeepSeek 等原样返回）
        provider: withOpencodeSession(command.provider, command.sessionId),
        modelId: command.modelId,
        thinkingLevel: command.thinkingLevel,
        cwd: command.cwd,
        role: turnToolFlags(command).role,
        compaction: input.compaction,
      };
      const legacy = command.piSessionFile === undefined || isDurableBookRef(command.piSessionFile) ? null : { piSessionFile: command.piSessionFile };
      const opened = await this.open({ library: input.library, sessionId: command.sessionId, legacy, agent });
      if (!opened.ok) return { ok: false, reason: opened.reason, migrationFailed: true };
      const library = await this.library(input.library);
      const conversation = await library.harness.conversation(opened.conversationId as ConversationId, BACKGROUND_CONTEXT);
      if (conversation === undefined) return { ok: false, reason: `库里找不到会话 ${opened.conversationId}` };
      const model = this.options.registerProvider?.(agent);
      if (model === undefined) return { ok: false, reason: `unknown model "${command.provider.id}/${command.modelId}"` };
      const provider = await library.harness.snapshot(ProviderDoc, conversation.id, BACKGROUND_CONTEXT);
      return {
        ok: true,
        harness: library.harness,
        registry: library.registry,
        conversation,
        model,
        providerSessionId: provider?.sessionId ?? "",
        compaction: kernelCompaction(agent, model.contextWindow),
        migration: opened.remigrated ? "remigrated" : opened.migrated ? "migrated" : "none",
      };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 删树里的一条会话（不是树根）：从索引、历史、原件指纹里摘掉（一次提交），停它用过的会话里还活着的任务，
   * 再把这些会话号记进墓碑——库下一次关闭（或打开）时按墓碑清行（kernel-purge.ts）。返回记进墓碑的会话号。
   */
  async forget(library: string, sessionId: string): Promise<number[]> {
    const { harness } = await this.library(library);
    const ids = await harness.commit(async (tx) => {
      const index = await tx.doc(SessionIndexDoc);
      const indexed = index.sessions[sessionId];
      delete index.sessions[sessionId];
      const history = await tx.doc(SessionHistoryDoc);
      const used = history.sessions[sessionId] ?? [];
      delete history.sessions[sessionId];
      delete (await tx.doc(LegacyPrintDoc)).prints[sessionId];
      return [...new Set([...used, ...(indexed === undefined ? [] : [indexed])])];
    }, BACKGROUND_CONTEXT);
    for (const id of ids) {
      const conversationId = id as ConversationId;
      const live = await harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT);
      const tasks = [...(live?.run === undefined ? [] : [live.run.taskId]), ...(live?.compactions ?? []).map((status) => status.taskId)];
      for (const task of tasks) await harness.abortTask(task, BACKGROUND_CONTEXT);
      if (tasks.length > 0) await (await harness.conversation(conversationId, BACKGROUND_CONTEXT))?.waitForIdle(BACKGROUND_CONTEXT);
    }
    if (ids.length > 0) await addTombstones(this.filePath(library), ids);
    return ids;
  }

  /** 按墓碑清行（库没被打开时）；失败只记日志，墓碑留着下次再清 */
  private async purge(file: string): Promise<void> {
    try {
      const result = await purgeTombstoned(file);
      if (result !== null) this.options.log?.(`[kernel] ${file}：清掉删除的会话 ${result.conversations} 条（条目 ${result.entries}、任务 ${result.tasks}、文档 ${result.documents}）`);
    } catch (cause) {
      this.options.log?.(`[kernel] ${file}：清删除会话的行失败，下次再试：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  /** 关一个库（不删）；关完按墓碑清行 */
  async close(library: string): Promise<void> {
    const opening = this.libraries.get(library);
    this.libraries.delete(library);
    const opened = opening === undefined ? null : await opening.catch(() => null);
    if (opened !== null) await opened.harness.close(BACKGROUND_CONTEXT);
    if (this.options.openStorage === undefined) await this.purge(this.filePath(library));
  }

  /** 删一棵会话树：关库 + 删库文件（含 WAL 两个旁文件与墓碑）。库不在也算成功。 */
  async drop(library: string): Promise<void> {
    const file = this.filePath(library);
    const opening = this.libraries.get(library);
    this.libraries.delete(library);
    if (opening !== undefined) {
      const opened = await opening.catch(() => null);
      if (opened !== null) await opened.harness.close(BACKGROUND_CONTEXT);
    }
    for (const suffix of ["", "-wal", "-shm"]) await rm(`${file}${suffix}`, { force: true });
    await rm(purgeFile(file), { force: true });
  }

  /** 关掉全部库（进程退出 / 闲置回收前）；关完按墓碑清行。 */
  async closeAll(): Promise<void> {
    for (const library of [...this.libraries.keys()]) await this.close(library);
  }
}

/**
 * 按序追加迁移草稿。压缩的 head 用本次提交里前面那条 appendEntry 返回的真 id 回填
 * （不猜 id + 1：durable 1.5 的 id 只保证单调）。
 */
async function appendDrafts(
  tx: Parameters<NonNullable<Parameters<Harness["createConversation"]>[0]["init"]>>[0],
  conversationId: ConversationId,
  drafts: readonly LegacyDraft[],
  /** 之前几批已写的 entry 的真 id（按草稿下标；headRef 是全局下标），本批写完接着往后追加 */
  ids: EntryId[],
): Promise<void> {
  for (const draft of drafts) {
    const head = draft.headRef === undefined ? undefined : draft.headRef === "self" ? "self" : ids[draft.headRef];
    if (draft.headRef !== undefined && head === undefined) throw new Error(`compaction head ${String(draft.headRef)} points past the drafts`);
    const record = await tx.appendEntry(conversationId, {
      kind: draft.kind,
      model: draft.model,
      ...(draft.data === undefined ? {} : { data: draft.data }),
      ...(head === undefined ? {} : { head }),
    });
    ids.push(record.id);
  }
}
