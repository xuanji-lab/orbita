/**
 * AgentHost —— 主进程侧的 agent utility 进程管家。
 * 只做三件事：懒启动进程、把命令发进去、把事件广播给窗口。业务判断全在两端，不在这里。
 */
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { utilityProcess, type UtilityProcess } from "electron";
import type { AgentCommand, AgentEvent } from "../../shared/agent-ipc.ts";

export class AgentHost {
  private readonly runtimePath: string;
  private readonly onEvent: (event: AgentEvent) => void;
  private child: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;

  constructor(runtimePath: string, onEvent: (event: AgentEvent) => void) {
    this.runtimePath = runtimePath;
    this.onEvent = onEvent;
  }

  /** 懒启动：第一次真正要用 agent 时才付进程启动的钱。 */
  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = utilityProcess.fork(this.runtimePath, [], { stdio: "inherit" });
      this.child = child;

      child.on("message", (message: AgentEvent) => {
        if (message.type === "ready") {
          resolve();
          return;
        }
        this.onEvent(message);
      });

      // 进程没了要让上层知道，否则 UI 会永远停在「思考中」
      child.on("exit", (code) => {
        this.child = null;
        this.ready = null;
        const message = `agent runtime exited with code ${code}`;
        reject(new Error(message));
        this.onEvent({ type: "failed", sessionId: null, message });
      });
    });
    return this.ready;
  }

  async createSession(input: Omit<Extract<AgentCommand, { type: "create" }>, "type" | "sessionId">): Promise<string> {
    await this.ensure();
    const sessionId = randomUUID();
    this.post({ type: "create", sessionId, ...input });
    return sessionId;
  }

  async submit(sessionId: string, text: string): Promise<void> {
    await this.ensure();
    this.post({ type: "submit", sessionId, text });
  }

  async abort(sessionId: string): Promise<void> {
    await this.ensure();
    this.post({ type: "abort", sessionId });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
    this.ready = null;
  }

  private post(command: AgentCommand): void {
    if (!this.child) throw new Error("agent runtime is not running");
    this.child.postMessage(command);
  }
}

/** 打包产物里 runtime 与主进程同目录（electron.vite.config 的 main 多入口）。 */
export function resolveRuntimePath(dirname: string): string {
  return join(dirname, "agent-runtime.js");
}
