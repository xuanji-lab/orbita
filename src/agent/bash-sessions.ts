/**
 * bash 会话表 —— 交还给模型的长命令都挂在这里。
 *
 * **为什么要这张表**：签到点把一次阻塞的 bash 调用变成「进程还在跑、控制权已回到模型」
 * 的形态。工具调用已经返回，模型之后只能通过 `bash_list` / `bash_stop` 跟它打交道，
 * 所以「进程 + 输出 + 退出码 + 寿命」必须有一个进程级的登记处，不能藏在某次 exec
 * 的闭包里——那次调用的栈已经退了。
 *
 * **结果怎么回到对话**：会话结束（自然退出 / 被停 / 寿命到）时 `onEnd` 恰好被调一次，
 * 把命令全文、退出码、尾部输出、结束原因与耗时交给 runtime；runtime 负责写进 pi 的
 * 会话本子与 orbita 转录（见 runtime 的 deliverBashSessionEnd）。**没有轮询**：
 * 模型不再决定「等多久、要不要再看」。
 *
 * **缓冲先丢头**：输出是流式的，模型要的是「最后发生了什么」，不是全量。每条命令
 * 都可能跑几小时，全留会把 utility 进程的内存吃穿，而丢尾会把最有用的最后几行丢掉。
 * 所以环形缓冲只保留**尾部** 256 KB / 2000 行，先到的先丢。
 *
 * **会话的四种死法**（都由这里收尾）：寿命上限、模型显式 `bash_stop`、用户按停止
 * （原 turn 的 AbortSignal）、应用退出。**没有一条是「到点就杀」**——到点只是签到，
 * 交还控制权；结束之后结果自动写回。
 */
import type { ChildProcess } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  formatBashDuration,
  type BashSessionEndReason,
} from "../shared/bash-session.ts";

/** 每会话保留的字节上限。256 KB ≈ 一个长构建的一屏历史，够看趋势，不够撑爆内存。 */
export const TAIL_MAX_BYTES = 256 * 1024;
/** 每会话保留的行数上限。与字节上限先到先算——两种爆炸形态（超长单行 / 海量短行）都要挡 */
export const TAIL_MAX_LINES = 2000;
/** 写回对话的结果取尾部多少行：结果进模型上下文，全给 2000 行太贵，200 行够看结局 */
export const RESULT_TAIL_LINES = 200;
/** `bash_stop` / `bash_list` 给模型的 tail 行数：看走势，不看全文 */
export const TOOL_TAIL_LINES = 40;
/**
 * 会话寿命的**最后兜底**：4 小时。线上由执行层按调用传入——模型显式声明 timeout 的用它的值，
 * 其余用设置里的「命令最长寿命」（默认也是 4 小时）。这是兜底，不是使用方式。
 */
export const SESSION_LIFETIME_MS = 4 * 60 * 60 * 1000;
/** 命令结束后会话还留多久可查：10 分钟。模型可能隔几轮才回来 bash_list 看一眼 */
export const SESSION_RETENTION_MS = 10 * 60 * 1000;
/** 杀掉之后等子进程真正退出的时限。超时仍没收到退出事件，也照样结一次结果（不吞记录） */
const KILL_SETTLE_MS = 3_000;

/** 会话结束的原因。取值与 `shared/bash-session.ts` 同一份（那是界面与 agent 共用的契约） */
export type SessionEndReason = BashSessionEndReason;

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
 * 结果行数，第一行半句不影响可读性）。
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

  /** 累计写入的字节数（含已被丢弃的）——只给测试与诊断用 */
  get bytes(): number {
    return this.byteCount;
  }

  get lines(): number {
    return this.lineCount;
  }

  /** 当前缓冲的全文。长度已被上限封住 */
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

