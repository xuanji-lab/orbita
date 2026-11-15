/**
 * 新内核（pi-durable）的主进程侧：开发开关、开轮命令交给谁、会话「住在新内核」的标记、删会话时连带删库。
 * **纯模块**（不 import electron，fork 由 index.ts 注入），`node --test` 直接测。
 *
 * 开关：环境变量 `ORBITA_DURABLE_KERNEL=1`，**默认关**。关着时 index.ts 不给 AgentHost 这条道（KernelLane），
 * host 的行为与开关之前逐字节相同；唯一的差别是住在新内核里的会话（meta.durable）**不交给旧内核续写**（见 routeFor）。
 *
 * 开着时：对话主循环（根会话、子会话、自动化开的轮）都由 kernel 进程跑（第一次交给它时在 meta 上记 DurableMark）；
 * 子会话与父同库（一棵树一库，root = 父）。本子编辑类操作（回退 / 撤销 / 分支的源 / 挪工作区）：住在新内核里的会话
 * 交给新内核，其余（开关开着但还没在新内核里跑过的旧会话）照旧由旧内核编辑 pi 本子——它下次发消息时按编辑后的本子迁。
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { DurableMark, SessionMeta } from "../../shared/session.ts";
import { KERNEL_LIBRARY_NAME, resumePolicy, type KernelTurnResult } from "../../shared/kernel.ts";
import type { KernelChild, KernelLane, KernelRoute, TurnRoute } from "./host-core.ts";

/** 开发开关的环境变量名 */
export const DURABLE_KERNEL_FLAG = "ORBITA_DURABLE_KERNEL";

/** 开关只认字面量 "1"：别的值（空串、"0"、"true"）一律当关——宁可没开，不要误开 */
export function durableKernelEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[DURABLE_KERNEL_FLAG] === "1";
}

/** 关着开关打开一条住在新内核里的会话：只能看，不能续（界面也按它禁用输入框，这里是最后一道） */
export const DURABLE_MOVED_MESSAGE =
  "This conversation continued in the durable kernel. With ORBITA_DURABLE_KERNEL off it is read-only here (the old kernel only has the turns before the move).";

/** 迁移失败：只读 */
function migrationFailedMessage(reason: string): string {
  return `Moving this conversation into the durable kernel failed (${reason}). It is read-only; the original file is untouched.`;
}

/**
 * 这一轮交给谁。开关开着：迁移失败过的只读（拒绝）；其余（根会话、子会话、全新的会话）走新内核。
 * 开关关着：住在新内核里的会话拒绝（旧内核续写会让两边分叉），其余旧内核。
 */
export function routeFor(meta: SessionMeta | null, enabled: boolean): { to: TurnRoute } | { refuse: string } {
  if (!enabled) return meta?.durable === undefined ? { to: "legacy" } : { refuse: DURABLE_MOVED_MESSAGE };
  if (meta?.durable?.failed !== undefined) return { refuse: migrationFailedMessage(meta.durable.failed) };
  return { to: "kernel" };
}

/**
 * 本子编辑交给谁（开关开着）：住在新内核里的会话 → kernel（迁移失败过的只读，拒绝）；还没在新内核里跑过的旧会话
 * → 旧内核编辑 pi 本子（它下次发消息时按编辑后的本子迁，见 KernelPool 的指纹重迁）。
 */
export function editRouteFor(meta: SessionMeta | null, sessionId: string): KernelRoute | { refuse: string } {
  if (meta?.durable === undefined) return { to: "legacy" };
  if (meta.durable.failed !== undefined) return { refuse: migrationFailedMessage(meta.durable.failed) };
  return { to: "kernel", root: libraryRoot(meta, sessionId) };
}

/** 这条会话所在的树根（决定库）：子会话与父同库 */
export function libraryRoot(meta: SessionMeta | null, sessionId: string): string {
  return meta?.parentId ?? sessionId;
}

/**
 * 开轮交给新内核时的标记：第一次接手记 since；开着一轮置 running。resumed（重启后自动接着跑的子会话）只在
 * 那一次 continue 留着，下一次由人或父开的轮清掉。
 */
export function markRunning(current: DurableMark | undefined, now: number, keepResumed = false): DurableMark {
  const { resumed, stoppedOnQuit: _stoppedOnQuit, ...rest } = current ?? { since: now };
  return { ...rest, ...(keepResumed && resumed !== undefined ? { resumed } : {}), running: true };
}

