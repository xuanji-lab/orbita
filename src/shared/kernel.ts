/**
 * 新内核（pi-durable）的契约真源：主进程 ↔ kernel utility 进程的消息协议，与库文件的命名。
 *
 * 界面里的对话（根会话与它派出的子会话、自动化开的轮）由 kernel 进程跑：主进程把开轮 / 停止 / 抢跑 / 压缩 / 插话 /
 * 回退 / 撤销 / 挪工作区 / 分支命令**原样**转给它（同一份 AgentCommand，开轮装配不为新内核另拼），
 * kernel 进程回的也是同一套 AgentEvent（转录 progress、phase、stats、工具请求……），renderer 不认识 durable。
 * 旧内核的主循环已删（2026-11-16）；还没迁进库的旧会话第一次开轮时由 kernel 迁（legacy-migrate.ts）。
 *
 * 队列仍在 renderer 的槽里（2026-11-14 主会话裁决，方案 §2.3 的 A）：kernel 一次只跑一条完整的开轮命令，
 * 排队、撤回、挪位、「立即发送」都与旧内核同源；durable 的 inbox 只用于父→子的真插话（steer）。
 *
 * 库布局：**一棵会话树一库**——根会话与它派出的子会话在同一个 SQLite 文件
 * （`<userData>/durable/<根会话 id>.sqlite`），删一棵树 = 关库 + 删文件；不同的树互不相干。
 */
import type { AgentCommand, AgentEvent } from "./agent-ipc.ts";
import type { SessionMeta } from "./session.ts";

/** 库文件名：根会话 id（与 SessionStore 的 id 白名单同形）+ `.sqlite`。路径只由主进程拼，kernel 进程再校验一次。 */
export const KERNEL_LIBRARY_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*\.sqlite$/;

/** 根会话 id → 库文件名。调用方先保证 id 过了会话 id 白名单。 */
export function kernelLibraryName(rootSessionId: string): string {
  return `${rootSessionId}.sqlite`;
}

/**
 * 新内核里新建的会话没有 pi 本子：meta.piSessionFile 记这个引用（非 null = 「能续」，界面与主进程里判「有没有本子」的
 * 那些地方照常认它）。kernel 进程见到它就知道这条会话不是旧会话、没有原件可迁。agent 进程改 pi 本子（还没迁的旧会话的
 * 回退 / 撤销 / 分支 / 挪工作区）永远拿不到它——住在新内核里的会话（meta.durable）的本子编辑交给 kernel。
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
export type KernelContinueCommand = Omit<KernelTurnCommand, "type" | "text" | "images" | "files" | "pasted" | "intent" | "backfill" | "preface"> & {
  type: "continueRun";
};

/**
 * 分支：从一条住在新内核里的会话的前缀开一棵新树（新库）。与发给旧内核的 branch 同形（sessionId 是主进程先铸好的
 * **新会话 id**，roles 是我们这本账前缀的角色序列），另带源会话 id 与它的树根：源会话的「本子」在源树的库里，
 * sourcePiSessionFile 对迁来的会话是旧本子的路径、对新建的是 durable 引用，都认不出库里是哪条。
 */
export type KernelBranchCommand = Extract<AgentCommand, { type: "branch" }> & { sourceSessionId: string; sourceRoot: string };

/**
 * 删树里的一条会话（不是树根；删树根走 drop，整库一起删）：停它在跑的轮、从索引摘掉、记进墓碑；
 * 它在库文件里的行在这个库下一次关闭（或下一次打开）时清掉（durable 没有删一条 conversation 的办法）。
 */
export type KernelForgetCommand = { type: "forget"; sessionId: string };

/**
 * 转给新内核的会话命令：开轮（submit / interrupt / compact / continueRun）、停止、父→子插话、
 * 中途换模型、生成标题、释放；本子编辑（回退 / 撤销 / 挪工作区，回执同旧内核是 piBookEdited / failed）、
 * 分支（回执 created）、删树里的一条。与发给旧内核的同形（continueRun / branch 的两个字段 / forget 除外）。
 */
export type KernelSessionCommand =
  | Extract<
      AgentCommand,
      { type: "submit" | "interrupt" | "compact" | "abort" | "steer" | "setModel" | "generateTitle" | "dispose" | "revertPiBook" | "undoPiBook" | "movePiBook" }
    >
  | KernelContinueCommand
  | KernelBranchCommand
  | KernelForgetCommand;

