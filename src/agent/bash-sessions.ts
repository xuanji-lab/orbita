/**
 * bash 会话表 —— 交还给模型的长命令都挂在这里。
 *
 * **为什么要这张表**：签到点把一次阻塞的 bash 调用变成「进程还在跑、控制权已回到模型」
 * 的形态。工具调用已经返回，模型之后只能通过 `bash_poll` / `bash_stop` / `bash_list`
 * 跟它打交道，所以「进程 + 输出 + 退出码 + 寿命」必须有一个进程级的登记处，
 * 不能藏在某次 exec 的闭包里——那次调用的栈已经退了。
 *
 * **缓冲先丢头**：输出是流式的，模型要的是「最近发生了什么」（tail + 自上次以来的行数），
 * 不是全量。每条命令都可能跑几小时，全留会把 utility 进程的内存吃穿，而丢尾会把
 * 最有用的最后几行丢掉。所以环形缓冲只保留**尾部** 256 KB / 2000 行，先到的先丢。
 *
 * **会话的三种死法**（都由这里收尾）：寿命上限、模型显式 `bash_stop`、用户按停止
 * （原 turn 的 AbortSignal）。**没有一条是「到点就杀」**——到点只是签到，交还控制权。
 */
import type { ChildProcess } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

/** 每会话保留的字节上限。256 KB ≈ 一个长构建的一屏历史，够看趋势，不够撑爆内存。 */
export const TAIL_MAX_BYTES = 256 * 1024;
/** 每会话保留的行数上限。与字节上限先到先算——两种爆炸形态（超长单行 / 海量短行）都要挡 */
export const TAIL_MAX_LINES = 2000;
/** poll 回给模型的 tail 行数：只给最后 40 行，模型的判断依据是「走势」，不是全文 */
export const TAIL_LINES = 40;
/** 会话寿命上限：4 小时。这是兜底，不是使用方式——正常情况下模型会 poll / stop */
export const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
/** 同时存活的会话上限。每个都是一个真实的子进程树，不设上限就是资源耗尽 */
export const MAX_SESSIONS = 8;
/** 命令结束后会话还留多久可查：10 分钟。模型可能隔几轮才回来 poll 最后一个结果 */
export const SESSION_RETENTION_MS = 10 * 60 * 1000;
/** poll 的等待时间夹取范围（秒）：太短等于空转，太长模型又变成干等 */
export const POLL_MIN_WAIT_SECONDS = 1;
export const POLL_MAX_WAIT_SECONDS = 600;
/** poll 未指定等待时间的默认值（秒）：对齐签到间隔，模型不填也有一档合理等待 */
export const POLL_DEFAULT_WAIT_SECONDS = 120;

/** 会话结束的原因。只有这几种，界面上要能如实说「为什么没了」 */
export type SessionEndReason = "lifetime" | "stop" | "abort" | "shutdown";

function countNewlines(chunk: Buffer): number {
  let count = 0;
  for (let index = 0; index < chunk.length; index += 1) {
    if (chunk[index] === 0x0a) count += 1;
  }
  return count;
}

/**
 * 环形输出缓冲（只留尾部）。
 *
 * 丢弃单位是「字节 + 行」：先按字节截到 256 KB，再按行截到 2000 行。行截断必须落在
 * 换行之后，否则 tail 的第一行会是半句；字节截断允许落在行中间（256 KB 已经远超
 * 40 行，第一行半句不影响 tail 的可读性）。
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private byteCount = 0;
  private lineCount = 0;

  append(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.byteCount += chunk.length;
    this.lineCount += countNewlines(chunk);
    this.trim();
  }

  /** 累计写入的字节数（含已被丢弃的）——只给测试与诊断用，不参与「新增多少行」 */
  get bytes(): number {
    return this.byteCount;
  }

  get lines(): number {
    return this.lineCount;
  }

  /** 当前缓冲的全文。只在 poll / 测试里调用，长度已被上限封住 */
  text(): string {
    if (this.chunks.length === 0) return "";
    return Buffer.concat(this.chunks, this.byteCount).toString("utf8");
  }

  /** 最后 `maxLines` 行（不含结尾空行）。命令还在写半行时，那半行也算一行 */
  tail(maxLines: number): string {
    const text = this.text();
    if (text.length === 0) return "";
    const lines = text.split("\n");
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    if (lines.length <= maxLines) return lines.join("\n");
    return lines.slice(-maxLines).join("\n");
  }

  private trim(): void {
    if (this.byteCount <= TAIL_MAX_BYTES && this.lineCount <= TAIL_MAX_LINES) return;
    const all = Buffer.concat(this.chunks, this.byteCount);
    let start = Math.max(0, all.length - TAIL_MAX_BYTES);
    let dropLines = this.lineCount - TAIL_MAX_LINES;
    if (dropLines > 0) {
      let cursor = start;
      while (dropLines > 0) {
        const newline = all.indexOf(0x0a, cursor);
        if (newline === -1) {
          cursor = all.length;
          break;
        }
        cursor = newline + 1;
        dropLines -= 1;
      }
      if (cursor > start) start = cursor;
    }
    // Buffer.from 复制一份：subarray 会继续引用 trim 前的整块内存，等于没释放
    const kept = all.length - start > 0 ? Buffer.from(all.subarray(start)) : Buffer.alloc(0);
    this.chunks = kept.length > 0 ? [kept] : [];
    this.byteCount = kept.length;
    this.lineCount = countNewlines(kept);
  }
}

