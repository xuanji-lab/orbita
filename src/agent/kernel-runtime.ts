/**
 * 新内核（pi-durable）的 utility 进程入口——与 agent / terminal / memory runtime 平行的第四个入口
 * （electron.vite.config 的 main 多入口）。**薄壳**：库池与迁移在 kernel.ts / legacy-migrate.ts
 * （纯模块，`node --test` 直接测），这里只管 parentPort 收发与模型目录。
 *
 * 只在开发开关 ORBITA_DURABLE_KERNEL=1 时由主进程拉起（main/agent/kernel-host.ts）；开关关着时
 * 这个进程不存在，agent runtime 一个字节都没变。单独一个进程而不是塞进 agent runtime：这一步不切换
 * 主循环，agent 进程不该为一个默认关着的开关多加载一整套 durable（启动时间与常驻内存，剧本第 3 条）。
 * 主循环迁过来那一步，库池随之搬进 agent 进程，这个入口删掉。
 *
 * 为什么是 utility 进程：SQLite 的同步调用（node:sqlite 是同步 API）与大会话迁移的 JSON 处理
 * 都不该占主进程的事件循环；崩溃也不带走窗口。
 */
import type { Models } from "@earendil-works/pi-ai";
import type { KernelCommand, KernelMessage } from "../shared/kernel.ts";
import { KernelPool } from "./kernel.ts";
import { createModelRuntime } from "./model-catalog.ts";
import { registerAndResolveModel } from "./model-registration.ts";

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
      const model = registerAndResolveModel(runtime, agent.provider, agent.modelId);
      return model === undefined ? undefined : { contextWindow: model.contextWindow };
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
  if (command.type === "open") {
    const { requestId, sessionId } = command;
    void ready
      .then(() => {
        if (pool === null) throw new Error("kernel runtime is not initialized");
        return pool.open({ library: command.library, sessionId, legacy: command.legacy, agent: command.agent });
      })
      .then((result) => {
        if (result.ok) {
          console.error(
            `[kernel] ${sessionId} → ${command.library} 会话 ${result.conversationId}` +
              (result.migrated ? `，迁入 ${result.entries} 条，${result.ms}ms` : "（库里已有）"),
          );
        } else {
          console.error(`[kernel] ${sessionId} 打不开：${result.reason}`);
        }
        post({ type: "opened", requestId, sessionId, result });
      })
      .catch((cause: unknown) => {
        post({ type: "opened", requestId, sessionId, result: { ok: false, reason: cause instanceof Error ? cause.message : String(cause) } });
      });
    return;
  }
  if (command.type === "drop") {
    const { requestId } = command;
    void ready
      .then(() => {
        if (pool === null) throw new Error("kernel runtime is not initialized");
        return pool.drop(command.library);
      })
      .then(() => post({ type: "dropped", requestId, error: null }))
      .catch((cause: unknown) => post({ type: "dropped", requestId, error: cause instanceof Error ? cause.message : String(cause) }));
  }
});

post({ type: "ready" });