/** 会话结束时交给 runtime 的一份事实（写回对话与自动起一轮都用它） */
export interface BashSessionEnd {
  id: string;
  /** 命令全文：会话记录里必须有，否则 bash_list 与结果文案都说不清「这条是什么」 */
  command: string;
  /** 发起它的那次工具调用（渲染层按它把结果挂回 detach 那一行）。缺席 = 没接上，不猜 */
  toolCallId?: string;
  status: "finished" | "killed";
  exitCode: number | null;
  elapsedMs: number;
  /** 尾部输出（最多 RESULT_TAIL_LINES 行） */
  output: string;
  endReason?: SessionEndReason;
  /** 被停 / 寿命 / 停轮 / 退出应用 → true（pi 的 BashResult.cancelled 语义） */
  cancelled: boolean;
}

/** `bash_list` 用的摘要 */
export interface SessionSummary {
  id: string;
  command: string;
  /** 发起它的那次工具调用（未绑上时缺席） */
  toolCallId?: string;
  status: "running" | "finished" | "killed";
  exitCode: number | null;
  elapsedMs: number;
  idleMs: number;
  /**
   * 这条会话的寿命上限（秒）。显式声明 timeout 的会话是那个值，其余是设置里的
   * 「命令最长寿命」。界面 / 结果文案靠它说「上限是多少」——不再写死 4 小时。
   */
  lifetimeSeconds: number;
  endedAt?: number;
  endReason?: SessionEndReason;
}

interface SessionInit {
  id: string;
  /** 归属（Orbita 会话 id）。同一个 utility 进程跑着多条会话，不能互相看见/停掉对方的命令 */
  owner?: string;
  command: string;
  child: ChildProcess;
  buffer: TailBuffer;
  startedAt: number;
  lastDataAt: number;
  signal?: AbortSignal;
  killTree: () => void;
  lifetimeMs: number;
  retentionMs: number;
  /** 结束回调（恰好一次）。runtime 用它写回对话；抛错只记日志，不吞结束事实 */
  onEnd?: (result: BashSessionEnd) => void;
  /** 杀掉之后等退出事件的时限（测试压到毫秒级） */
  killSettleMs: number;
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
  readonly command: string;
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
  private readonly onEnd: ((result: BashSessionEnd) => void) | undefined;
  private readonly killSettleMs: number;
  /**
   * 寿命上限。**从 spawn 算起**（不是从签到算起）：「命令最长寿命」说的是这条命令跑了多久。
   * 显式声明 timeout 的命令就是那个值（模型自己的上界要被尊重），否则是设置里的默认寿命。
   */
  readonly lifetimeMs: number;
  private toolCallIdValue: string | undefined;
  private endNotified = false;
  private endWaiters = new Set<() => void>();
  private lifetimeTimer: NodeJS.Timeout | undefined;
  private retentionTimer: NodeJS.Timeout | undefined;
  private readonly onAbort: () => void;

