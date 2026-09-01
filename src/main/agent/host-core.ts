/**
 * AgentHost 的全部逻辑 —— **纯模块**：不 import electron，可被 `node --test` 直接测
 * （recorder.ts 同款先例）。真的 fork 在 `host.ts` 那层注入。
 *
 * 只做三件事：懒启动进程、把命令发进去、把事件广播给窗口。业务判断全在两端，不在这里。
 */
import { randomUUID } from "node:crypto";
import type { AgentCommand, AgentEvent, BuiltinProvider } from "../../shared/agent-ipc.ts";
import type { PermissionAnswer, PermissionMode } from "../../shared/permission.ts";

/** host 对「子进程」的全部要求——Electron 的 UtilityProcess 结构上满足，测试用脚本假货顶上。 */
export interface AgentChild {
  on(event: "message", listener: (message: AgentEvent) => void): unknown;
  on(event: "exit", listener: (code: number) => void): unknown;
  postMessage(message: AgentCommand): unknown;
  kill(): unknown;
}

export class AgentHostCore {
  private readonly forkRuntime: () => AgentChild;
  private readonly onEvent: (event: AgentEvent) => void;
  private child: AgentChild | null = null;
  private ready: Promise<void> | null = null;
  /** pi 报上来的内建目录。runtime 是**先发 ready 再异步建目录**，所以不能只等 ready
   *  就返回缓存——那一刻缓存必然是空的（下拉框不出现就是这个竞态）。 */
  private builtins: BuiltinProvider[] = [];
  private resolveBuiltins: ((providers: BuiltinProvider[]) => void) | null = null;
  private builtinsArrived: Promise<BuiltinProvider[]> | null = null;
  /**
   * 正在创建中的 session。**create 是异步的**（runtime 要起 ModelRuntime 再建 AgentSession，
   * 几百毫秒），而 postMessage 是发完就走——不等 `created` 就返回 id 的话，
   * renderer 立刻 submit 会撞上「unknown session」。这张表就是那段等待。
   */
  private readonly pendingCreates = new Map<
    string,
    { resolve: (piSessionFile: string | null) => void; reject: (error: Error) => void }
  >();

  constructor(forkRuntime: () => AgentChild, onEvent: (event: AgentEvent) => void) {
    this.forkRuntime = forkRuntime;
    this.onEvent = onEvent;
  }

  /** 懒启动：第一次真正要用 agent 时才付进程启动的钱。 */
  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const child = this.forkRuntime();
      this.child = child;

      child.on("message", (message: AgentEvent) => {
        if (message.type === "ready") {
          resolve();
          return;
        }
        if (message.type === "builtins") {
          this.builtins = message.providers;
          this.resolveBuiltins?.(message.providers);
          this.resolveBuiltins = null;
          return;
        }
        if (message.type === "created") {
          this.pendingCreates.get(message.sessionId)?.resolve(message.piSessionFile);
          this.pendingCreates.delete(message.sessionId);
          return;
        }
        if (message.type === "failed" && message.sessionId !== null) {
          const pending = this.pendingCreates.get(message.sessionId);
          if (pending) {
            // 创建失败要把错误交回调用方，而不是只广播一条事件——
            // 否则 renderer 会拿着一个永远不存在的 sessionId 继续发消息
            pending.reject(new Error(message.message));
            this.pendingCreates.delete(message.sessionId);
            return;
          }
        }
        this.onEvent(message);
      });

      // 进程没了要让上层知道，否则 UI 会永远停在「思考中」
      child.on("exit", (code) => {
        this.child = null;
        this.ready = null;
        this.builtinsArrived = null;
        this.resolveBuiltins = null;
        const message = `agent runtime exited with code ${code}`;
        for (const pending of this.pendingCreates.values()) pending.reject(new Error(message));
        this.pendingCreates.clear();
        reject(new Error(message));
        this.onEvent({ type: "failed", sessionId: null, message });
      });
    });
    return this.ready;
  }

  /**
   * 创建 session。**等 runtime 回 `created` 才返回**——返回即可用。
   *
   * `reuseId` 是续会话：沿用原来的 id，新消息接着写进同一份记录，而不是分裂成两条。
   * 返回 pi 这一次用的那份 session 文件，调用方要把它记进会话 meta。
   */
  async createSession(
    input: Omit<Extract<AgentCommand, { type: "create" }>, "type" | "sessionId">,
    reuseId?: string,
  ): Promise<{ sessionId: string; piSessionFile: string | null }> {
    await this.ensure();
    const sessionId = reuseId ?? randomUUID();
    const created = new Promise<string | null>((resolve, reject) => {
      this.pendingCreates.set(sessionId, { resolve, reject });
      setTimeout(() => {
        if (!this.pendingCreates.delete(sessionId)) return;
        reject(new Error("agent runtime did not confirm the session in time"));
      }, 60_000);
    });
    this.post({ type: "create", sessionId, ...input });
    return { sessionId, piSessionFile: await created };
  }

  /**
   * 内建 provider 目录。会顺带把 agent 进程拉起来——它是 pi 的唯一宿主。
   * 目录还没到就等它到（带超时兜底：拿不到目录只是没有下拉框，不该把设置面卡死）。
   */
  async listBuiltins(): Promise<BuiltinProvider[]> {
    await this.ensure();
    if (this.builtins.length > 0) return this.builtins;
    this.builtinsArrived ??= new Promise<BuiltinProvider[]>((resolve) => {
      this.resolveBuiltins = resolve;
      setTimeout(() => resolve(this.builtins), 15_000);
    });
    return this.builtinsArrived;
  }

  async submit(sessionId: string, text: string): Promise<void> {
    await this.ensure();
    this.post({ type: "submit", sessionId, text });
  }

  async queueEdit(
    sessionId: string,
    op: "promote" | "cancel" | "edit",
    index: number,
    text: string,
    newText?: string,
  ): Promise<void> {
    await this.ensure();
    this.post({ type: "queueEdit", sessionId, op, index, text, ...(newText !== undefined ? { newText } : {}) });
  }

  async setMode(sessionId: string, mode: PermissionMode): Promise<void> {
    await this.ensure();
    this.post({ type: "setMode", sessionId, mode });
  }

  /** 用户的审批回答。**不需要 ensure**：进程没了的话请求也早没了。 */
  answerPermission(requestId: string, answer: PermissionAnswer): void {
    this.child?.postMessage({ type: "permissionAnswer", requestId, answer } satisfies AgentCommand);
  }

  async abort(sessionId: string): Promise<void> {
    await this.ensure();
    this.post({ type: "abort", sessionId });
  }

  /** 手动压缩上下文。**发完即回**：忙碌态与界碑走 compaction 事件链，调用方不等结果。 */
  async compact(sessionId: string, instructions?: string): Promise<void> {
    await this.ensure();
    this.post({ type: "compact", sessionId, ...(instructions ? { instructions } : {}) });
  }

  /**
   * 释放一条会话（runtime 侧退订 + `session.dispose()` + 出 Map）。
   * **不 ensure**：进程没起的话这条会话本来就不在 runtime 里（answerPermission 同款理由），
   * 为释放去拉起一个进程才是本末倒置。发完即回，runtime 对不存在的 id 静默容忍。
   */
  disposeSession(sessionId: string): void {
    this.child?.postMessage({ type: "dispose", sessionId } satisfies AgentCommand);
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
