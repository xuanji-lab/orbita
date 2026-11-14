/**
 * 新内核（pi-durable）的 utility 进程入口——与 agent / terminal / memory runtime 平行的第四个入口
 * （electron.vite.config 的 main 多入口）。**薄壳**：库池与迁移在 kernel.ts / legacy-migrate.ts
 * （纯模块，`node --test` 直接测），这里只管 parentPort 收发与模型目录。
 *
 * 这一步（换内核第二步）只由脚本直驱：主进程不拉起它（对话主循环仍是旧内核），开关关着时这个进程不存在、
 * agent runtime 一个字节都没变。脚本发 init → turn，替主进程回审批与工具请求（agent 命令）。
 * 单独一个进程而不是塞进 agent runtime：这一步不切换主循环，agent 进程不该为一个默认关着的开关
 * 多加载一整套 durable（启动时间与常驻内存）。
 * 主循环迁过来那一步，库池随之搬进 agent 进程，这个入口删掉。
 *
 * 为什么是 utility 进程：SQLite 的同步调用（node:sqlite 是同步 API）与大会话迁移的 JSON 处理
 * 都不该占主进程的事件循环；崩溃也不带走窗口。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import { COMPACTION_DEFAULT } from "../shared/settings.ts";
import type { KernelCommand, KernelMessage } from "../shared/kernel.ts";
import { KernelPool } from "./kernel.ts";
import { PermissionWaiter, type KernelTurnRuntime } from "./kernel-turn.ts";
import { McpHub } from "./mcp.ts";
import { createModelRuntime } from "./model-catalog.ts";
import { registerAndResolveModel } from "./model-registration.ts";
import { isToolReply, RequestBroker, toolReplyResult } from "./request-broker.ts";
import { createShellPathResolver } from "./shell-path.ts";

/** Electron 的 utility 进程 parentPort 的结构面（memory runtime 的同款） */
type ParentPortLike = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
};

const parentPort = (process as typeof process & { parentPort?: ParentPortLike }).parentPort;
if (parentPort === undefined) {
  console.error("[kernel-runtime] 没有 parentPort——本文件只能作为 Electron utility 进程运行");
  process.exit(1);
}

function post(message: KernelMessage): void {
  parentPort?.postMessage(message);
}

/**
 * 模型目录：与旧内核**同一条装配路径**（model-catalog 的 createModelRuntime + model-registration 的
 * registerAndResolveModel）——服务商的协议、地址、白名单参数、思考档位表都按旧内核的规则解析，
 * 不让用户为新内核再配一遍。ModelRuntime 本身就实现 pi-ai 的 Models 接口，直接交给 durable。
 * （删旧内核那一步要换成 pi-ai 自己的 createModels：ModelRuntime 在 pi-coding-agent 里。）
 */
type KernelModelRuntime = Awaited<ReturnType<typeof createModelRuntime>>;
let modelRuntime: KernelModelRuntime | null = null;
let pool: KernelPool | null = null;

/** init 之前到的命令排在它后面 */
let initialized: Promise<void> | null = null;

function sendAgent(event: AgentEvent): void {
  post({ type: "agent", event });
}

/**
 * 跑轮用的进程级依赖：与旧内核 runtime.ts 的同名单例同语义——工具请求通道（RequestBroker，主进程是唯一对端）、
 * MCP 连接（按工作区分片）、审批等待表、bash 路径探测缓存。
 */
const turnRuntime: KernelTurnRuntime = {
  broker: new RequestBroker((event) => sendAgent(event as AgentEvent)),
  mcpHub: new McpHub(),
  permissions: new PermissionWaiter(sendAgent),
  send: sendAgent,
  resolveShellPath: createShellPathResolver(),
};

function models(): Models {
  if (modelRuntime === null) throw new Error("kernel runtime is not initialized");
  return modelRuntime;
}

async function init(dir: string): Promise<void> {
  modelRuntime = await createModelRuntime();
  const runtime = modelRuntime;
  pool = new KernelPool({
    dir,
    models,
    registerProvider: (agent) => {
      if (agent.provider === null) return undefined;
      return registerAndResolveModel(runtime, agent.provider, agent.modelId);
    },
    log: (text) => console.error(text),
  });
}

parentPort.on("message", (event: { data: unknown }) => {
  const command = event.data as KernelCommand;
  if (command.type === "init") {
    initialized = init(command.dir).catch((cause: unknown) => {
      console.error("[kernel-runtime] init 失败", cause);
      throw cause;
    });
    return;
  }
  const ready = initialized ?? Promise.reject(new Error("kernel runtime got a command before init"));
  if (command.type === "turn") {
    const { requestId } = command;
    void ready
      .then(() => {
        if (pool === null) throw new Error("kernel runtime is not initialized");
        return pool.turn({
          library: command.library,
          command: command.turn,
          runtime: turnRuntime,
          compaction: {
            enabled: command.turn.compaction?.enabled ?? true,
            reservePercent: command.turn.compaction?.reservePercent ?? COMPACTION_DEFAULT.reservePercent,
          },
        });
      })
      .then((result) => post({ type: "turnDone", requestId, sessionId: command.turn.sessionId, result }))
      .catch((cause: unknown) =>
        post({
          type: "turnDone",
          requestId,
          sessionId: command.turn.sessionId,
          result: { ok: false, reason: cause instanceof Error ? cause.message : String(cause) },
        }),
      );
    return;
  }
  if (command.type === "agent") {
    const forwarded = command.command;
    if (forwarded.type === "permissionAnswer") {
      turnRuntime.permissions.answer(forwarded.requestId, forwarded.answer);
    } else if (forwarded.type === "abort") {
      void ready.then(() => pool?.abort(forwarded.sessionId)).catch((cause: unknown) => console.error("[kernel] 停止失败", cause));
    } else if (isToolReply(forwarded)) {
      // 工具请求的回执（*Result）：与旧内核同一份翻法（request-broker.ts），结掉在途的工具调用
      turnRuntime.broker.resolve(forwarded.requestId, toolReplyResult(forwarded));
    }
    // 意图确认（intentConfirmResult）：新内核这一步不跑意图闸门（实验功能，主循环切过来时再接），收到就丢
    return;
  }
});

post({ type: "ready" });