/** poll / stop 返回给工具层的快照。`newLines` 是「自上次 poll 以来」的增量 */
export interface SessionSnapshot {
  id: string;
  status: "running" | "finished" | "killed" | "too-old";
  exitCode: number | null;
  startedAt: number;
  lastDataAt: number;
  endedAt?: number;
  elapsedMs: number;
  idleMs: number;
  newLines: number;
  tail: string;
  endReason?: SessionEndReason;
}

/** `bash_list` 用的摘要：不消费「自上次 poll 以来」的行号 */
export interface SessionSummary {
  id: string;
  status: "running" | "finished" | "killed";
  exitCode: number | null;
  elapsedMs: number;
  idleMs: number;
  endedAt?: number;
  endReason?: SessionEndReason;
}

interface SessionInit {
  id: string;
  /** 归属（Orbita 会话 id）。同一个 utility 进程跑着多条会话，不能互相看见/停掉对方的命令 */
  owner?: string;
  child: ChildProcess;
  buffer: TailBuffer;
  startedAt: number;
  lastDataAt: number;
  signal?: AbortSignal;
  killTree: () => void;
  lifetimeMs: number;
  retentionMs: number;
}

/**
 * 一个被交还的长命令。
 *
 * `killTree` 由执行层注入：会话层只管生命周期，不碰平台差异（Windows taskkill /
 * POSIX 进程组）。这样 bash-sessions 可以单独测，不必真的 spawn。
 */
export class BashSession {
  readonly id: string;
  readonly owner: string | undefined;
  readonly child: ChildProcess;
  readonly buffer: TailBuffer;
  readonly startedAt: number;

