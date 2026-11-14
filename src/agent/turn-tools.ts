/**
 * 一轮的工具装配——**两个内核共用的那一份**。
 *
 * 旧内核（runtime.ts 的 openTurn，pi-coding-agent）把这里返回的 ToolDefinition 当 customTools 交给 pi；
 * 新内核（kernel-turn.ts，pi-durable）把**同一批对象**经 durable-tools.ts 的薄适配注册进 durable。
 * 工具的逻辑（参数、描述、execute）只在各 `*-tools.ts` 里写一份，这里只决定「这一轮装哪些、按什么顺序、
 * 各自拿什么依赖」——顺序就是发给模型的工具清单顺序，两边必须一致（提示缓存对它逐字节敏感）。
 *
 * 内建七件（read / write / edit / bash / grep / find / ls）不在这里：旧内核由 pi 按 `defaultTools`
 * 设置自己建，新内核用 pi 建它们的同一个工厂（见 durable-tools.ts）。
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { AgentCommand } from "../shared/agent-ipc.ts";
import type { PermissionMode } from "../shared/permission.ts";
import { AUTOMATION_TOOL_NAMES, createAutomationTools } from "./automation-tools.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { createChannelTools } from "./channel-tools.ts";
import { createDocTools } from "./doc-tools.ts";
import { createDocxTools } from "./docx-tools.ts";
import { createGoalTools } from "./goal-tools.ts";
import { createImageTools } from "./image-tools.ts";
import { createMemoryTools, MEMORY_TOOL_NAMES } from "./memory-tools.ts";
import { createPdfTools } from "./pdf-tools.ts";
import { createPlanTools, type PlanToolOptions } from "./plan-tools.ts";
import { createPluginTools, PLUGIN_TOOL_NAMES } from "./plugin-tools.ts";
import type { RequestBroker } from "./request-broker.ts";
import { createSlidesTools } from "./slides-tools.ts";
import { createStoreTools } from "./store-tools.ts";
import { createTaskTools } from "./task-tools.ts";
import { createTerminalTools, TERMINAL_TOOL_NAMES } from "./terminal-tools.ts";

/** 开一轮需要的装配输入：submit / interrupt / compact 命令共有的那几个字段。 */
export type TurnInput = Extract<AgentCommand, { type: "submit" | "interrupt" | "compact" }>;

/**
 * 子会话身份：开轮目录清单的 related 里有 `relation === "parent"` 的一项 → 本会话是被
 * 派出的子会话。通道工具、记忆工具的注册与召回块的纠错提示都认它一处。
 */
export function isChildSession(command: { directories?: { related?: readonly { relation: string }[] } }): boolean {
  return command.directories?.related?.some((entry) => entry.relation === "parent") === true;
}

/** 这一轮装哪几组可选工具：注册与提示词段（权限名单、记忆指引…）必须同用这一个判定 */
export interface TurnToolFlags {
  /**
   * 子会话身份（2026-09-23）：决定注册哪些通道工具（createChannelTools）、讲哪段通道
   * 提示词（describeChannelRole）——两处判定必须同源，不能分别猜（isChildSession）。
   */
  role: "root" | "child";
  /**
   * 记忆工具（memory_search / revise / retire）只给根会话、且记忆开着时注册——子会话读不写。
   * 注册与提示词段（MEMORY_TOOLS_GUIDELINE）、召回块里的纠错提示同用这一个判定。
   */
  memoryTools: boolean;
  /**
   * 自动化工具：主进程只在这条会话不是自动化跑出来的时候带
   * automationTools；这里再叠一道「只给根会话」。与记忆工具同一个装配方式，提示词名单里也同步。
   */
  automationTools: boolean;
  /** 插件工具：命令带 pluginTools 才注册 install_plugin / preview_plugin / list_plugins（子会话不装插件，只有根会话注册） */
  pluginTools: boolean;
}

export function turnToolFlags(command: TurnInput): TurnToolFlags {
  const role: "root" | "child" = isChildSession(command) ? "child" : "root";
  return {
    role,
    memoryTools: "sessionMemory" in command && command.sessionMemory === true && role === "root",
    automationTools: "automationTools" in command && command.automationTools === true && role === "root",
    pluginTools: command.pluginTools === true && role === "root",
  };
}

/**
 * 本轮计入权限说明与稳定性指纹的非内建工具名单（系统提示的权限段与提示词稳定性记账共用这一份真源）：
 * MCP 工具 + 内置自定义工具 + 终端组 + 本会话实际注册的通道工具。
 */
export function extraToolNames(mcpToolNames: readonly string[], flags: TurnToolFlags): string[] {
  return [
    ...mcpToolNames,
    "create_skill",
    "add_mcp_server",
    "read_task",
    ...TERMINAL_TOOL_NAMES,
    ...(flags.role === "root" ? ["delegate", "reply_subsession", "model_costs"] : ["report_to_parent"]),
    ...(flags.memoryTools ? MEMORY_TOOL_NAMES : []),
    ...(flags.automationTools ? AUTOMATION_TOOL_NAMES : []),
    ...(flags.pluginTools ? PLUGIN_TOOL_NAMES : []),
  ];
}

