/**
 * 新内核（pi-durable）的契约真源：主进程（及这一步直驱它的脚本）↔ kernel utility 进程的消息协议，
 * 与库文件的命名。
 *
 * 现状（换内核第二步）：对话主循环仍是 pi-coding-agent；新内核（kernel 进程）只由脚本直驱跑轮，
 * 主进程这一步不拉起它。旧会话在新内核第一次为它发消息时**复制**进它自己的库（惰性迁移，发之前比对原件指纹、
 * 过期就重迁）。开关 `ORBITA_DURABLE_KERNEL=1` 默认关，关着时主进程的行为与基线相同。
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

export type KernelCommand =
  /** 进程就绪后的第一句：库目录（`<userData>/durable`） */
  | { type: "init"; dir: string }
  /**
   * 用新内核跑一轮（不经过界面的那条路：这一步只有脚本直驱）。`turn` 就是旧内核开轮的**同一份** submit 命令——
   * 工具、闸门、系统提示都从它装配，两个内核吃同一份输入，主循环切过来时主进程不用为新内核另拼一份。
   *
   * 迁移时机在这里：库里还没有这条会话、或库里的副本比原件（`turn.piSessionFile`）旧，就在发这条消息之前迁 / 重迁。
   * 结果经 `turnDone` 回；这一轮里要用户点的审批、要主进程办的工具请求经 `agent` 事件往外发，回答经 `agent` 命令回来。
   */
  | { type: "turn"; requestId: string; library: string; turn: KernelTurnCommand }
  /** 转给新内核的旧协议命令：审批回答、停止、工具请求的回执（与发给旧内核的同形，见 KernelForwardedCommand） */
  | { type: "agent"; command: KernelForwardedCommand };

/** 新内核一轮的开轮命令：与旧内核的 submit 同形同源 */
export type KernelTurnCommand = Extract<AgentCommand, { type: "submit" }>;

/**
 * 新内核收的旧协议命令子集：审批回答、停止这一轮、以及工具请求的回执（`*Result`，按 requestId 配对）。
 * 主进程处理工具请求（建 skill、读任务、开终端……）的代码一份不改，回执原样转过来。
 */
export type KernelForwardedCommand = Extract<AgentCommand, { type: "permissionAnswer" | "abort" | `${string}Result` }>;

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
  | { ok: false; reason: string };

export type KernelMessage =
  | { type: "ready" }
  | { type: "turnDone"; requestId: string; sessionId: string; result: KernelTurnResult }
  /** 新内核一轮里往外发的旧协议事件：审批请求（permission）、工具请求（*Request）、轮的相位与失败 */
  | { type: "agent"; event: AgentEvent };