/** 一轮落定：清 running；迁移那一步失败就记原因（会话回落只读）；应用退出时被停下的留着 running */
export function markSettled(current: DurableMark | undefined, result: KernelTurnResult, now: number): DurableMark {
  // 应用正常退出时被停下的轮：留着 running（下次打开是「上次被中断」），并记下「是正常退出停的」——重启后据此决定续不续
  if (!result.ok && result.interrupted === true) return { ...(current ?? { since: now }), running: true, stoppedOnQuit: true };
  const { running: _running, ...rest } = current ?? { since: now };
  return result.ok || result.migrationFailed !== true ? rest : { ...rest, failed: result.reason };
}

/** 应用重启时要自动接着跑的会话（resumePolicy 为 "resume" 的） */
export function sessionsToResume(metas: readonly SessionMeta[]): SessionMeta[] {
  return metas.filter((meta) => resumePolicy(meta) === "resume");
}

/** 主进程给 KernelHost 的依赖：会话 meta 的读与改、kernel 进程的拉起、孤儿善后 */
export interface KernelHostDeps {
  readMeta: (sessionId: string) => Promise<SessionMeta | null>;
  updateDurable: (sessionId: string, change: (current: DurableMark | undefined) => DurableMark | undefined) => Promise<void>;
  fork: () => KernelChild;
  reap: () => void;
  now?: () => number;
  /** 闲置回收的时长（缺席 = KERNEL_IDLE_RECYCLE_MS） */
  idleRecycleMs?: number;
}

/**
 * kernel 进程闲置多久回收：剧本要求碰过大会话后闲置 5 分钟常驻 ≤ 300 MB，进程的高水位不还给系统（V8 与分配器），
 * 只有结束进程才归零；2 分钟留了「刚答完又追问一句」的热身，又远在 5 分钟之内。
 */
const KERNEL_IDLE_RECYCLE_MS = 2 * 60 * 1000;

/** 开发 / 验收用：环境变量 ORBITA_KERNEL_IDLE_MS 覆盖回收时长（正整数毫秒；别的值不认） */
export function kernelIdleRecycleMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env["ORBITA_KERNEL_IDLE_MS"];
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value > 0 ? value : KERNEL_IDLE_RECYCLE_MS;
}

export class KernelHost {
  private readonly dir: string;

  /** dir：库目录（`<userData>/durable`） */
  constructor(dir: string) {
    this.dir = dir;
  }

  /**
   * 删一棵会话树的库文件、WAL 两个旁文件与墓碑（kernel 进程没开着这个库时用；开着时 host 先让它关库再删）。库不在也算成功。
   */
  async drop(library: string): Promise<void> {
    if (!KERNEL_LIBRARY_NAME.test(library)) throw new Error(`invalid library name "${library}"`);
    for (const suffix of ["", "-wal", "-shm", ".purge.json"]) await rm(join(this.dir, `${library}${suffix}`), { force: true });
  }

  /** 交给 AgentHost 的新内核那条道 */
  lane(deps: KernelHostDeps): KernelLane {
    const now = deps.now ?? Date.now;
    return {
      fork: deps.fork,
      dir: this.dir,
      route: async (command) => {
        const meta = await deps.readMeta(command.sessionId);
        const decision = routeFor(meta, true);
        if ("refuse" in decision) throw new Error(decision.refuse);
        if (decision.to === "legacy") return { to: "legacy" };
        // 全新的会话还没有 meta：首轮 created 之后由 ipc 建 meta 时带上标记（host.durableMark）
        if (meta !== null) await deps.updateDurable(command.sessionId, (current) => markRunning(current, now(), command.type === "continueRun"));
        return { to: "kernel", root: libraryRoot(meta, command.sessionId) };
      },
      editRoute: async (sessionId) => {
        const decision = editRouteFor(await deps.readMeta(sessionId), sessionId);
        if ("refuse" in decision) throw new Error(decision.refuse);
        return decision;
      },
      settled: (sessionId, result) => {
        void deps.updateDurable(sessionId, (current) => markSettled(current, result, now())).catch((cause: unknown) => console.error("[kernel] 落定标记没写上", sessionId, cause));
      },
      exited: () => deps.reap(),
      idleRecycleMs: deps.idleRecycleMs ?? KERNEL_IDLE_RECYCLE_MS,
    };
  }
}
