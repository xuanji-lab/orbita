/**
 * 新内核（pi-durable）的主进程侧：开发开关、kernel utility 进程的管家，与「打开会话时让新内核接手」
 * 的编排。**纯模块**（不 import electron，fork 由 index.ts 注入），`node --test` 直接测。
 *
 * 开关：环境变量 `ORBITA_DURABLE_KERNEL=1`，**默认关**。关着时 index.ts 不建 KernelHost，
 * 会话加载 / 删除 / 工具禁区三处都走与基线逐字节相同的代码（见各调用点的三元式）。
 *
 * 开着时（这一步的全部行为）：打开一条会话 → 新内核把它的 pi 本子复制进这棵会话树的库（首次），
 * meta 记下位置；失败则 meta 记原因、窗口里报一句，原件不动、会话照旧只读可看。对话主循环仍是旧内核，
 * 所以库里那份是「打开那一刻」的副本，之后旧内核续写的轮不会进库（主循环迁过来那一步才消失的过渡状态）。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderSecrets } from "../../shared/agent-ipc.ts";
import {
  KERNEL_LIBRARY_NAME,
  kernelLibraryName,
  type KernelCommand,
  type KernelMessage,
  type KernelOpenResult,
  type SessionDurable,
} from "../../shared/kernel.ts";
import type { SessionMeta } from "../../shared/session.ts";
import type { CompactionSetting } from "../../shared/settings.ts";

/** 开发开关的环境变量名 */
export const DURABLE_KERNEL_FLAG = "ORBITA_DURABLE_KERNEL";

/** 开关只认字面量 "1"：别的值（空串、"0"、"true"）一律当关——宁可没开，不要误开 */
export function durableKernelEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DURABLE_KERNEL_FLAG] === "1";
}

/** utilityProcess 的结构面（AgentChild 同款） */
export interface KernelChild {
  postMessage(message: KernelCommand): void;
  on(event: "message", listener: (message: KernelMessage) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
}

/** 迁一条大会话（几十 MB 的本子）也该在这之内；超了当失败，下次打开再试 */
const OPEN_TIMEOUT_MS = 120_000;

export class KernelHost {
  private readonly fork: () => KernelChild;
  private readonly dir: string;
  private child: KernelChild | null = null;
  private readonly pending = new Map<string, { resolve: (message: KernelMessage) => void; reject: (error: Error) => void }>();
  private seq = 0;

  /** dir：库目录（`<userData>/durable`），随 init 发给 kernel 进程 */
  constructor(fork: () => KernelChild, dir: string) {
    this.fork = fork;
    this.dir = dir;
  }

