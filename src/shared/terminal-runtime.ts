/**
 * 主进程 ↔ terminal utility 进程 的信封契约（第二条边界，agent-ipc.ts 双边界同款的
 * 拆分：四层 IPC 的 renderer 契约在 `terminal.ts`，这里的类型只走 MessagePort，
 * renderer 不消费）。
 */
import type { TerminalOutputEvent } from "./terminal.ts";

/** 主进程 → runtime（经 MessagePort） */
export type TerminalRuntimeRequest =
  | { type: "create"; terminalId: string; cols: number; rows: number; cwd: string }
  | { type: "input"; terminalId: string; data: string }
  | { type: "resize"; terminalId: string; cols: number; rows: number }
  | { type: "kill"; terminalId: string }
  | { type: "ack"; terminalId: string; sequence: number }
  | { type: "shutdown" };

/** runtime → 主进程（经 MessagePort）。exit 在该终端的输出全部排空之后才发 */
export type TerminalRuntimeMessage =
  | { type: "ready" }
  | { type: "created"; terminalId: string; shell: string; cwd: string; pid: number }
  | { type: "output"; event: TerminalOutputEvent }
  | { type: "exit"; terminalId: string; exitCode: number }
  | { type: "error"; terminalId: string; message: string }
  | { type: "stopped" };
