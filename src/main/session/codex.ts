/**
 * Codex 的会话 rollout → pi Message 序列。读文件 + 转换两段，转换是纯函数。
 *
 * ## 源格式（依据：公开的逆向分析与第三方工具对 rollout 的交叉描述——dev.to
 * 「Reverse engineering Codex CLI rollout traces」、agentworth.dev、codingagent2otel
 * 的 transcript-formats、timescale/memory-engine 的 me-codex 文档；openai/codex 源码
 * 的 rollout 写入定义未逐行核对。**本机没有真实样本**，fixture 按这些描述构造，
 * 首次接真实数据时以樊嘉铭的样本校准。）
 *
 * 文件：`$CODEX_HOME`（默认 ~/.codex）/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl。
 * 每行一个 JSON 对象：`{ timestamp, type, payload }`，type ∈
 * session_meta / response_item / event_msg / turn_context：
 * - `session_meta.payload`：{ id, timestamp, cwd, cli_version, instructions? }（首行）
 * - `response_item.payload`：OpenAI Responses API 的 item——
 *   `{ type:"message", role:"user"|"assistant", content:[{type:"input_text"|"output_text"|"text", text}] }`；
 *   其余 item（reasoning / function_call / function_call_output / local_shell_call 等）
 * - `turn_context.payload`：{ cwd, model, ... }（模型 id 在这里）
 * - `event_msg.payload`：UI 事件，不含对话
 *
 * ## 转成 pi（取舍写明）
 *
 * - message(user/assistant) 进对话；reasoning 挂为 assistant 的 thinking 块。
 * - **工具调用（function_call / function_call_output / *_shell_call）不导**：历史
 *  迁移喂的是意图系统的 QA（用户话 + 助手最后一段文字）与续聊上下文，对话本体
 *  够用；配齐工具对要逐型核参数，等真实样本再做（skipped 不报——pi 本子里少
 *  一段工具史不影响两本账，账只数 user/assistant）。
 * - user 的系统注入剥掉：`<environment_context>` / `<user_instructions>` /
 *  `<ENVIRONMENT_CONTEXT>` 整块；剥完没有自己的话 = 用户没写（display null，
 *  进 pi 不显示——opencode 的 synthetic 同一条纪律）。
 * - session_meta 的 instructions（Codex 的系统提示词）不导。
 * - 模型：最后一个 turn_context 的 model（没有 = null，走映射兜底）。
 */
import type { AssistantMessage, Message, TextContent, ThinkingContent } from "@earendil-works/pi-ai";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Codex 的系统注入块（environment_context / user_instructions 等），非贪婪整块剥。 */
const CODEX_INJECTED = /<(environment_context|user_instructions|ENVIRONMENT_CONTEXT)>[\s\S]*?<\/\1>\s*/g;

/** rollout 里我们认的四种行 type（其余行跳过——rollout 还在加新行，宽容读取）。 */
export interface CodexRollout {
  /** session_meta.payload（缺了也能转：cwd/model 各有兜底） */
  meta: { id: string | null; cwd: string | null; timestamp: number };
  /** 对话消息（user / assistant 交替前的原始顺序） */
  messages: Message[];
  /** 每条 user 消息在 transcript 里的原文（剥注入后的用户自己的话）；null = 用户没写 */
  userDisplays: (string | null)[];
  /** 最后一个 turn_context 的模型 id */
  model: string | null;
  /** 最后一行的时间戳（updatedAt） */
  lastTimestamp: number;
  /** 第一条用户自己的话（标题候选）；没有为 null */
  firstPrompt: string | null;
  /** 有没有 assistant 产物（没有 = 不可转换，扫描侧 skip） */
  hasAssistant: boolean;
}

/** content 块数组 → 纯文本（input_text / output_text / text 各形态都认）。 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isRecord(block) && typeof block["text"] === "string") parts.push(block["text"]);
  }
  return parts.join("\n");
}

/** 剥 Codex 的系统注入；剥完 trim 为空返回 null（用户没写）。 */
export function codexUserText(text: string): string | null {
  const stripped = text.replace(CODEX_INJECTED, "").trim();
  return stripped === "" ? null : stripped;
}

/** 一份 rollout 文本 → 转换结果。坏行跳过（半截文件照转，前文不丢）；空文件 messages 空。 */
export function parseCodexRollout(raw: string): CodexRollout {
  let meta: CodexRollout["meta"] = { id: null, cwd: null, timestamp: 0 };
  let model: string | null = null;
  let lastTimestamp = 0;
  let firstPrompt: string | null = null;
  let hasAssistant = false;
  const messages: Message[] = [];
  const userDisplays: (string | null)[] = [];

  // assistant 的 reasoning 先攒着，遇到同轮的 assistant message 挂上去（rollout 里
  // reasoning 行在 message 行之前）
  let pendingThinking: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 半截行：跳过，前文保留
    }
    if (!isRecord(parsed)) continue;
    const timestamp = Date.parse(typeof parsed["timestamp"] === "string" ? parsed["timestamp"] : "");
    if (!Number.isNaN(timestamp)) lastTimestamp = Math.max(lastTimestamp, timestamp);
    const type = parsed["type"];
    const payload = parsed["payload"];
    if (!isRecord(payload)) continue;

    if (type === "session_meta") {
      const ts = Date.parse(typeof payload["timestamp"] === "string" ? payload["timestamp"] : "");
      meta = {
        id: typeof payload["id"] === "string" ? payload["id"] : null,
        cwd: typeof payload["cwd"] === "string" ? payload["cwd"] : null,
        timestamp: Number.isNaN(ts) ? timestamp : ts,
      };
      continue;
    }
    if (type === "turn_context") {
      if (typeof payload["model"] === "string" && payload["model"] !== "") model = payload["model"];
      if (meta.cwd === null && typeof payload["cwd"] === "string") meta.cwd = payload["cwd"];
      continue;
    }
    if (type !== "response_item") continue;
    const itemType = payload["type"];
    if (itemType === "reasoning") {
      // reasoning.payload：{summary:[{type:"summary_text",text}], content?}——摘要拼起来
      const summary = payload["summary"];
      if (Array.isArray(summary)) {
        const text = contentText(summary);
        if (text !== "") pendingThinking.push(text);
      }
      continue;
    }
    if (itemType !== "message") continue; // function_call 等工具项不导（见文件头取舍）
    const role = payload["role"];
    const text = contentText(payload["content"]);
    if (role === "user") {
      const display = codexUserText(text);
      messages.push({ role: "user", content: [{ type: "text", text }], timestamp: lastTimestamp });
      userDisplays.push(display);
      if (display !== null && firstPrompt === null) firstPrompt = display;
      continue;
    }
    if (role === "assistant" && text !== "") {
      hasAssistant = true;
      const content: (TextContent | ThinkingContent)[] = [];
      for (const thinking of pendingThinking) content.push({ type: "thinking", thinking });
      pendingThinking = [];
      content.push({ type: "text", text });
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        // api 标 Responses 协议族（rollout 是 Responses API 的记录）；usage 不在
        // rollout 里（计费走 event_msg，首版不解析），零值占位——续聊与 QA 都不吃它
        api: "openai-completions",
        stopReason: "stop",
        provider: "codex-import",
        model: model ?? "codex-unknown",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        timestamp: lastTimestamp,
      };
      messages.push(assistant);
    }
  }
  // 尾部没有 message 的 reasoning：丢弃（没有正文挂靠，单存的思考对续聊与 QA 都没用）
  return { meta, messages, userDisplays, model, lastTimestamp, firstPrompt, hasAssistant };
}