/** 转给新内核的回执：意图确认、工具请求的回执（`*Result`，按 requestId 配对） */
export type KernelReplyCommand = Extract<AgentCommand, { type: "intentConfirmResult" | `${string}Result` }>;

export type KernelCommand =
  /** 进程就绪后的第一句：库目录（`<userData>/durable`） */
  | { type: "init"; dir: string }
  /** 一条会话的命令；root = 这棵会话树的根会话 id（决定用哪个库；子会话与父同库，分支是新树的根） */
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
  /** 一轮的界面事件、工具请求：与旧内核同一套 AgentEvent（含 ready） */
  | AgentEvent
  /** 一轮落定（phase idle 之前到）：主进程据此清 meta.durable.running、记迁移失败 */
  | { type: "turnSettled"; sessionId: string; result: KernelTurnResult }
  | { type: "dropped"; requestId: string; error?: string }
  /**
   * 父→子插话到达时子这一轮刚好收尾（没有在跑的轮可插）：原文退回主进程，由它当「子空闲时的投递」开一轮。
   * 旧内核在这一刻只报 failed（消息留在通道里、没送到模型，要人重发），这里不丢。
   */
  | { type: "steerBounced"; sessionId: string; text: string; delivery: "steer" | "followUp" }
  | { type: "shutdownDone"; requestId: string };

/**
 * 一条上次没跑完的会话，应用重启后怎么办——**唯一的判断点**，换策略只改这里（主进程续跑（kernel-host 的 sessionsToResume）、renderer 的说明都读它）：
 * - "resume"：自动接着跑。只给**子会话**（后台任务）、且上次是**正常退出**停下的（退出流程把命令停掉了，状态确定；
 *   被停的调用给模型的结果写着「退出时停掉的、没跑完」）。
 * - "crashed"：停下，界面说「应用上次是异常退出的」+「继续」，由人决定。子会话上次是崩溃 / 强杀 / kernel 死掉留下的
 *   ——命令可能成了孤儿自己跑完，自动续跑会让模型把有副作用的命令再做一遍（第四步验收组 2 复现过 start·end·start·end）。
 *   **拿不准就归这一类**：缺了「正常退出」的标记一律当崩溃（标记写在退出流程里、被停的轮落定时，崩溃时写不上）。
 * - "ask"：树根（前台会话）——界面照旧「这一轮没跑完就被打断了 · 继续」（方案 §2.2 第 10 行的默认）。
 * - null：没在跑 / 迁移失败过 / 不在新内核里。
 */
export type ResumePolicy = "resume" | "crashed" | "ask";

export function resumePolicy(meta: Pick<SessionMeta, "parentId" | "durable">): ResumePolicy | null {
  const mark = meta.durable;
  if (mark?.running !== true || mark.failed !== undefined) return null;
  if (meta.parentId === undefined) return "ask";
  return mark.stoppedOnQuit === true ? "resume" : "crashed";
}

/**
 * 子会话面板底部关于「上次重启」的那一句，只给一句：
 * - "crashed"：被崩溃打断、停着等人点「继续」（awaitsContinue）。running = 这条会话此刻在跑：自动续跑那一轮的 meta 已没有
 *   stoppedOnQuit，按 resumePolicy 也是 "crashed"，在跑时不能据此说「被打断了」。**压过 resumed**——先正常退出重启（自动续跑、
 *   记下 resumed）、续跑那一轮里又崩溃时，resumed 是上一次的旧账（崩溃时写不上清除），两句同时出现自相矛盾。
 * - "resumed"：重启后被自动接着跑过的子会话，直到下一次由人或父开的轮（kernel-host 的 markRunning 清掉）。
 * - null：都不是。
 */
export function restartNote(meta: Pick<SessionMeta, "parentId" | "durable">, running: boolean): "crashed" | "resumed" | null {
  if (awaitsContinue(meta, running)) return "crashed";
  return meta.parentId !== undefined && meta.durable?.resumed !== undefined ? "resumed" : null;
}

/**
 * 子会话被崩溃打断、此刻没在跑——停在那里等人点「继续」（父会话也一直等它）。侧栏父会话行、父会话的子会话入口、
 * 子会话收件箱行据此归进「等你」。点了「继续」就在跑（running 为真）；跑完落定清掉 durable.running，标记消失。
 * 正常退出后自动续跑的（resumePolicy "resume"）与树根（"ask"）不算。
 */
export function awaitsContinue(meta: Pick<SessionMeta, "parentId" | "durable">, running: boolean): boolean {
  return !running && resumePolicy(meta) === "crashed";
}