/**
 * 拷图进文档 / 演示文稿时，工作区与附加目录之外额外放行的读根：会话工作台、本会话的附件副本目录、
 * 浏览器下载目录——系统提示词里都明说「可以去读」。其余位置（含 `../` 与工作区外绝对路径）一律不放。
 */
export function imageReadRoots(command: {
  attachmentsDir: string;
  directories?: { workbench: string; browserDownloads?: string };
}): string[] {
  const roots = [command.attachmentsDir];
  if (command.directories !== undefined) {
    roots.push(command.directories.workbench);
    if (command.directories.browserDownloads !== undefined) roots.push(command.directories.browserDownloads);
  }
  return roots.filter((root) => root !== "");
}

/** createTurnTools 的依赖：各内核把自己那份会话状态的读法传进来，工具本身不知道跑在哪个内核上 */
export interface TurnToolDeps {
  command: TurnInput;
  flags: TurnToolFlags;
  /** 工具 → 主进程的请求通道（建 skill、读任务、浏览器、终端……的回执由各内核的命令分支结掉） */
  broker: RequestBroker;
  /** 这一轮这个工作区的 MCP 工具（McpHub.toolsFor 的结果） */
  mcpTools: readonly ToolDefinition[];
  currentMode: () => PermissionMode;
  planOptions: PlanToolOptions;
  /** 当前叶子路径上的会话条目（pi SessionEntry 的形状：`{ type: "message", message }` 等），update_goal 找上一个目标用 */
  branch: () => readonly unknown[];
  /** 用户附过的图（最近的在前），slides_insert_image 认 "attached" 用 */
  attachedImages: () => string[];
  /** 本轮轮号（记忆工具记 revise 新条的出处轮用） */
  memoryTurn: () => number;
}

/** 这一轮的非内建工具，**顺序即发给模型的顺序**。 */
export function createTurnTools(deps: TurnToolDeps): ToolDefinition[] {
  const { command, flags, broker } = deps;
  return [
    ...deps.mcpTools,
    // read_pdf 不过 broker：附件副本与工作区 PDF 都在 agent read 边界内，直读（./pdf-tools.ts）
    // cite_pdf 挂在实验功能「PDF 引用」的开关后面（缺席 = 关）
    ...createPdfTools(command.cwd, { pdfCitations: command.pdfCitations === true }),
    // read_docx 同样直读（./docx-tools.ts）：word 文档的结构化提取，块号轴分片
    ...createDocxTools(command.cwd),
    // show_image 同样直读展示（./image-tools.ts）：模型「把图给用户看」的显式动作
    ...createImageTools(command.cwd),
    // update_plan（./plan-tools.ts）：agent 写下计划、做一步勾一步；计划就在转录里，不另存
    ...createPlanTools(deps.planOptions),
    // update_goal（./goal-tools.ts）：agent 替用户记下会话级目标；目标就在转录里，不另存
    ...createGoalTools({ branch: deps.branch }),
    ...createStoreTools(broker, command.sessionId),
    ...(flags.pluginTools ? createPluginTools(broker, command.sessionId, deps.currentMode) : []),
    ...createTaskTools(broker, command.sessionId),
    ...createBrowserTools(broker, command.sessionId),
    // 演示文稿（./slides-tools.ts）：slides_create / read / write / edit / insert_image / export。
    // 文件读写在本进程直做（路径限工作区 + 附加目录），只有导出过 broker 找主进程
    ...createSlidesTools(broker, command.sessionId, {
      cwd: command.cwd,
      writeRoots: [command.cwd, ...(command.directories?.attached ?? [])],
      workspaceId: command.workspaceId,
      imageReadRoots: imageReadRoots(command),
      attachedImages: deps.attachedImages,
    }),
    // 文档（./doc-tools.ts）：doc_open / doc_insert_image / doc_export。文件读写在本进程直做（路径限工作区 + 附加目录），
    // 只有导出过 broker 找主进程（PDF 要隐藏窗口）
    ...createDocTools(broker, command.sessionId, {
      cwd: command.cwd,
      writeRoots: [command.cwd, ...(command.directories?.attached ?? [])],
      workspaceId: command.workspaceId,
      imageReadRoots: imageReadRoots(command),
      mode: deps.currentMode,
    }),
    // agent 的终端工具组（PR2）：开可见终端、写命令、读输出。
    // 本分支只有用户发起这一种来源（没有定时任务 / 委派 / 外部桥），所以这里不按来源
    // 拦；将来自动化入口出现时，在这里按来源决定要不要注册——Proma 的判据是
    // 「没有用户在场的来源不配拿可见终端」（它会悄悄扩大权限）
    ...createTerminalTools(broker, command.sessionId, {
      cwd: command.cwd,
      // 授权目录与开轮目录清单同源：prompt 里说「你可以去这些目录」，这里就认这些
      authorizedDirs: [command.cwd, ...(command.directories?.attached ?? [])],
    }),
    ...createChannelTools(broker, command.sessionId, flags.role),
    ...(flags.memoryTools
      ? createMemoryTools(broker, command.sessionId, {
          scope: { workspaceId: command.workspaceId, cwd: command.cwd },
          turn: deps.memoryTurn,
        })
      : []),
    ...(flags.automationTools ? createAutomationTools(broker, command.sessionId, deps.currentMode) : []),
  ];
}
