/**
 * terminal utility 进程入口 —— 一个进程管全部 PTY（与 agent runtime 平行的第二个
 * utility 入口，electron.vite.config 的 main 多入口）。node-pty 只在这里 import：
 * 原生模块活在这个进程里，崩了不带走主进程与窗口。
 *
 * 信令：主进程 fork 本入口后经 `utilityProcess.postMessage` 递来一条 MessagePort
 * （专用通道，不占 parentPort），之后的请求 / 事件全走这条 port。输出经
 * OutputPipeline 批量 + 背压后回主进程，主进程再决定缓冲与广播。
 */
import { spawn as spawnProcess } from "node:child_process";
import { spawn as ptySpawn, type IPty } from "node-pty";
import type { TerminalOutputEvent } from "../shared/terminal.ts";
import type { TerminalRuntimeMessage, TerminalRuntimeRequest } from "../shared/terminal-runtime.ts";
import { resolveTerminalCwd, resolveTerminalEnv } from "./env.ts";
import { OutputPipeline } from "./output-batcher.ts";
import { resolveTerminalShell } from "./shell.ts";

/** Electron 的 utility 进程 parentPort 的结构面（agent runtime 的 ParentPortLike 同款） */
type ParentPortLike = {
  on(event: "message", listener: (event: ParentPortMessage) => void): void;
  postMessage(message: unknown): void;
  start?(): void;
};

/** 主进程经 utilityProcess.postMessage 递 port 过来时的信封 */
type ParentPortMessage = {
  data?: unknown;
  ports?: RuntimePort[];
};

/** MessagePort 的结构面（Electron 的 MessagePortMain 满足，测试假货也满足） */
type RuntimePort = {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start(): void;
};

interface ManagedPty {
  pty: IPty;
  shell: string;
  cwd: string;
}

const terminals = new Map<string, ManagedPty>();

/** runtime → 主进程的唯一出口（port 就绪前置为空操作——请求本来就还没来） */
let post: (message: TerminalRuntimeMessage) => void = () => undefined;

const pipeline = new OutputPipeline(
  (event: TerminalOutputEvent) => post({ type: "output", event }),
  (terminalId, exitCode) => {
    terminals.delete(terminalId);
    post({ type: "exit", terminalId, exitCode });
  },
);

const parentPort = (process as typeof process & { parentPort?: ParentPortLike }).parentPort;
if (parentPort === undefined) {
  console.error("[terminal-runtime] 没有 parentPort——本文件只能作为 Electron utility 进程运行");
  process.exit(1);
}

parentPort.on("message", (event) => {
  const data = event?.data as { type?: unknown } | undefined;
  if (data?.type !== "orbita-terminal-port") return;
  const port = event.ports?.[0];
  if (port === undefined) {
    console.error("[terminal-runtime] 主进程没有递来 MessagePort");
    process.exit(1);
  }
  port.on("message", (message) => handleRequest(message.data as TerminalRuntimeRequest));
  port.start();
  post = (message) => port.postMessage(message);
  post({ type: "ready" });
});

// parentPort 也要 start：不启动消息事件不流动（agent runtime 同款）
parentPort.start?.();

function handleRequest(request: TerminalRuntimeRequest): void {
  switch (request.type) {
    case "create":
      createTerminal(request);
      return;
    case "input":
      terminals.get(request.terminalId)?.pty.write(request.data);
      return;
    case "resize": {
      const terminal = terminals.get(request.terminalId);
      if (terminal !== undefined) terminal.pty.resize(request.cols, request.rows);
      return;
    }
    case "kill":
      destroyTerminal(request.terminalId);
      return;
    case "ack":
      pipeline.acknowledge(request.terminalId, request.sequence);
      return;
    case "shutdown":
      for (const terminalId of [...terminals.keys()]) destroyTerminal(terminalId);
      pipeline.dispose();
      post({ type: "stopped" });
      return;
  }
}

function createTerminal(request: Extract<TerminalRuntimeRequest, { type: "create" }>): void {
  // 幂等：同一 id 重复 create（重挂载 / 手快双击）直接回现状，不开第二个 PTY
  const existing = terminals.get(request.terminalId);
  if (existing !== undefined) {
    post({
      type: "created",
      terminalId: request.terminalId,
      shell: existing.shell,
      cwd: existing.cwd,
      pid: existing.pty.pid,
    });
    return;
  }
  try {
    const shell = resolveTerminalShell();
    const cwd = resolveTerminalCwd(request.cwd);
    const env = resolveTerminalEnv();
    const pty = ptySpawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: request.cols,
      rows: request.rows,
      cwd,
      env,
    });
    terminals.set(request.terminalId, { pty, shell: shell.label, cwd });
    pipeline.track(request.terminalId);
    post({ type: "created", terminalId: request.terminalId, shell: shell.label, cwd, pid: pty.pid });
    pty.onData((data) => pipeline.enqueue(request.terminalId, data));
    pty.onExit(({ exitCode }) => {
      // exit 攒到输出排空才发（OutputPipeline 保证顺序），发出时顺带清掉终端登记
      pipeline.exit(request.terminalId, exitCode);
    });
  } catch (error) {
    post({
      type: "error",
      terminalId: request.terminalId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 杀终端。Windows 用 `taskkill /T /F` 杀**整棵进程树**：PTY 里跑着的 dev server
 * 会再 fork 子进程，只 kill ConPTY 的话 npm 的孙进程会留下来占着端口。taskkill
 * 是异步的火力覆盖，pty.kill() 同步兜底（进程已退出时可能抛，吞掉即可）。
 */
function destroyTerminal(terminalId: string): void {
  const terminal = terminals.get(terminalId);
  if (terminal === undefined) return;
  pipeline.drop(terminalId);
  terminals.delete(terminalId);
  if (process.platform === "win32") {
    const taskkill = spawnProcess("taskkill", ["/pid", String(terminal.pty.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
    taskkill.on("error", () => undefined);
  }
  try {
    terminal.pty.kill();
  } catch {
    // 进程已退出时 node-pty 可能抛错；终端生命周期在此收束
  }
}
