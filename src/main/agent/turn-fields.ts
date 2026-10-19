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
import type { CompactionSetting, Language, ModelPair } from "../../shared/settings.ts";
import type { McpServer } from "../../shared/mcp.ts";

export function turnFields(
  input: SubmitAgentInput | CompactAgentInput,
  provider: ProviderSecrets,
  piSessionDir: string,
  /** 本会话的附图原图目录：图片字节预算的占位拼原图绝对路径用（同 piSessionDir 的纪律） */
  attachmentsDir: string,
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
    /** 实验功能「PDF 引用」的开关（settings.experimentalFeatures）：开着才注册 cite_pdf；缺席 = 关 */
    pdfCitations: boolean;
    /** 设置里的子会话模型（settings.subSessionModel）：提示词讲「不点名时子会话落到哪」用；缺席 = 没设 */
    subSessionModel?: ModelPair;
    /** 所属工作区名字（store-tools 的 scope 指引讲归属用）；语义同命令字段——缺席 = 翻不出名字 */
    workspaceName?: string;
  },
): Pick<Extract<AgentCommand, { type: "submit" }>, "sessionId" | "cwd" | "workspaceId" | "workspaceName" | "provider" | "modelId" | "mode" | "thinkingLevel" | "piSessionDir" | "attachmentsDir" | "piSessionFile" | "protectedPaths" | "skillsDirs" | "directories" | "mcpServers" | "compaction" | "gitAttribution" | "attributionLanguage" | "pdfCitations" | "subSessionModel"> {
  // workspaceName / subSessionModel 缺席时彻底不进命令对象（可送化与深比较都要稳定形状）：
  // 有工作区但翻不出名字是「未知」，不是「无工作区」——两态靠 workspaceId 区分
  const { workspaceName, subSessionModel, ...rest } = environment;
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    // MCP 连接按工作区分片（同一工作区共用一份，不同工作区各一份实例）
    workspaceId: input.workspaceId,
    ...(workspaceName === undefined ? {} : { workspaceName }),
    ...(subSessionModel === undefined ? {} : { subSessionModel }),
    provider,
    modelId: input.modelId,
    mode: input.mode,
    thinkingLevel: input.thinkingLevel,
    piSessionDir,
    attachmentsDir,
    protectedPaths,
    ...rest,
    // 续会话的唯一通路：把 pi 自己的本子还给它（runtime 的 SessionManager.open）。
    // 缺了它 runtime 每轮都新建本子——模型看不到前文，created 事件还会把 meta 改指到
    // 新本子上，回退从此对不上账（2026-10-11 抽出本模块时漏过这一行的事故）
    ...(input.resume !== null ? { piSessionFile: input.resume.piSessionFile } : {}),
  };
}