  private lastDataAtValue: number;
  private exitCodeValue: number | null = null;
  private endedAtValue: number | undefined;
  private killedValue = false;
  private endReasonValue: SessionEndReason | undefined;
  private readonly signal: AbortSignal | undefined;
  private readonly killTree: () => void;
  private readonly retentionMs: number;
  private totalLinesValue: number;
  private polledLinesValue: number;
  /** poll 在等「新输出 / 结束」；两个集合分开，否则有输出会把「等结束」也唤醒 */
  private readonly changeWaiters = new Set<() => void>();
  private readonly endWaiters = new Set<() => void>();
  private lifetimeTimer: NodeJS.Timeout | undefined;
  private retentionTimer: NodeJS.Timeout | undefined;
  private readonly onAbort: () => void;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.owner = init.owner;
    this.child = init.child;
    this.buffer = init.buffer;
    this.startedAt = init.startedAt;
    this.lastDataAtValue = init.lastDataAt;
    this.signal = init.signal;
    this.killTree = init.killTree;
    this.retentionMs = init.retentionMs;
    this.totalLinesValue = init.buffer.lines;
    // 签到前模型已经看过这段输出（它在工具结果里），第一次 poll 只该报之后的增量
    this.polledLinesValue = init.buffer.lines;
    this.onAbort = () => this.kill("abort");
    if (init.signal !== undefined && !init.signal.aborted) {
      init.signal.addEventListener("abort", this.onAbort, { once: true });
    }
    // 寿命上限是最后一道兜底：模型跑偏、会话被弃、没人 poll 时，进程树不能永远留着。
    // 从 spawn 算起（不是从签到算起）：「命令最长寿命」说的是这条命令跑了多久。
    // unref：这只是兜底定时器，不该单独把 utility 进程续命
    if (init.lifetimeMs > 0 && Number.isFinite(init.lifetimeMs)) {
      const remaining = Math.max(0, init.lifetimeMs - (Date.now() - init.startedAt));
      this.lifetimeTimer = setTimeout(() => {
        this.lifetimeTimer = undefined;
        this.kill("lifetime");
      }, remaining);
      this.lifetimeTimer.unref();
    }
  }

  get lastDataAt(): number {
    return this.lastDataAtValue;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  get endedAt(): number | undefined {
    return this.endedAtValue;
  }

  get killed(): boolean {
    return this.killedValue;
  }

  get endReason(): SessionEndReason | undefined {
    return this.endReasonValue;
  }

  get totalLines(): number {
    return this.totalLinesValue;
  }

  /** 上次 poll 之后还没有被取走的行数。0 表示模型已经看过了当前全部输出 */
  get unreadLines(): number {
    return this.totalLinesValue - this.polledLinesValue;
  }

  /** 命令又吐了一块：进缓冲、刷新 idle、叫醒 poll 的等待者 */
  append(chunk: Buffer): void {
    this.buffer.append(chunk);
    this.totalLinesValue += countNewlines(chunk);
    this.lastDataAtValue = Date.now();
    this.notifyChange();
  }

  /** 杀进程树（幂等）。结束事件仍由执行层观察到子进程退出后调 `end()` */
  kill(reason: SessionEndReason): void {
    if (this.endedAtValue !== undefined || this.killedValue) return;
    this.killedValue = true;
    this.endReasonValue = reason;
    if (reason === "lifetime") {
      // 这条会进缓冲：模型下次 poll 的 tail 里看得见「为什么没了」，而不是只有一句
      // 冷冰冰的 exitCode。stop / abort 不需要——调用方当场就拿到结果
      const notice =
        "\n[orbita] kind=cap reason=lifetime | " +
        "The command reached the session lifetime limit and was stopped. " +
        "Its remaining work is lost; run it again in smaller steps if you still need the result.\n";
      this.append(Buffer.from(notice, "utf8"));
    }
    this.killTree();
    this.notifyChange();
  }

  /** 子进程真的退出了：记录退出码、解除监听、安排 10 分钟后的 GC */
  end(exitCode: number | null): void {
    if (this.endedAtValue !== undefined) return;
    this.endedAtValue = Date.now();
    this.exitCodeValue = exitCode;
    this.clearLifetimeTimer();
    if (this.signal !== undefined) this.signal.removeEventListener("abort", this.onAbort);
    if (this.retentionMs > 0 && Number.isFinite(this.retentionMs)) {
      this.retentionTimer = setTimeout(() => {
        this.retentionTimer = undefined;
        if (sessions.get(this.id) === this) sessions.delete(this.id);
      }, this.retentionMs);
      // 完成后还要留 10 分钟可查，但别为这条保留把整个进程续命
      this.retentionTimer.unref();
    }
    this.notifyChange();
    for (const waiter of [...this.endWaiters]) waiter();
    this.endWaiters.clear();
  }

  /** 等「有新输出 / 状态变了 / 结束」——poll 的提前返回靠它 */
  waitForChange(waitMs: number): Promise<void> {
    if (waitMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.changeWaiters.delete(done);
        resolve();
      };
      this.changeWaiters.add(done);
      timer = setTimeout(done, waitMs);
    });
  }

  /** 等真正的结束（stop 要返回最终退出码，而不是「刚发完 taskkill」） */
  waitForEnd(waitMs: number): Promise<void> {
    if (this.endedAtValue !== undefined) return Promise.resolve();
    if (waitMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = () => {
        if (timer !== undefined) clearTimeout(timer);
        this.endWaiters.delete(done);
        resolve();
      };
      this.endWaiters.add(done);
      timer = setTimeout(done, waitMs);
    });
  }

  /** 消费「自上次 poll 以来的行数」并出快照 */
  takeSnapshot(): SessionSnapshot {
    const now = Date.now();
    const newLines = this.totalLinesValue - this.polledLinesValue;
    this.polledLinesValue = this.totalLinesValue;
    // 已结束的会话报「跑了多久」，不是「从开始到现在」——后者在 10 分钟保留期里
    // 会一直长下去，模型看到一条早已结束的命令 elapsed 还在涨会以为它还在跑
    const elapsedUntil = this.endedAtValue ?? now;
    const snapshot: SessionSnapshot = {
      id: this.id,
      status: this.status(),
      exitCode: this.exitCodeValue,
      startedAt: this.startedAt,
      lastDataAt: this.lastDataAtValue,
      elapsedMs: Math.max(0, elapsedUntil - this.startedAt),
      idleMs: Math.max(0, elapsedUntil - this.lastDataAtValue),
      newLines,
      tail: this.buffer.tail(TAIL_LINES),
    };
    if (this.endedAtValue !== undefined) snapshot.endedAt = this.endedAtValue;
    if (this.endReasonValue !== undefined) snapshot.endReason = this.endReasonValue;
    return snapshot;
  }

  summary(): SessionSummary {
    const elapsedUntil = this.endedAtValue ?? Date.now();
    const summary: SessionSummary = {
      id: this.id,
      status: this.status(),
      exitCode: this.exitCodeValue,
      elapsedMs: Math.max(0, elapsedUntil - this.startedAt),
      idleMs: Math.max(0, elapsedUntil - this.lastDataAtValue),
    };
    if (this.endedAtValue !== undefined) summary.endedAt = this.endedAtValue;
    if (this.endReasonValue !== undefined) summary.endReason = this.endReasonValue;
    return summary;
  }

  /** 退出清理：把还会触发的定时器收掉，免得在进程收尾时再杀一次已清的会话 */
  dropTimers(): void {
    this.clearLifetimeTimer();
    if (this.retentionTimer !== undefined) {
      clearTimeout(this.retentionTimer);
      this.retentionTimer = undefined;
    }
  }

  /**
   * 进程收尾 / 整表清空时调用：摘掉 abort 监听再撤定时器。
   * 不摘的话，长命的 turn signal 会一直攥着一个已经被丢弃的会话。
   */
  release(): void {
    if (this.signal !== undefined) this.signal.removeEventListener("abort", this.onAbort);
    this.dropTimers();
  }

  private status(): "running" | "finished" | "killed" {
    if (this.killedValue) return "killed";
    if (this.endedAtValue !== undefined) return "finished";
    return "running";
  }

  private notifyChange(): void {
    for (const waiter of [...this.changeWaiters]) waiter();
    this.changeWaiters.clear();
  }

  private clearLifetimeTimer(): void {
    if (this.lifetimeTimer !== undefined) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
  }
}

