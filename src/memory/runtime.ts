/**
 * 记忆服务的 utility 进程入口（与 agent / terminal runtime 平行的第三个 utility
 * 入口，electron.vite.config 的 main 多入口）。**薄壳**：编排全在 service-core.ts
 * （纯模块，可 `node --test` 直接测），这里只做三件事——parentPort 收发、真模型
 * 调用（completeSimple，家务活模型的密钥面由主进程装配好随命令送来）、日志。
 *
 * 崩溃不影响主进程与 agent：主进程的 MemoryServiceHost 检测到退出会清掉在途
 * 回忆请求（回空命中），下次要用时重拉。
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createModelRuntime } from "../agent/model-catalog.ts";
import { registerAndResolveModel, type PiModel } from "../agent/model-registration.ts";
import { ccBillingPatch } from "../agent/cc-billing-patch.ts";
import type {
  MemoryChoreModel,
  MemoryServiceCommand,
  MemoryServiceMessage,
} from "../shared/memory.ts";
import { MemoryServiceCore, type MemoryCallModel } from "./service-core.ts";
import { spawn as spawnProcess } from "node:child_process";
import { createServer } from "node:net";
/** Electron 的 utility 进程 parentPort 的结构面（agent runtime 的 ParentPortLike 同款）。 */
type ParentPortLike = {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
  start?(): void;
};

const parentPort = (process as typeof process & { parentPort?: ParentPortLike }).parentPort;
if (parentPort === undefined) {
  console.error("[memory-runtime] 没有 parentPort——本文件只能作为 Electron utility 进程运行");
  process.exit(1);
}

function post(message: MemoryServiceMessage): void {
  parentPort?.postMessage(message);
}

/* ---------- 家务活模型的真调用（核心模块只认 callModel 注入） ---------- */

/** 记忆的小调用不比收尾清单大：120 秒已是宽限（主进程侧各路径不等它出结果）。 */
const CALL_TIMEOUT_MS = 120_000;

let chore: MemoryChoreModel | null = null;
let runtime: ModelRuntime | null = null;
/** 解析缓存：同一 provider/model 只解析一次；换模型（设置改了）才重解析 */
let resolved: { key: string; model: PiModel } | null = null;

