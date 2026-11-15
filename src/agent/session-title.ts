/**
 * 会话标题生成（C-3）与家务活模型的解析（kernel-session.ts 调）——
 * 「标题怎么生成、失败怎么静默、超时多久」只有一套真相。在途去重（同一会话连发两条只生成一次）由调用方管。
 */
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { AgentCommand, AgentEvent } from "../shared/agent-ipc.ts";
import { ccBillingPatch } from "./cc-billing-patch.ts";
import { createModelRuntime } from "./model-catalog.ts";
import { registerAndResolveModel, type PiModel } from "./model-registration.ts";
import { normalizeGeneratedTitle, TITLE_SYSTEM_PROMPT } from "./title.ts";

/**
 * 家务活模型（起名等小活专用）的鉴权面。**密钥不能沿用账本里的**——账本里那把是会话当前
 * provider 的，拿它去调另一家只会 401。
 */
export interface ResolvedChoreModel {
  model: PiModel;
  apiKey: string;
  headers?: Record<string, string>;
}

/**
 * 解析家务活模型（设置里的 choreModel，主进程已把密钥面装配好）。
 * 自建一次性 ModelRuntime 走同一套「注册 + 解析」（同 setLedgerModel）：
 * 「能不能用某个模型」在本仓只应该有一套真相。
 * 解不出来返回 null，由调用方退回会话模型——用户删了那家 provider 不该
 * 连带把标题停掉。
 */
export async function resolveChoreModel(
  payload: NonNullable<Extract<AgentCommand, { type: "generateTitle" }>["model"]>,
): Promise<ResolvedChoreModel | null> {
  try {
    const runtime = await createModelRuntime();
    const model = registerAndResolveModel(runtime, payload.provider, payload.modelId);
    if (model === undefined) {
      console.warn(`[title] 指定的 ${payload.provider.id}/${payload.modelId} 解析不到，退回会话模型`);
      return null;
    }
    return {
      model,
      apiKey: payload.provider.apiKey,
      ...(payload.provider.headers ? { headers: payload.provider.headers } : {}),
    };
  } catch (cause) {
    console.warn("[title] 指定模型装配失败，退回会话模型：", cause);
    return null;
  }
}

const TITLE_TIMEOUT_MS = 30_000;

/**
 * 生成一次标题：成功经 `title` 事件发出；失败静默（侧栏保留首句截断），原因落 dev 终端。
 * sessionModel / auth：会话当前的模型与它的鉴权面；choreModel：设置里的家务活模型（缺席或解析失败退回会话模型）。
 */
export async function generateTitle(input: {
  sessionModel: PiModel | undefined;
  auth: { apiKey: string; headers?: Record<string, string> };
  sessionId: string;
  text: string;
  choreModel?: NonNullable<Extract<AgentCommand, { type: "generateTitle" }>["model"]>;
  send: (event: AgentEvent) => void;
}): Promise<void> {
  try {
    const dedicated = input.choreModel === undefined ? null : await resolveChoreModel(input.choreModel);
    const model = dedicated?.model ?? input.sessionModel;
    if (model === undefined) return;
    // 鉴权面跟着模型走，**整个换不逐键兼**：专用模型没自定义头时继承账本里
    // 那份（另一家的），往往正是鉴权失败的来源
    const auth: { apiKey: string; headers?: Record<string, string> } =
      dedicated ?? input.auth;
    // **30 秒硬超时必须有**：标题与当前轮并发抢 provider，请求可能被网关挂住
    // 不返回——没有超时的话 titleInFlight 永远不放，这条会话之后的所有重试
    // 都被在途守卫吞掉（真实事故：一条会话 17 条消息一次标题都没成）。
    const response = await completeSimple(
      model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [{ role: "user", content: input.text, timestamp: Date.now() }],
      },
      {
        apiKey: auth.apiKey,
        maxTokens: 1024,
        timeoutMs: TITLE_TIMEOUT_MS,
        signal: AbortSignal.timeout(TITLE_TIMEOUT_MS),
        // 会话模型（或家务活模型）可能是 OAuth Claude：标题调用不经主循环的扩展
        // 通路，车道改写随 options 带上，否则 OAuth 车道上标题永远静默失败
        onPayload: ccBillingPatch,
        ...(auth.headers ? { headers: auth.headers } : {}),
      },
    );
    if (response.stopReason === "error") {
      console.error(`[title] ${model.id} 响应错误：`, response.errorMessage);
      return;
    }
    let output = "";
    for (const block of response.content) {
      if (block.type === "text") output += block.text;
    }
    const title = normalizeGeneratedTitle(output);
    if (title !== null) {
      input.send({ type: "title", sessionId: input.sessionId, title });
    } else {
      // 失败本就静默（侧栏保留首句截断），但原因必须落到 dev 终端，
      // 否则「为什么大多数会话没有标题」无从查起
      console.warn(
        `[title] ${model.id} 放弃（none/空/超长），原文前 120 字：${JSON.stringify(output.slice(0, 120))}`,
      );
    }
  } catch (cause) {
    console.error("[title] 生成失败：", cause);
  }
}