const sessions = new Map<string, BashSession>();
let nextSessionNumber = 0;

export interface RegisterSessionInput {
  child: ChildProcess;
  /** 从 spawn 起就在写的缓冲：签到前的输出也在里面，第一次 poll 的 tail 才完整 */
  buffer: TailBuffer;
  startedAt: number;
  lastDataAt: number;
  signal?: AbortSignal;
  /** 归属（Orbita 会话 id）：list / poll / stop 只认自己这条会话的 */
  owner?: string;
  /** 杀进程树。执行层注入，会话层不直接依赖平台细节 */
  killTree: () => void;
  lifetimeMs?: number;
  maxSessions?: number;
  retentionMs?: number;
}

export type RegisterSessionResult =
  | { ok: true; session: BashSession }
  | { ok: false; message: string };

/** 签到成功，登记成 b1 / b2 / …。并发满了就拒绝——由调用方杀掉命令并如实报错 */
export function registerSession(input: RegisterSessionInput): RegisterSessionResult {
  const maxSessions = input.maxSessions ?? MAX_SESSIONS;
  // 按归属计数：别的会话占满预算不该让这一条被拒（A 的 8 个命令不该堵住 B）
  const running = [...sessions.values()].filter(
    (session) => session.endedAt === undefined && session.owner === input.owner,
  ).length;
  if (running >= maxSessions) {
    // 不静默：调用方会把这句话当工具错误给模型看，它才知道是「表满了」而不是「命令挂了」
    return {
      ok: false,
      message:
        `Too many detached bash sessions are already running (max ${maxSessions}). ` +
        "This command was stopped at its check-in point. Wait for one to finish, " +
        "or end one with bash_stop, then run this command again.",
    };
  }
  nextSessionNumber += 1;
  const session = new BashSession({
    id: `b${nextSessionNumber}`,
    owner: input.owner,
    child: input.child,
    buffer: input.buffer,
    startedAt: input.startedAt,
    lastDataAt: input.lastDataAt,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    killTree: input.killTree,
    lifetimeMs: input.lifetimeMs ?? SESSION_LIFETIME_MS,
    retentionMs: input.retentionMs ?? SESSION_RETENTION_MS,
  });
  sessions.set(session.id, session);
  return { ok: true, session };
}

