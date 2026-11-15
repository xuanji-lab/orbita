/**
 * 新内核（pi-durable）的 utility 进程入口——与 agent / terminal / memory runtime 平行的第四个入口
 * （electron.vite.config 的 main 多入口）。**薄壳**：会话生命周期在 kernel-session.ts、库池与迁移在 kernel.ts /
 * legacy-migrate.ts（纯模块，`node --test` 直接测），这里只管 parentPort 收发、模型目录与进程级单例。
 *
 * 开关 ORBITA_DURABLE_KERNEL=1 开着时主进程拉起它，界面里根会话的对话主循环由它跑；关着时这个进程不存在，
 * agent runtime 一个字节都没变（子会话、标题以外的家务活、目录刷新仍在 agent runtime）。
 * 单独一个进程而不是塞进 agent runtime：开关关着时 agent 进程不该为它多加载一整套 durable（启动时间与常驻内存）；
 * 删旧内核那一步两个进程合一。
 *
 * 为什么是 utility 进程：SQLite 的同步调用（node:sqlite 是同步 API）与大会话迁移的 JSON 处理
 * 都不该占主进程的事件循环；崩溃也不带走窗口（主进程把在跑的轮标成「上次被中断」，见 host-core.ts）。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { AgentEvent } from "../shared/agent-ipc.ts";
import type { KernelCommand, KernelMessage, KernelSessionCommand } from "../shared/kernel.ts";
import { IntentConfirmWaiter } from "./intent-confirm-wait.ts";
import { join } from "node:path";
import { forkMigrator, KernelPool } from "./kernel.ts";
import { kernelChildTag, reapKernelChildren, tagShellCommand } from "./kernel-children.ts";
import { KernelSessions } from "./kernel-session.ts";
import { PermissionWaiter, type KernelTurnRuntime } from "./kernel-turn.ts";
import { McpHub } from "./mcp.ts";
import { createModelRuntime } from "./model-catalog.ts";
import { registerAndResolveModel } from "./model-registration.ts";
import { isToolReply, RequestBroker, toolReplyResult } from "./request-broker.ts";
import { createShellPathResolver } from "./shell-path.ts";
import { preferIPv4 } from "../shared/dial-v4.ts";

// pi-ai 的模型调用与旧内核同一个坑（同一台机器、同一个全局 fetch）
preferIPv4();

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
  post(event);
}

/**
 * 跑轮用的进程级依赖：与旧内核 runtime.ts 的同名单例同语义——工具请求通道（RequestBroker，主进程是唯一对端）、
 * MCP 连接（按工作区分片）、审批与意图确认的等待表、bash 路径探测缓存。
 */
const turnRuntime: KernelTurnRuntime = {
  broker: new RequestBroker((event) => sendAgent(event as AgentEvent)),
  mcpHub: new McpHub(),
  permissions: new PermissionWaiter(sendAgent),
  send: sendAgent,
  resolveShellPath: createShellPathResolver(),
};
const intentConfirm = new IntentConfirmWaiter(sendAgent);
let sessions: KernelSessions | null = null;
/** `--expose-gc` 给的完整 GC（迁移大本子时用） */
const exposedGc = (globalThis as { gc?: () => void }).gc;

function migratorMinBytes(raw: string | undefined): { migrateElsewhereMinBytes?: number } {
  const value = raw === undefined ? Number.NaN : Number(raw);
  return Number.isInteger(value) && value >= 0 ? { migrateElsewhereMinBytes: value } : {};
}

function models(): Models {
  if (modelRuntime === null) throw new Error("kernel runtime is not initialized");
  return modelRuntime;
}

