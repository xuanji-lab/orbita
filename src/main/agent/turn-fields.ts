/**
 * AgentTurnContext 的 renderer 载荷 → AgentCommand 的公共字段（submit / interrupt /
 * compact 共用）。**纯模块**：不 import electron，可被 `node --test` 直接测
 * （write-requests.ts 的同款先例）——ipc.ts 只做路由与装配。
 */
import type {
  AgentCommand,
  ComputerUseTurnContext,
  ProviderSecrets,
  SubmitAgentInput,
  TurnDirectories,
  CompactAgentInput,
} from "../../shared/agent-ipc.ts";
import type { AppSettings, CompactionSetting, Language } from "../../shared/settings.ts";
import { effectiveAllowNetwork, effectiveComputerUseBackend, effectiveLanguage } from "../../shared/settings.ts";
import { backendNetworkControl, type ComputerUseRunningFacts } from "../../shared/computer-use.ts";
import { computerUsePlatformSupport } from "../../shared/computer-use-platform.ts";
import type { McpServer } from "../../shared/mcp.ts";

/**
 * 电脑使用的开轮现场：实验开关 + 平台支持 + 沙箱出网，**从同一份设置值**一次算出
 * （平台是进程事实，由调用方传 process.platform 进来）。
 *
 * 抽成纯函数是为了能被 `node --test` 钉住：真正的读取点 `readComputerUse()` 在
 * ipc.ts 里（要 electron，起不来），而这层映射——「哪个开关管注册、哪个值管提示词、
 * 老 settings.json 缺字段时兑什么缺省」——恰好是最容易改坏的部分。读一次、算一次，
 * 仍然是 ipc.ts 那一份读，没有第二套读写。
 */
export function computerUseTurnContext(
  settings: AppSettings | undefined,
  /** process.platform：平台这层判定只有 win32 算支持；由 ipc.ts 传进来，这里不读全局 */
  platform: string,
  /**
   * 正在跑的那只隔离启动时定下来的事实（运行时门面的 runningFacts()）；没在跑 = null。
   * **以它为准，不以设置为准**：后端与出网开关都是「下次启动才生效」，拿设置算会在
   * 「设置选 wsb / 实际跑着 L2b」或「运行中把开关关掉」时对模型说假话。
   */
  running?: ComputerUseRunningFacts | null,
): ComputerUseTurnContext {
  // 在跑的那只的后端才是真值；一只都没跑时退回设置值（那时工具只会回「沙箱没运行」，
  // 宣不宣称都没有实际影响）
  const backend = running?.backend ?? effectiveComputerUseBackend(settings);
  return {
    enabled: settings?.experimentalFeatures?.["computer-use"] === true,
    // 与设置页读同一个谓词（shared/computer-use-platform.ts）：非 Windows 上工具组不注册
    platformSupported: computerUsePlatformSupport(platform).supported,
    // 开关同样用启动时那份：运行中改了不会影响这一局，说「网页打不开」会是假话
    allowNetwork: running === undefined || running === null ? effectiveAllowNetwork(settings) : running.allowNetwork,
    // 两个事实分开算：用户选了什么（上一行）与这个后端做不做得到（这一行）。
    // 「在跑的是断不了网的 L2b」时得到的是「断不了网」那句，不是「你没有网」。
    networkControlled: backendNetworkControl(backend) === "enforced",
    // 界面语言：工具回执正文与它同一口径（回执也显示给用户）
    uiLanguage: effectiveLanguage(settings?.language),
  };
}

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
    /** 实验功能「电脑使用」的现场（settings.experimentalFeatures）：开着才注册沙箱工具组；
     * 其中 allowNetwork 是「用户选了什么」、networkControlled 是「这个后端能不能兑现」
     * ——两者同时成立才告诉模型它没有出网 */
    computerUse: ComputerUseTurnContext;
    /** 「先给我看计划」偏好（settings.planFirst）：开着时第一张新计划写完就停下等你点头；缺席 = 关 */
    planFirst: boolean;
    /** 插件工具的注册开关：true 才注册 install_plugin / preview_plugin / list_plugins */
    pluginTools: boolean;
    /** 所属工作区名字（store-tools 的 scope 指引讲归属用）；语义同命令字段——缺席 = 翻不出名字 */
    workspaceName?: string;
  },
): Pick<Extract<AgentCommand, { type: "submit" }>, "sessionId" | "cwd" | "workspaceId" | "workspaceName" | "provider" | "modelId" | "thinkingLevel" | "piSessionDir" | "attachmentsDir" | "piSessionFile" | "protectedPaths" | "skillsDirs" | "directories" | "mcpServers" | "compaction" | "gitAttribution" | "attributionLanguage" | "computerUse" | "planFirst" | "pluginTools"> {
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