function goneSnapshot(id: string): SessionSnapshot {
  return {
    id,
    status: "too-old",
    exitCode: null,
    startedAt: 0,
    lastDataAt: 0,
    elapsedMs: 0,
    idleMs: 0,
    newLines: 0,
    tail: "",
  };
}

/**
 * 等新输出 / 等结束 / 等满 `waitMs`，先到先返回。
 *
 * **不存在的 id 不抛错**：这是模型会犯的错（记错 id、会话早已 GC），返回一句可读的
 * `too-old` 比一条栈更适合它自救。
 */
export async function pollSession(id: string, waitMs: number, owner?: string): Promise<SessionSnapshot> {
  const session = ownedSession(id, owner);
  if (session === undefined) return goneSnapshot(id);
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    if (session.endedAt !== undefined) break;
    // 上次 poll 之后已经有新输出：不必再等，模型要的就是「变了就告诉我」
    if (session.unreadLines > 0) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await session.waitForChange(remaining);
  }
  return session.takeSnapshot();
}

/** 杀一个会话并等它真的结束（Windows taskkill /F /T 是同步的，通常几毫秒就退出） */
export async function stopSession(
  id: string,
  waitMs = 3000,
  owner?: string,
): Promise<SessionSnapshot | null> {
  const session = ownedSession(id, owner);
  if (session === undefined) return null;
  if (session.endedAt === undefined) {
    session.kill("stop");
    await session.waitForEnd(waitMs);
  }
  return session.takeSnapshot();
}

/**
 * 按归属取会话。**不是自己这条 Orbita 会话的 id 一律当作不存在**——同一个 utility 进程
 * 里跑着多条会话，A 的 bash_stop 不该能停掉 B 正在跑的构建。
 */
function ownedSession(id: string, owner: string | undefined): BashSession | undefined {
  const session = sessions.get(id);
  if (session === undefined) return undefined;
  if (owner === undefined) return session;
  return session.owner === owner ? session : undefined;
}

/** `bash_list` 的数据源。不消费行号、不返回 tail（列表只回答「有哪些、还活着吗」） */
export function listSessions(owner?: string): SessionSummary[] {
  return [...sessions.values()]
    .filter((session) => owner === undefined || session.owner === owner)
    .map((session) => session.summary());
}

/** 进程退出 / 测试收尾：所有会话的进程树一起收，定时器清干净 */
export function killAllSessions(): void {
  for (const session of sessions.values()) {
    session.kill("shutdown");
    session.release();
  }
  sessions.clear();
}

/* ------------------------------------------------------------------ *
 * 三个句柄工具（注册进 runtime 的 customTools）
 *
 * 描述就是给模型的说明书：说清「什么时候该用」，而不只是「参数是什么」。
 * ------------------------------------------------------------------ */

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
}

function reasonText(reason: SessionEndReason): string {
  switch (reason) {
    case "lifetime":
      return "lifetime limit reached — the command was terminated because it ran past the session lifetime cap";
    case "stop":
      return "stopped by bash_stop";
    case "abort":
      return "the turn was aborted (the user stopped it)";
    case "shutdown":
      return "stopped while the app was shutting down";
  }
}

function formatPoll(snapshot: SessionSnapshot): string {
  if (snapshot.status === "too-old") {
    return (
      "status: too-old\n" +
      `That session (${snapshot.id || "unknown"}) is gone (finished more than 10 minutes ago). ` +
      "Run bash_list to see the sessions that are still available."
    );
  }
  const lines = [
    `status: ${snapshot.status}`,
    `session: ${snapshot.id}`,
    `exitCode: ${snapshot.exitCode === null ? "none" : snapshot.exitCode}`,
    `elapsed: ${formatDuration(snapshot.elapsedMs)}`,
    `idleSeconds: ${Math.round(snapshot.idleMs / 1000)}`,
    `+${snapshot.newLines} lines since last poll`,
  ];
  if (snapshot.endReason !== undefined) lines.push(`endReason: ${reasonText(snapshot.endReason)}`);
  lines.push(`tail (last ${TAIL_LINES} lines):`);
  lines.push(snapshot.tail.length > 0 ? snapshot.tail : "(no output yet)");
  return lines.join("\n");
}