async function init(dir: string): Promise<void> {
  modelRuntime = await createModelRuntime();
  const runtime = modelRuntime;
  // 孤儿善后：bash 子进程挂上这个库目录的标签；上一次连主进程一起被杀留下的，现在清掉
  const tag = kernelChildTag(dir);
  turnRuntime.tagCommand = (command) => tagShellCommand(command, tag);
  const reaped = await reapKernelChildren(tag);
  if (reaped > 0) console.error(`[kernel-runtime] 清掉上一次留下的 ${reaped} 个 shell 子进程`);
  pool = new KernelPool({
    dir,
    models,
    registerProvider: (agent) => {
      if (agent.provider === null) return undefined;
      return registerAndResolveModel(runtime, agent.provider, agent.modelId);
    },
    log: (text) => console.error(text),
    // 迁旧会话交给用完即退的迁移进程（同目录的 kernel-migrator.js）：迁移的内存高水位不留在 kernel 进程里
    migrateElsewhere: (request) => forkMigrator(join(__dirname, "kernel-migrator.js"), request),
    // 开发 / 验收用：ORBITA_MIGRATOR_MIN_BYTES 覆盖交给迁移进程的门槛（非负整数字节；别的值不认）
    ...migratorMinBytes(process.env["ORBITA_MIGRATOR_MIN_BYTES"]),
    // 主进程拉起时带了 --expose-gc（host.ts）；没带（比对台直接拉起）就交给 V8 自己
    ...(typeof exposedGc === "function" ? { collectGarbage: () => exposedGc?.() } : {}),
  });
  sessions = new KernelSessions({
    pool,
    runtime: turnRuntime,
    intentConfirm,
    settled: (sessionId, result) => post({ type: "turnSettled", sessionId, result }),
    bounceSteer: (sessionId, text, delivery) => post({ type: "steerBounced", sessionId, text, delivery }),
    ...(typeof exposedGc === "function" ? { collectGarbage: () => exposedGc?.() } : {}),
    // 换模型的校验与旧内核 setLedgerModel 同一条路径：一次性 ModelRuntime 注册 + 解析
    resolveModel: async (provider, modelId) => registerAndResolveModel(await createModelRuntime(), provider, modelId),
  });
  // 上次删了树里的一条、还没清行进程就没了（强杀 / 崩溃）：起来时把没打开的库的遗留墓碑清掉，不等那棵树下次被打开
  void pool.sweepTombstones().catch((cause: unknown) => console.error("[kernel-runtime] 清遗留墓碑失败", cause));
}

/**
 * 一条会话命令。与旧内核的命令循环同一个语义：每条命令各自跑、不互相排队（停止 / 插话 / 切档要能插进正在跑的轮），
 * 同一会话的轮由 turn-cycle 的占坑保证不并发。失败报 failed（同旧内核）。
 */
function runSession(root: string, command: KernelSessionCommand, ready: Promise<void>): void {
  void ready
    .then(() => {
      if (sessions === null) throw new Error("kernel runtime is not initialized");
      return sessions.handle(root, command);
    })
    .catch((cause: unknown) => {
      console.error("[kernel-runtime] 命令失败", command.type, cause);
      sendAgent({ type: "failed", sessionId: command.sessionId, message: cause instanceof Error ? cause.message : String(cause) });
    });
}

async function drop(library: string): Promise<void> {
  if (pool === null) throw new Error("kernel runtime is not initialized");
  // 先停这个库里在跑的轮、等它们收尾，再关库删文件（删正在跑的会话 = 先停再删）
  await sessions?.closeLibrary(library);
  await pool.drop(library);
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
  if (command.type === "session") {
    runSession(command.root, command.command, ready);
    return;
  }
  if (command.type === "reply") {
    const forwarded = command.command;
    if (forwarded.type === "permissionAnswer") {
      turnRuntime.permissions.answer(forwarded.requestId, forwarded.answer);
    } else if (forwarded.type === "intentConfirmResult") {
      intentConfirm.answer(forwarded.requestId, forwarded.decision);
    } else if (isToolReply(forwarded)) {
      // 工具请求的回执（*Result）：与旧内核同一份翻法（request-broker.ts），结掉在途的工具调用
      turnRuntime.broker.resolve(forwarded.requestId, toolReplyResult(forwarded));
    }
    return;
  }
  if (command.type === "mcpReload") {
    // 全拆，下一轮开机按新配置重建（与旧内核同义）
    void turnRuntime.mcpHub.reset().then(() => sendAgent({ type: "mcp", servers: turnRuntime.mcpHub.describe() }));
    return;
  }
  if (command.type === "drop") {
    void ready
      .then(() => drop(command.library))
      .then(() => post({ type: "dropped", requestId: command.requestId }))
      .catch((cause: unknown) => post({ type: "dropped", requestId: command.requestId, error: cause instanceof Error ? cause.message : String(cause) }));
    return;
  }
  if (command.type === "shutdown") {
    void ready
      .then(async () => {
        await sessions?.shutdown();
        await pool?.closeAll();
        // MCP 服务进程是 kernel 拉起的：退出（含闲置回收）前一并关掉，不留给系统收
        await turnRuntime.mcpHub.reset();
      })
      .catch((cause: unknown) => console.error("[kernel-runtime] 退出收尾失败", cause))
      .finally(() => post({ type: "shutdownDone", requestId: command.requestId }));
    return;
  }
  command satisfies never;
});

post({ type: "ready" });