  constructor(init: SessionInit) {
    this.id = init.id;
    this.owner = init.owner;
    this.command = init.command;
    this.child = init.child;
    this.buffer = init.buffer;
    this.startedAt = init.startedAt;
    this.lastDataAtValue = init.lastDataAt;
    this.signal = init.signal;
    this.killTree = init.killTree;
    this.retentionMs = init.retentionMs;
    this.onEnd = init.onEnd;
    this.killSettleMs = init.killSettleMs;
    this.lifetimeMs = init.lifetimeMs;
    this.onAbort = () => this.kill("abort");
    if (init.signal !== undefined && !init.signal.aborted) {
      init.signal.addEventListener("abort", this.onAbort, { once: true });
    }
    // 寿命上限是最后一道兜底：模型跑偏、会话被弃时，进程树不能永远留着。
    // 从 spawn 算起；unref：这只是兜底定时器，不该单独把 utility 进程续命
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

  get toolCallId(): string | undefined {
    return this.toolCallIdValue;
  }

  /** 工具调用交还之后执行层把 toolCallId 绑上来：结果才能挂回同一行 */
  bindToolCall(toolCallId: string): void {
    this.toolCallIdValue = toolCallId;
  }

  /** 命令又吐了一块：进缓冲、刷新 idle */
  append(chunk: Buffer): void {
    this.buffer.append(chunk);
    this.lastDataAtValue = Date.now();
  }

  /** 杀进程树（幂等）。结束事件仍由执行层观察到子进程退出后调 `end()` */
  kill(reason: SessionEndReason): void {
    if (this.endedAtValue !== undefined || this.killedValue) return;
    this.killedValue = true;
    this.endReasonValue = reason;
    if (reason === "lifetime") {
      // 这条会进结果输出：模型看得到「为什么没了、上限是多少」，而不是只有一个退出码
      const notice =
        `\n[orbita] The command reached its ${formatBashDuration(this.lifetimeMs)} session lifetime limit and was stopped. ` +
        "Its remaining work is lost; run it again in smaller steps if you still need the result.\n";
      this.append(Buffer.from(notice, "utf8"));
    }
    this.killTree();
    // 进程没在时限内退出也要落一次结果：杀树之后「命令已经结束」是事实，
    // 不能因为没等到 exit 事件就把这条记录吞掉（onEnd 幂等，晚到的 exit 不会再调）
    const settle = setTimeout(() => this.end(null), this.killSettleMs);
    settle.unref();
  }

  /** 子进程真的退出了：记录退出码、解除监听、安排 10 分钟后的 GC、交出结果 */
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
    for (const waiter of [...this.endWaiters]) waiter();
    this.endWaiters.clear();
    this.notifyEnd();
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

  summary(): SessionSummary {
    const elapsedUntil = this.endedAtValue ?? Date.now();
    const summary: SessionSummary = {
      id: this.id,
      command: this.command,
      status: this.status(),
      exitCode: this.exitCodeValue,
      elapsedMs: Math.max(0, elapsedUntil - this.startedAt),
      idleMs: Math.max(0, elapsedUntil - this.lastDataAtValue),
      lifetimeSeconds: Math.max(0, Math.round(this.lifetimeMs / 1000)),
    };
    if (this.endedAtValue !== undefined) summary.endedAt = this.endedAtValue;
    if (this.endReasonValue !== undefined) summary.endReason = this.endReasonValue;
    if (this.toolCallIdValue !== undefined) summary.toolCallId = this.toolCallIdValue;
    return summary;
  }

  /** 尾部输出（结果写回对话用） */
  tail(maxLines: number = RESULT_TAIL_LINES): string {
    return this.buffer.tail(maxLines);
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

  private clearLifetimeTimer(): void {
    if (this.lifetimeTimer !== undefined) {
      clearTimeout(this.lifetimeTimer);
      this.lifetimeTimer = undefined;
    }
  }

  /**
   * 把结束事实交给 runtime（恰好一次）。
   * 回调抛错只记日志：结束是事实，写回对话失败不该把它抹掉。
   */
  private notifyEnd(): void {
    if (this.endNotified || this.onEnd === undefined) return;
    this.endNotified = true;
    const endedAt = this.endedAtValue ?? Date.now();
    const result: BashSessionEnd = {
      id: this.id,
      command: this.command,
      status: this.status() === "killed" ? "killed" : "finished",
      exitCode: this.exitCodeValue,
      elapsedMs: Math.max(0, endedAt - this.startedAt),
      output: this.tail(),
      cancelled: this.killedValue,
    };
    if (this.toolCallIdValue !== undefined) result.toolCallId = this.toolCallIdValue;
    if (this.endReasonValue !== undefined) result.endReason = this.endReasonValue;
    try {
      this.onEnd(result);
    } catch (cause) {
      console.error(`[bash-sessions] 结束回调抛错（${this.id}）`, cause);
    }
  }
}

const sessions = new Map<string, BashSession>();
let nextSessionNumber = 0;

export interface RegisterSessionInput {
  child: ChildProcess;
  /** 命令全文。会话记录与写回文案都要它 */
  command: string;
  /** 从 spawn 起就在写的缓冲：签到前的输出也在里面，结果里的 tail 才完整 */
  buffer: TailBuffer;
  startedAt: number;
  lastDataAt: number;
  signal?: AbortSignal;
  /** 归属（Orbita 会话 id）：list / stop 只认自己这条会话的 */
  owner?: string;
  /** 杀进程树。执行层注入，会话层不直接依赖平台细节 */
  killTree: () => void;
  /** 结束回调（恰好一次） */
  onEnd?: (result: BashSessionEnd) => void;
  lifetimeMs?: number;
  retentionMs?: number;
  /** 杀掉之后等退出事件的时限，默认 3 秒；测试压到毫秒级 */
  killSettleMs?: number;
}

/** 签到成功，登记成 b1 / b2 / …。**不限并发**：上限是资源事实，不该由一张表替用户拒绝 */
export function registerSession(input: RegisterSessionInput): BashSession {
  nextSessionNumber += 1;
  const session = new BashSession({
    id: `b${nextSessionNumber}`,
    command: input.command,
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    child: input.child,
    buffer: input.buffer,
    startedAt: input.startedAt,
    lastDataAt: input.lastDataAt,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    killTree: input.killTree,
    ...(input.onEnd === undefined ? {} : { onEnd: input.onEnd }),
    lifetimeMs: input.lifetimeMs ?? SESSION_LIFETIME_MS,
    retentionMs: input.retentionMs ?? SESSION_RETENTION_MS,
    killSettleMs: input.killSettleMs ?? KILL_SETTLE_MS,
  });
  sessions.set(session.id, session);
  return session;
}

/**
 * 把「一次工具调用」与「一个后台会话」绑起来（执行层在 detach 工具返回后调）。
 * 回执到达时会话可能已经结束了（极短的命令），所以绑定成功后立即回填——
 * 结果只需要 toolCallId，不需要等到结束。
 */
export function bindBashSessionToolCall(sessionId: string, toolCallId: string): void {
  sessions.get(sessionId)?.bindToolCall(toolCallId);
}

/**
 * 杀一个会话并等它真的结束（Windows taskkill /F /T 是同步的，通常几毫秒就退出）。
 * 返回结束后的摘要；不存在的 id 返回 null（调用方给一句可读说明，不抛错）。
 */
export async function stopSession(
  id: string,
  waitMs = KILL_SETTLE_MS,
  owner?: string,
): Promise<SessionSummary | null> {
  const session = ownedSession(id, owner);
  if (session === undefined) return null;
  if (session.endedAt === undefined) {
    session.kill("stop");
    await session.waitForEnd(waitMs);
    // 时限内没等到 exit 事件也照样结一次：结果要写回对话（end 幂等）
    if (session.endedAt === undefined) session.end(null);
  }
  return session.summary();
}

/**
 * 按归属收尾：把这条 Orbita 会话名下的 bash 会话全部停掉（删会话时用）。
 *
 * **为什么不是 killAllSessions**：同一个 utility 进程里还跑着别的会话的命令，
 * 删 A 不该带走 B 的构建。这里只碰 `owner === owner` 的行。
 *
 * 返回真正被停掉的条数（只给日志与测试断言用）。
 */
export async function stopOwnedSessions(owner: string, waitMs = 0): Promise<number> {
  const owned = [...sessions.values()].filter(
    (session) => session.owner === owner && session.endedAt === undefined && !session.killed,
  );
  for (const session of owned) await stopSession(session.id, waitMs, owner);
  return owned.length;
}

/**
 * 下一条用户消息里的提醒（回合结束后仍有后台命令在跑）。
 *
 * **一句、只报状态快照**：不替模型做决定，也不起定时器——提醒的时机是「用户又说话了」，
 * 那正是模型该知道后台还有活的时候。结果会自动写回，所以这里只让它别把这条当成丢了。
 * 没有 running 会话返回 null（调用方原样拼进 prompt，不多占一行）。
 */
export function bashSessionReminder(summaries: readonly SessionSummary[]): string | null {
  const running = summaries.filter((summary) => summary.status === "running");
  if (running.length === 0) return null;
  const facts = running
    .map((summary) => `${summary.id} (running ${formatBashDuration(summary.elapsedMs)}, no output for ${formatBashDuration(summary.idleMs)})`)
    .join(", ");
  const which = running.length === 1 ? `background bash session ${facts}` : `background bash sessions ${facts}`;
  return (
    `[orbita] notice: ${which} still running from an earlier turn. ` +
    "Its result will be written back when it finishes; check bash_list, end it with bash_stop."
  );
}

/**
 * 把提醒拼到这一轮的用户消息末尾。**没有 running 会话时逐字返回原 prompt**——
 * 大多数轮没有后台命令，那些轮的消息内容不该多一个字符（provider 的前缀缓存与
 * 转录回放都按原话对账）。多个会话合并成**一句**：三行提醒会把用户的号令隔开。
 */
export function withBashReminder(prompt: string, summaries: readonly SessionSummary[]): string {
  const reminder = bashSessionReminder(summaries);
  return reminder === null ? prompt : `${prompt}\n\n${reminder}`;
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

/** `bash_list` 的数据源。不返回 tail（列表只回答「有哪些、还活着吗」） */
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
 * 两个句柄工具（注册进 runtime 的 customTools）
 *
 * **判断权在模型这一侧只剩「要不要收手」**——看不看进展不再需要工具（结果自己回来）。
 * 描述就是给模型的说明书：说清「什么时候该用」，而不只是「参数是什么」。
 * ------------------------------------------------------------------ */

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

/** 会话的一屏事实：id / 状态 / 退出码 / 耗时 / 结束原因 / 尾部输出 */
function formatSession(summary: SessionSummary, tail: string): string {
  const lines = [
    `session: ${summary.id}`,
    `status: ${summary.status}`,
    `exitCode: ${summary.exitCode === null ? "none" : summary.exitCode}`,
    `elapsed: ${formatBashDuration(summary.elapsedMs)}`,
  ];
  if (summary.endReason !== undefined) lines.push(`endReason: ${reasonText(summary.endReason)}`);
  lines.push(`tail (last ${TOOL_TAIL_LINES} lines):`);
  lines.push(tail.length > 0 ? tail : "(no output yet)");
  return lines.join("\n");
}

function readSessionId(params: unknown): string {
  if (typeof params !== "object" || params === null) return "";
  const value = (params as Record<string, unknown>)["sessionId"];
  return typeof value === "string" ? value.trim() : "";
}

/** 列表行里的命令摘要：一行、截到 80 字（长命令撑爆列表） */
function commandSummary(command: string): string {
  const oneLine = command.replace(/\s+/g, " ").trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

export function createBashHandleTools(owner?: string): ToolDefinition[] {
  const stop: ToolDefinition = {
    name: "bash_stop",
    label: "bash_stop",
    description:
      "Stop a detached bash command and kill its whole process tree. Use it when you have seen enough, or when " +
      "the command is clearly stuck and its work is not worth waiting for. The final result is also written back " +
      "to the conversation automatically. Returns the final status and the last 40 lines.",
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
      const summary = await stopSession(id, KILL_SETTLE_MS, owner);
      if (summary === null) {
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
      const session = ownedSession(id, owner);
      return {
        content: [{ type: "text", text: formatSession(summary, session?.tail(TOOL_TAIL_LINES) ?? "") }],
        details: undefined,
      };
    },
  };

  const list: ToolDefinition = {
    name: "bash_list",
    label: "bash_list",
    description:
      "List the detached bash sessions: id, the command, whether it is still running, how long it has been running, " +
      "and how long since its last output. Results are written back to the conversation automatically when a session " +
      "finishes; use this only to see what is still running, or to decide which session to stop.",
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
        return `${summary.id} ${summary.status} elapsed=${formatBashDuration(summary.elapsedMs)} idle=${formatBashDuration(summary.idleMs)}${exit}${reason} :: ${commandSummary(summary.command)}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
    },
  };

  return [stop, list];
}
