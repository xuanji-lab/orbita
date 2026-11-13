/**
 * 新内核（pi-durable）的契约真源：主进程 ↔ kernel utility 进程的消息协议，与会话 meta 上
 * 记的「这条会话在新内核库里的位置」。
 *
 * 现状（换内核第一步）：对话主循环仍是 pi-coding-agent；新内核只在开发开关
 * `ORBITA_DURABLE_KERNEL=1` 打开时被拉起，打开会话时把旧会话**复制**进它自己的库（惰性迁移），
 * 不跑任何一轮。开关默认关，关着时主进程不拉起 kernel 进程、不读也不写下面这些字段。
 *
 * 库布局：**一棵会话树一库**——根会话与它派出的子会话在同一个 SQLite 文件
 * （`<userData>/durable/<根会话 id>.sqlite`），删一棵树 = 关库 + 删文件；不同的树互不相干。
 */
import type { ProviderSecrets } from "./agent-ipc.ts";
import type { ThinkingLevel } from "./thinking.ts";

/** 库文件名：根会话 id（与 SessionStore 的 id 白名单同形）+ `.sqlite`。路径只由主进程拼，kernel 进程再校验一次。 */
export const KERNEL_LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.sqlite$/;

/** 根会话 id → 库文件名。调用方先保证 id 过了会话 id 白名单。 */
export function kernelLibraryName(rootSessionId: string): string {
  return `${rootSessionId}.sqlite`;
}

/**
 * meta.durable：这条会话在新内核里的状态。**缺席 = 新内核从没打开过它**（开关关着时恒缺席）。
 *
 * - ready：已在库里。`library` 是 `<userData>/durable/` 下的文件名（不存绝对路径：数据目录挪了也认得）；
 *   `conversationId` 是 durable 的会话号；`legacy` 记迁移时原件的大小与修改时刻（新建的会话为 null）——
 *   原件之后又被旧内核续写过，就能看出库里那份是哪一刻的副本。
 * - failed：迁移失败。原件不动，会话照旧只读可看；`reason` 是给人看的一句话。下次打开会再试一次。
 */
export type SessionDurable =
  | {
      status: "ready";
      library: string;
      conversationId: number;
      migratedAt: number;
      legacy: { bytes: number; mtimeMs: number } | null;
    }
  | { status: "failed"; reason: string; at: number };

/** 新内核打开一条会话时要的 agent 设定（与开轮的同名字段同源，由主进程装配）。 */
export interface KernelAgent {
  /** 明文密钥只在主进程 → kernel 进程这一跳出现（同 AgentTurnContext.provider）；null = 没有可用的服务商，只开库不配模型 */
  provider: ProviderSecrets | null;
  modelId: string;
  thinkingLevel: ThinkingLevel;
  cwd: string;
  /** 根会话 / 子会话：决定 Claude 官方直连的缓存时长（cache-retention.ts 的同一个判定） */
  role: "root" | "child";
  /** 自动压缩：同设置项「剩余百分比」，按模型窗口换算（compaction-settings.ts） */
  compaction: { enabled: boolean; reservePercent: number };
}

export type KernelCommand =
  /** 进程就绪后的第一句：库目录（`<userData>/durable`） */
  | { type: "init"; dir: string }
  /**
   * 打开一条会话（不存在就建，旧会话就迁）。幂等：同一条会话并发打开、或迁完之后再开，库里都只有一份
   * （库里有一份「会话 id → 会话号」的索引，与迁移写在同一次提交里）。
   * `legacy`：旧内核的 pi 本子（只读、复制，不改原件）；null = 全新会话。
   */
  | {
      type: "open";
      requestId: string;
      library: string;
      sessionId: string;
      legacy: { piSessionFile: string } | null;
      agent: KernelAgent;
    }
  /** 删一棵会话树的库：关库 + 删文件（含 -wal / -shm）。库不在也算成功。 */
  | { type: "drop"; requestId: string; library: string };

export type KernelOpenResult =
  | {
      ok: true;
      conversationId: number;
      /** 这一次打开做了迁移（false = 库里早就有它） */
      migrated: boolean;
      /** 迁进库的 entry 条数（没迁为 0） */
      entries: number;
      /** 迁移时原件的大小与修改时刻；新建为 null */
      legacy: { bytes: number; mtimeMs: number } | null;
      ms: number;
    }
  | { ok: false; reason: string };

export type KernelMessage =
  | { type: "ready" }
  | { type: "opened"; requestId: string; sessionId: string; result: KernelOpenResult }
  | { type: "dropped"; requestId: string; error: string | null };

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 解磁盘上的 meta.durable。**坏了返回 null（当缺席）**，不丢整条会话——缺席的后果只是新内核下次
 * 打开时再查一次库里的迁移索引，不会迁出第二份（索引在库里，不在 meta 里）。
 */
export function parseSessionDurable(raw: unknown): SessionDurable | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  if (value["status"] === "failed") {
    const at = finiteNumber(value["at"]);
    if (typeof value["reason"] !== "string" || at === null) return null;
    return { status: "failed", reason: value["reason"], at };
  }
  if (value["status"] !== "ready") return null;
  const library = value["library"];
  const conversationId = finiteNumber(value["conversationId"]);
  const migratedAt = finiteNumber(value["migratedAt"]);
  if (typeof library !== "string" || !KERNEL_LIBRARY_NAME.test(library) || conversationId === null || migratedAt === null) {
    return null;
  }
  const rawLegacy = value["legacy"];
  let legacy: { bytes: number; mtimeMs: number } | null = null;
  if (typeof rawLegacy === "object" && rawLegacy !== null) {
    const bytes = finiteNumber((rawLegacy as Record<string, unknown>)["bytes"]);
    const mtimeMs = finiteNumber((rawLegacy as Record<string, unknown>)["mtimeMs"]);
    if (bytes !== null && mtimeMs !== null) legacy = { bytes, mtimeMs };
  }
  return { status: "ready", library, conversationId, migratedAt, legacy };
}
