/**
 * AgentTurnContext 的 renderer 载荷 → AgentCommand 的公共字段（submit / interrupt /
 * compact 共用）。**纯模块**：不 import electron，可被 `node --test` 直接测
 * （write-requests.ts 的同款先例）——ipc.ts 只做路由与装配。
 */
import type {
  AgentCommand,
  ProviderSecrets,
  SubmitAgentInput,
  TurnDirectories,
  CompactAgentInput,
} from "../../shared/agent-ipc.ts";
import type { CompactionSetting, Language } from "../../shared/settings.ts";
import type { McpServer } from "../../shared/mcp.ts";

export function turnFields(
  input: SubmitAgentInput | CompactAgentInput,
  provider: ProviderSecrets,
  piSessionDir: string,
  /** 工具禁区（sessions/ 与 pi-sessions/）：主进程定，随每轮发给闸门 */
  protectedPaths: string[],
  /** 开轮环境（skill 集合目录 + MCP 配置 + 压缩偏好 + Git 标识 + 目录清单）：无状态化后每轮命令都要带全 */
  environment: {
    skillsDirs: string[];
    directories: TurnDirectories;
    mcpServers: Record<string, McpServer>;
    compaction: CompactionSetting;
    gitAttribution: boolean;
    attributionLanguage: Language;
    /** 所属工作区名字（store-tools 的 scope 指引讲归属用）；语义同命令字段——缺席 = 翻不出名字 */
    workspaceName?: string;
  },
): Pick<Extract<AgentCommand, { type: "submit" }>, "sessionId" | "cwd" | "workspaceId" | "workspaceName" | "provider" | "modelId" | "mode" | "thinkingLevel" | "piSessionDir" | "protectedPaths" | "skillsDirs" | "directories" | "mcpServers" | "compaction" | "gitAttribution" | "attributionLanguage"> {
  // workspaceName 缺席时彻底不进命令对象（可送化与深比较都要稳定形状）：
  // 有工作区但翻不出名字是「未知」，不是「无工作区」——两态靠 workspaceId 区分
  const { workspaceName, ...rest } = environment;
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    // MCP 连接按工作区分片（同一工作区共用一份，不同工作区各一份实例）
    workspaceId: input.workspaceId,
    ...(workspaceName === undefined ? {} : { workspaceName }),
    provider,
    modelId: input.modelId,
    mode: input.mode,
    thinkingLevel: input.thinkingLevel,
    piSessionDir,
    protectedPaths,
    ...rest,
  };
}
