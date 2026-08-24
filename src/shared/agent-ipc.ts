/**
 * agent 域契约 —— IPC 四层的第 1 层。
 *
 * 两条边界共用这一份定义：
 *   主进程 ↔ agent utility 进程（parentPort 信封）
 *   主进程 ↔ renderer（ipcMain / contextBridge）
 * 两边搬运的载荷都是 **pi-protocol 的类型**，我们只定义信封（guideline §三）。
 *
 * sessionId 从第一天就贯穿所有消息：一个 agent runtime 进程要托管 N 个 session，
 * 事后再补这个参数意味着每一处状态读写都要回头改。
 */
import type { SessionPhase, TranscriptProgress } from "@earendil-works/pi-protocol";

export const ipcChannels = {
  providerList: "provider:list",
  providerUpsert: "provider:upsert",
  providerRemove: "provider:remove",
  agentCreate: "agent:create",
  agentSubmit: "agent:submit",
  agentAbort: "agent:abort",
  agentEvent: "agent:event",
  providerBuiltins: "provider:builtins",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];

/**
 * pi 内建 provider 目录里的一条。目录由 pi 维护、每 4 小时从 pi.dev 刷新覆盖层，
 * 我们零维护——用户选中名字就拿到官方 baseUrl / 协议 / 模型清单。
 */
export interface BuiltinProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: string;
  models: string[];
}

/** 主进程 → agent 进程 */
export type AgentCommand =
  | {
      type: "create";
      sessionId: string;
      cwd: string;
      /** provider 装配参数。内建 id（zai / deepseek…）只靠 apiKey 就够，
       *  自建网关必须带 baseUrl / api / models，否则 pi 不知道往哪发。 */
      provider: {
        id: string;
        api: string;
        baseUrl: string;
        apiKey: string;
        headers?: Record<string, string>;
        models: string[];
      };
      modelId: string;
    }
  | { type: "submit"; sessionId: string; text: string }
  | { type: "abort"; sessionId: string }
  | { type: "listBuiltins" }
  | { type: "dispose"; sessionId: string };

/** agent 进程 → 主进程 → renderer（同一份形状，主进程只做转发） */
export type AgentEvent =
  | { type: "ready" }
  | { type: "builtins"; providers: BuiltinProvider[] }
  | { type: "created"; sessionId: string }
  | { type: "progress"; sessionId: string; progress: TranscriptProgress }
  | { type: "phase"; sessionId: string; phase: SessionPhase }
  | { type: "failed"; sessionId: string | null; message: string };

export interface CreateAgentInput {
  cwd: string;
  providerId: string;
  modelId: string;
}