  /** 懒启动：第一次真要用新内核时才拉进程 */
  private ensure(): KernelChild {
    if (this.child !== null) return this.child;
    const child = this.fork();
    this.child = child;
    child.on("message", (message) => {
      if (message.type === "ready") return;
      const waiting = this.pending.get(message.requestId);
      this.pending.delete(message.requestId);
      waiting?.resolve(message);
    });
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      const error = new Error(`kernel runtime exited with code ${code}`);
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    });
    child.postMessage({ type: "init", dir: this.dir });
    return child;
  }

  private request(command: KernelCommand & { requestId: string }): Promise<KernelMessage> {
    const child = this.ensure();
    return new Promise<KernelMessage>((resolve, reject) => {
      this.pending.set(command.requestId, { resolve, reject });
      setTimeout(() => {
        if (!this.pending.delete(command.requestId)) return;
        reject(new Error("kernel runtime did not answer in time"));
      }, OPEN_TIMEOUT_MS);
      child.postMessage(command);
    });
  }

  /** 打开一条会话（首次即迁）。进程没了 / 超时折成失败结果，不抛错。 */
  async open(input: Omit<Extract<KernelCommand, { type: "open" }>, "type" | "requestId">): Promise<KernelOpenResult> {
    try {
      const reply = await this.request({ type: "open", requestId: `open-${(this.seq += 1)}`, ...input });
      if (reply.type !== "opened") return { ok: false, reason: "kernel runtime answered with the wrong message" };
      return reply.result;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * 删一棵会话树的库。kernel 进程在跑就让它关库再删（库可能正开着）；不在跑就在这里直接删文件——
   * 没有任何进程开着它，不值得为删三个文件拉起一个进程。库不在也算成功。
   */
  async drop(library: string): Promise<void> {
    if (!KERNEL_LIBRARY_NAME.test(library)) throw new Error(`invalid library name "${library}"`);
    if (this.child === null) {
      for (const suffix of ["", "-wal", "-shm"]) await rm(join(this.dir, `${library}${suffix}`), { force: true });
      return;
    }
    const reply = await this.request({ type: "drop", requestId: `drop-${(this.seq += 1)}`, library });
    if (reply.type === "dropped" && reply.error !== null) throw new Error(reply.error);
  }
}

export interface KernelOpenDeps {
  host: Pick<KernelHost, "open">;
  readMeta: (id: string) => Promise<SessionMeta | null>;
  /** 装配服务商（同开轮的 resolveProviderSecrets）；装配不了（已删 / 关着 / 导入未分配）给 null */
  resolveProvider: (providerId: string) => Promise<ProviderSecrets | null>;
  compaction: () => Promise<CompactionSetting>;
  setDurable: (id: string, durable: SessionDurable) => Promise<void>;
  /** 迁移失败时告诉窗口一句话（挂在那条会话上） */
  notifyFailure: (sessionId: string, message: string) => void;
  now: () => number;
}

/** 沿 parentId 找到树根（防环：最多走 32 层，走不通就当自己是根） */
async function rootOf(meta: SessionMeta, readMeta: KernelOpenDeps["readMeta"]): Promise<string> {
  let current = meta;
  const seen = new Set<string>([meta.id]);
  for (let depth = 0; depth < 32 && current.parentId !== undefined; depth += 1) {
    if (seen.has(current.parentId)) break;
    const parent = await readMeta(current.parentId);
    if (parent === null) break;
    seen.add(parent.id);
    current = parent;
  }
  return current.id;
}

/**
 * 打开会话时让新内核接手（开关开着才会被调用）。返回写进 meta 的值；不需要接手的返回 null：
 * 没有 pi 本子的会话（旧内核也只能读不能续）新内核同样不碰。
 */
export async function openInKernel(deps: KernelOpenDeps, meta: SessionMeta): Promise<SessionDurable | null> {
  if (meta.piSessionFile === null) return null;
  const library = kernelLibraryName(await rootOf(meta, deps.readMeta));
  const provider = await deps.resolveProvider(meta.providerId).catch(() => null);
  const result = await deps.host.open({
    library,
    sessionId: meta.id,
    legacy: { piSessionFile: meta.piSessionFile },
    agent: {
      provider,
      modelId: meta.modelId,
      thinkingLevel: meta.thinkingLevel,
      cwd: meta.cwd,
      role: meta.parentId === undefined ? "root" : "child",
      compaction: await deps.compaction(),
    },
  });
  const previous = meta.durable;
  let durable: SessionDurable;
  if (result.ok) {
    const earlier = previous?.status === "ready" && previous.conversationId === result.conversationId ? previous : null;
    durable = {
      status: "ready",
      library,
      conversationId: result.conversationId,
      migratedAt: result.migrated || earlier === null ? deps.now() : earlier.migratedAt,
      legacy: result.migrated ? result.legacy : (earlier?.legacy ?? null),
    };
    // 已经记着同一个位置就不重写 meta（打开会话是高频动作，不为一个没变的字段动盘）
    if (earlier !== null && !result.migrated && earlier.library === library) return earlier;
  } else {
    durable = { status: "failed", reason: result.reason, at: deps.now() };
    deps.notifyFailure(meta.id, `新内核没能接手这条会话：${result.reason}。原记录没有改动，仍可照常查看。`);
  }
  await deps.setDurable(meta.id, durable);
  return durable;
}
