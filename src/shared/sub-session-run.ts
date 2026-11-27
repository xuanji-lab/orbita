/**
 * 子会话一轮落在转录尾巴上的终局。只保留判定需要的最小字段，避免主进程为了收尾
 * 把工具结果正文、截图等大块内容留在内存里。纯模块，node --test 可直接加载。
 */
import type { ChannelEndCause, ChannelTerminalKind } from "./channel.ts";

export type SubSessionRunRecord =
  | {
      role: "assistant";
      status: string;
      stopReason: string;
      errorMessage?: string;
      hasToolCall: boolean;
    }
  | { role: "tool"; status: string }
  | { role: "user" }
  | { role: "channel-mark"; from: string; kind: string };

export interface SubSessionRunOutcome {
  kind: ChannelTerminalKind;
  endCause: ChannelEndCause;
  /** 厂商错误原文（有就保留，界面分类不吞排障信息）；正常结束 / 中断可以为空。 */
  text: string;
}

/** 把 JSONL 的一行压成终局判定需要的形状；不认识的行返回 null。 */
export function subSessionRunRecordOf(raw: unknown): SubSessionRunRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Record<string, unknown>;
  switch (value["role"]) {
    case "assistant": {
      const content = value["content"];
      const hasToolCall =
        Array.isArray(content) &&
        content.some(
          (block) => typeof block === "object" && block !== null && (block as Record<string, unknown>)["type"] === "toolCall",
        );
      return {
        role: "assistant",
        status: typeof value["status"] === "string" ? value["status"] : "",
        stopReason: typeof value["stopReason"] === "string" ? value["stopReason"] : "",
        ...(typeof value["errorMessage"] === "string" ? { errorMessage: value["errorMessage"] } : {}),
        hasToolCall,
      };
    }
    case "tool":
      return { role: "tool", status: typeof value["status"] === "string" ? value["status"] : "" };
    case "user":
      return { role: "user" };
    case "channel-mark":
      return {
        role: "channel-mark",
        from: typeof value["from"] === "string" ? value["from"] : "",
        kind: typeof value["kind"] === "string" ? value["kind"] : "",
      };
    default:
      return null;
  }
}

/** 厂商错误串 → 稳定的界面分类。顺序有意：违规拒答可能同时带 403，不能因此归成网络 / 钥匙。 */
export function failureCauseOf(text: string): Extract<ChannelEndCause, "quota" | "refusal" | "network" | "model"> {
  const lower = text.toLowerCase();
  if (/violat|refus|content.?policy|safety.?policy|违规|拒答/.test(lower)) return "refusal";
  if (/\b429\b|quota|rate.?limit|insufficient.*(?:quota|credit)|额度|次数用尽/.test(lower)) return "quota";
  if (/fetch failed|network|econn|etimedout|timed out|timeout|socket|disconnect|网络/.test(lower)) return "network";
  return "model";
}

export function failedRunOutcome(text: string): SubSessionRunOutcome {
  return { kind: "failed", endCause: failureCauseOf(text), text: text.trim().slice(0, 4000) };
}

/**
 * 最后一条有效记录决定终局：
 * - assistant error = 失败；
 * - assistant 完整 stop 且没有工具调用 = 正常结束；
 * - tool / user / 新收到的父通道标记、assistant toolUse / aborted / streaming = 中断。
 * file-turn / compaction 等非消息记录由读取侧略过：正常回答后的文件账不改变“已结束”。
 */
export function subSessionRunOutcome(
  records: readonly SubSessionRunRecord[],
  interruptedCause: Extract<ChannelEndCause, "app-exit" | "process-exit" | "incomplete">,
): SubSessionRunOutcome {
  const last = records[records.length - 1];
  if (last === undefined) return { kind: "interrupted", endCause: interruptedCause, text: "" };
  if (last.role !== "assistant") return { kind: "interrupted", endCause: interruptedCause, text: "" };
  if (last.status === "error" || last.stopReason === "error") return failedRunOutcome(last.errorMessage ?? "");
  if (last.status === "aborted" || last.stopReason === "aborted") {
    return { kind: "interrupted", endCause: "aborted", text: "" };
  }
  if (last.status === "complete" && last.stopReason === "stop" && !last.hasToolCall) {
    return { kind: "done", endCause: "completed", text: "" };
  }
  return { kind: "interrupted", endCause: interruptedCause, text: "" };
}
