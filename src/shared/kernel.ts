/**
 * 新内核（pi-durable）的契约真源：主进程 ↔ kernel utility 进程的消息协议，与库文件的命名。
 *
 * 开关 `ORBITA_DURABLE_KERNEL=1` 开着时，界面里根会话的对话主循环由 kernel 进程跑：主进程把旧内核那套
 * 开轮 / 停止 / 抢跑 / 压缩 / 插话 / 切档命令**原样**转给它（同一份 AgentCommand，开轮装配不为新内核另拼），
 * kernel 进程回的也是同一套 AgentEvent（转录 progress、phase、stats、审批、工具请求……），renderer 不认识 durable。
 * 关着（默认）时主进程不拉起 kernel 进程，一切走旧内核。
 *
 * 队列仍在 renderer 的槽里（2026-11-14 主会话裁决，方案 §2.3 的 A）：kernel 一次只跑一条完整的开轮命令，
 * 排队、撤回、挪位、「立即发送」都与旧内核同源；durable 的 inbox 只用于父→子的真插话（steer）。
 *
 * 库布局：**一棵会话树一库**——根会话与它派出的子会话在同一个 SQLite 文件
 * （`<userData>/durable/<根会话 id>.sqlite`），删一棵树 = 关库 + 删文件；不同的树互不相干。
 */
import type { AgentCommand, AgentEvent } from "./agent-ipc.ts";

/** 库文件名：根会话 id（与 SessionStore 的 id 白名单同形）+ `.sqlite`。路径只由主进程拼，kernel 进程再校验一次。 */
export const KERNEL_LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.sqlite$/;

/** 根会话 id → 库文件名。调用方先保证 id 过了会话 id 白名单。 */
export function kernelLibraryName(rootSessionId: string): string {
  return `${rootSessionId}.sqlite`;
}

/**
 * 新内核里新建的会话没有 pi 本子：meta.piSessionFile 记这个引用（非 null = 「能续」，界面与主进程里判「有没有本子」的
 * 那些地方照常认它）。kernel 进程见到它就知道这条会话不是旧会话、没有原件可迁。旧内核永远拿不到它——
 * 住在新内核里的会话（meta.durable）主进程不交给旧内核。
 */
export const DURABLE_BOOK_PREFIX = "durable:";

export function durableBookRef(sessionId: string): string {
  return `${DURABLE_BOOK_PREFIX}${sessionId}`;
}

export function isDurableBookRef(piSessionFile: string): boolean {
  return piSessionFile.startsWith(DURABLE_BOOK_PREFIX);
}

/** 新内核一轮的开轮命令：与旧内核的 submit 同形同源 */
export type KernelTurnCommand = Extract<AgentCommand, { type: "submit" }>;

/**
 * 接着跑上次被中断的那一轮（durable 的 continue）：开轮装配要的字段与 submit 相同，只是没有新的用户消息。
 * 旧内核没有这件事（它的进程一死，在跑的轮就没了），所以只在这里、不进 AgentCommand。
 */
export type KernelContinueCommand = Omit<KernelTurnCommand, "type" | "text" | "images" | "files" | "pasted" | "intent" | "backfill"> & {
  type: "continueRun";
};

/**
 * 转给新内核的会话命令：开轮（submit / interrupt / compact / continueRun）、停止、父→子插话、
 * 中途切档 / 换模型、生成标题、释放。与发给旧内核的同形（continueRun 除外）。
 */
export type KernelSessionCommand =
  | Extract<AgentCommand, { type: "submit" | "interrupt" | "compact" | "abort" | "steer" | "setMode" | "setModel" | "generateTitle" | "dispose" }>
  | KernelContinueCommand;

/** 转给新内核的回执：审批回答、意图确认、工具请求的回执（`*Result`，按 requestId 配对） */
export type KernelReplyCommand = Extract<AgentCommand, { type: "permissionAnswer" | "intentConfirmResult" | `${string}Result` }>;

export type KernelCommand =
  /** 进程就绪后的第一句：库目录（`<userData>/durable`） */
  | { type: "init"; dir: string }
  /** 一条会话的命令；root = 这棵会话树的根会话 id（决定用哪个库） */
  | { type: "session"; root: string; command: KernelSessionCommand }
  | { type: "reply"; command: KernelReplyCommand }
  /** MCP 热重载：拆掉全部连接，下一轮按新配置重建（与旧内核的 mcpReload 同义） */
  | { type: "mcpReload" }
  /** 删一棵会话树：先停它在跑的轮、关库，再删库文件；完成经 `dropped` 回 */
  | { type: "drop"; requestId: string; library: string }
  /** 应用正常退出：停掉全部在跑的轮（保留队列与上下文）、关库；完成经 `shutdownDone` 回 */
  | { type: "shutdown"; requestId: string };

/**
 * 新内核一轮的结局。
 * - `migration`：发这条消息前对旧会话做了什么——none（库里的副本还是最新的 / 新会话）、migrated（第一次迁）、
 *   remigrated（库里的副本比原件旧：原件之后又被旧内核续写过，丢掉旧副本按原件重迁）。
 * - `status`：durable 的提交结局（done = 有回答；unanswered 带原因，如 aborted）。
 */
export type KernelTurnResult =
  | {
      ok: true;
      conversationId: number;
      migration: "none" | "migrated" | "remigrated";
      status: "done" | "unanswered";
      reason?: string;
    }
  | {
      ok: false;
      reason: string;
      /** 失败出在迁移旧会话那一步：会话回落只读（原件不动），主进程把原因记进 meta.durable.failed */
      migrationFailed?: true;
      /** 应用正常退出时被停下的轮：上下文留在库里，主进程保留「在跑」标记——下次打开是「上次被中断」 */
      interrupted?: true;
    };

export type KernelMessage =
  /** 一轮的界面事件、工具请求、审批：与旧内核同一套 AgentEvent（含 ready） */
  | AgentEvent
  /** 一轮落定（phase idle 之前到）：主进程据此清 meta.durable.running、记迁移失败 */
  | { type: "turnSettled"; sessionId: string; result: KernelTurnResult }
  | { type: "dropped"; requestId: string; error?: string }
  | { type: "shutdownDone"; requestId: string };
