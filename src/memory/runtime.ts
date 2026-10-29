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
});

parentPort.on("message", (event: { data: unknown }) => {
  const command = event.data as MemoryServiceCommand;
  if (command.type === "init") {
    chore = command.chore ?? null;
    void core.init(command.dir, command.chore);
    return;
  }
  if (command.type === "turnSettled") {
    if (command.chore !== undefined) chore = command.chore;
    core.turnSettled(command);
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
});

post({ type: "ready" });
parentPort.start?.();