function readSessionId(params: unknown): string {
  if (typeof params !== "object" || params === null) return "";
  const value = (params as Record<string, unknown>)["sessionId"];
  return typeof value === "string" ? value.trim() : "";
}

export function createBashHandleTools(owner?: string): ToolDefinition[] {
  const poll: ToolDefinition = {
    name: "bash_poll",
    label: "bash_poll",
    description:
      "Read a long bash command that was detached at its check-in point (bash returns a sessionId like b1). " +
      "Returns status, exitCode, elapsed, idleSeconds (time since the last output), how many lines are new since " +
      "your previous poll, and the last 40 lines. It returns early as soon as new output arrives or the command " +
      "exits; otherwise it waits up to waitSeconds. Use a large waitSeconds (e.g. 300) instead of polling in a loop.",
    parameters: {
      type: "object",
      properties: {
        sessionId: {
          type: "string",
          description: "Session id from the bash result that was detached (e.g. \"b1\").",
        },
        waitSeconds: {
          type: "number",
          description:
            "How long to wait for new output, in seconds (default 120, clamped to 1-600). " +
            "Returns earlier when there is new output or the command exits.",
        },
      },
      required: ["sessionId"],
    } as never,
    async execute(_toolCallId, params) {
      const id = readSessionId(params);
      if (id.length === 0) {
        return {
          content: [{ type: "text", text: "bash_poll needs a sessionId, for example \"b1\". Run bash_list to see them." }],
          details: undefined,
        };
      }
      const rawWait = typeof params === "object" && params !== null
        ? (params as Record<string, unknown>)["waitSeconds"]
        : undefined;
      const requested = typeof rawWait === "number" && Number.isFinite(rawWait) ? rawWait : POLL_DEFAULT_WAIT_SECONDS;
      const waitSeconds = Math.min(POLL_MAX_WAIT_SECONDS, Math.max(POLL_MIN_WAIT_SECONDS, requested));
      const snapshot = await pollSession(id, waitSeconds * 1000, owner);
      return { content: [{ type: "text", text: formatPoll(snapshot) }], details: undefined };
    },
  };

  const stop: ToolDefinition = {
    name: "bash_stop",
    label: "bash_stop",
    description:
      "Stop a detached bash command and kill its whole process tree. Use it when you have seen enough, or when " +
      "the command is clearly stuck and its work is not worth waiting for. Returns the final status and the last " +
      "40 lines. Prefer this over leaving a session to die of old age.",
    parameters: {
      type: "object",
      properties: {
        sessionId: { type: "string", description: "Session id to stop (e.g. \"b1\")." },
      },
      required: ["sessionId"],
    } as never,
    async execute(_toolCallId, params) {
      const id = readSessionId(params);
      if (id.length === 0) {
        return {
          content: [{ type: "text", text: "bash_stop needs a sessionId, for example \"b1\". Run bash_list to see them." }],
          details: undefined,
        };
      }
      const snapshot = await stopSession(id, 3000, owner);
      if (snapshot === null) {
        return {
          content: [
            {
              type: "text",
              text: `bash_stop: no session ${id}. It is gone (finished more than 10 minutes ago) or was never created. Run bash_list to see the sessions that are still available.`,
            },
          ],
          details: undefined,
        };
      }
      return { content: [{ type: "text", text: formatPoll(snapshot) }], details: undefined };
    },
  };

  const list: ToolDefinition = {
    name: "bash_list",
    label: "bash_list",
    description:
      "List the detached bash sessions: id, whether it is still running, how long it has been running, and how " +
      "long since its last output. Use it when you lost track of a sessionId, or to decide which session to poll " +
      "or stop.",
    parameters: {
      type: "object",
      properties: {},
    } as never,
    async execute() {
      const summaries = listSessions(owner);
      if (summaries.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                "No bash sessions. A long command appears here after bash detaches it at the 5-minute check-in; " +
                "short commands finish in the normal tool result.",
            },
          ],
          details: undefined,
        };
      }
      const lines = summaries.map((summary) => {
        const exit = summary.exitCode === null ? "" : ` exit=${summary.exitCode}`;
        const reason = summary.endReason === undefined ? "" : ` (${reasonText(summary.endReason)})`;
        return `${summary.id} ${summary.status} elapsed=${formatDuration(summary.elapsedMs)} idle=${formatDuration(summary.idleMs)}${exit}${reason}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  };

  return [poll, stop, list];
}