const callModel: MemoryCallModel = async (system, prompt) => {
  if (chore === null) return null;
  try {
    runtime ??= await createModelRuntime();
    const key = `${chore.provider.id}/${chore.modelId}`;
    if (resolved?.key !== key) {
      const model = registerAndResolveModel(runtime, chore.provider, chore.modelId);
      if (model === undefined) {
        console.error(`[memory] 家务活模型 ${key} 解析不到（这批提取跳过，下轮重试）`);
        return null;
      }
      resolved = { key, model };
    }
    const response = await completeSimple(
      resolved.model,
      {
        systemPrompt: system,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      {
        apiKey: chore.provider.apiKey,
        maxTokens: 4096,
        timeoutMs: CALL_TIMEOUT_MS,
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
        // 家务活模型可能是 OAuth Claude：车道改写随 options 带上（choreComplete 同款）
        onPayload: ccBillingPatch,
        ...(chore.provider.headers ? { headers: chore.provider.headers } : {}),
      },
    );
    if (response.stopReason === "error") {
      console.error("[memory] 家务活模型调用失败：", response.errorMessage);
      return null;
    }
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    return text;
  } catch (cause) {
    console.error("[memory] 家务活模型调用抛错：", cause);
    return null;
  }
};

const core = new MemoryServiceCore({
  callModel,
  log: (message, ...args) => console.log(message, ...args),
  // 任何写盘后告诉主进程（它广播 memoryChanged 让界面重拉）
  onChanged: () => post({ type: "changed" }),
  onDownloadProgress: (progress) => post({ type: "downloadProgress", progress }),
  onBackfillProgress: (progress) => post({ type: "backfillProgress", progress }),
  // 主进程记下 pid：Windows 上 UtilityProcess.kill() 是 TerminateProcess，本进程的
  // exit / SIGTERM 处理都不会跑，只能靠主进程按 pid 补杀
  onEmbedServerPid: (pid) => post({ type: "embedServerPid", pid }),
  vectorDeps: {
    // llama-server 子进程：不 detached。它**不会**随本进程退出自动结束（Node 子进程
    // 在父进程被杀后照样活着），所以退出清理是三层：shutdown 命令 / SIGTERM / exit
    // 时 core.shutdown() 同步 kill（来得及就优雅），主进程再按 embedServerPid 补杀
    // （Windows 与本进程崩溃时唯一可靠的一层）。stdio 静默（日志我们自己记关键行）
    spawn: (args) => {
      const child = spawnProcess(args[0]!, args.slice(1), { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line !== "") console.error("[llama-server]", line.slice(0, 300));
      });
      return child;
    },
    probe: async (port) => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1500) });
        return response.ok;
      } catch {
        return false;
      }
    },
    post: async (port, texts) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/embeddings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input: texts }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!response.ok) throw new Error(`embeddings HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: { index: number; embedding: number[] }[] };
      const rows = payload.data ?? [];
      rows.sort((a, b) => a.index - b.index);
      return rows.map((row) => row.embedding);
    },
    // 先占一个空闲端口再交给 llama-server（listen 0 → 拿到即关；窗口极小的竞态可接受）
    freePort: () =>
      new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          const port = typeof address === "object" && address !== null ? address.port : 0;
          server.close(() => (port > 0 ? resolve(port) : reject(new Error("没拿到空闲端口"))));
        });
        server.on("error", reject);
      }),
    // undici 的 Response 与下载器的结构面之间架一层（getReader 的返回结构兼容）
    fetchImpl: async (url, signal) => {
      const response = await fetch(url, signal === undefined ? {} : { signal });
      const body = response.body;
      return {
        ok: response.ok,
        status: response.status,
        body: body === null ? null : { getReader: () => body.getReader() },
      };
    },
  },
});

parentPort.on("message", (event: { data: unknown }) => {
  const command = event.data as MemoryServiceCommand;
  if (command.type === "init") {
    chore = command.chore ?? null;
    // init 抛错（数据目录读不了等）不能变成未捕获 rejection 把进程带走——那样主进程
    // 每轮都会重拉、再死一次。接住、报 initFailed，由主进程停服务并不再重拉
    core.init(command.dir, command.chore).catch((cause: unknown) => {
      console.error("[memory] 记忆服务 init 失败", cause);
      post({ type: "initFailed", error: cause instanceof Error ? cause.message : String(cause) });
    });
    return;
  }
  if (command.type === "shutdown") {
    core.shutdown();
    process.exit(0);
  }
  if (command.type === "turnSettled") {
    if (command.chore !== undefined) chore = command.chore;
    core.turnSettled(command);
    return;
  }
  if (command.type === "historyTurn" || command.type === "historyFlush") {
    if (command.chore !== undefined) chore = command.chore;
    const { requestId } = command;
    const step = command.type === "historyTurn" ? core.historyTurn(command) : core.historyFlush(command);
    void step.then((outcome) => post({ type: "historyStepResult", requestId, outcome }));
    return;
  }
  if (command.type === "sessionReverted") {
    void core.sessionReverted(command);
    return;
  }
  if (command.type === "recall") {
    const { requestId } = command;
    void core
      .recall(command)
      .then((hits) => post({ type: "recallResult", requestId, hits }))
      .catch((cause: unknown) => {
        console.error("[memory] recall 路径抛错（回空命中）", cause);
        post({ type: "recallResult", requestId, hits: [] });
      });
    return;
  }
  if (command.type === "setVectorConfig") {
    core.setVectorConfig(command.config);
    return;
  }
  if (command.type === "setPower") {
    core.setPower(command.onBattery);
    return;
  }
  if (command.type === "vectorState") {
    const { requestId } = command;
    void core
      .vectorState()
      .then((state) => post({ type: "vectorStateResult", requestId, ...state }))
      .catch((cause: unknown) => {
        console.error("[memory] vectorState 抛错", cause);
        post({
          type: "vectorStateResult",
          requestId,
          llamaRunning: false,
          backfill: null,
          vectors: null,
        });
      });
    return;
  }
  if (command.type === "cancelModelDownload") {
    core.cancelModelDownload();
    return;
  }
  if (command.type === "startModelDownload") {
    core.startModelDownload(command);
    return;
  }
  if (command.type === "mutate") {
    const { requestId } = command;
    void core
      .mutate(command.mutation)
      .then((outcome) => post({ type: "mutateResult", requestId, ...outcome }))
      .catch((cause: unknown) => {
        console.error("[memory] mutate 路径抛错", cause);
        post({
          type: "mutateResult",
          requestId,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return;
  }
  if (command.type === "agentTool") {
    const { requestId } = command;
    void core
      .agentTool(command)
      .then((outcome) => post({ type: "agentToolResult", requestId, ...outcome }))
      .catch((cause: unknown) => {
        console.error("[memory] agentTool 路径抛错", cause);
        post({
          type: "agentToolResult",
          requestId,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return;
  }
});

// 退出清理（见 vectorDeps.spawn 的注释）：macOS / Linux 上 UtilityProcess.kill() 发
// SIGTERM——默认处理会直接退出、不跑 exit 回调，所以要显式接；exit 兜住
// process.exit 等其它退出路径。shutdown 只做同步 kill，可重入
process.on("SIGTERM", () => {
  core.shutdown();
  process.exit(0);
});
process.on("exit", () => core.shutdown());

post({ type: "ready" });
parentPort.start?.();
