/**
 * 一轮的工具装配：kernel-turn.ts（pi-durable）把这里返回的 ToolDefinition 经 durable-tools.ts 的薄适配注册进 durable。
 * 工具的逻辑（参数、描述、execute）只在各 `*-tools.ts` 里写一份，这里只决定「这一轮装哪些、按什么顺序、
 * 各自拿什么依赖」——顺序就是发给模型的工具清单顺序（提示缓存对它逐字节敏感）。
 *
 * 内建四件（read / write / edit / bash）不在这里：用 pi 建它们的同一个工厂（见 durable-tools.ts）。
 */
import type { ToolDefinition } from "./agent-shapes.ts";
import type { AgentCommand } from "../shared/agent-ipc.ts";
import { createAutomationTools } from "./automation-tools.ts";
import { createBrowserTools } from "./browser-tools.ts";
import { createChannelTools } from "./channel-tools.ts";
import { createDocTools } from "./doc-tools.ts";
import { createDocxTools } from "./docx-tools.ts";
import { createGoalTools } from "./goal-tools.ts";
import { createImageTools } from "./image-tools.ts";
import { createMemoryTools } from "./memory-tools.ts";
import { createPdfTools } from "./pdf-tools.ts";
import { createPlanTools, type PlanToolOptions } from "./plan-tools.ts";
import { createPluginTools } from "./plugin-tools.ts";
import type { RequestBroker } from "./request-broker.ts";
import { createSlidesTools } from "./slides-tools.ts";
import { createStoreTools } from "./store-tools.ts";
import { createTaskTools } from "./task-tools.ts";
import { createTerminalTools } from "./terminal-tools.ts";
import { hasModule, isChatOnly, MODULE_SUMMARY, namedInstalled, type CapabilityModule } from "../shared/capabilities.ts";
import { parseQualifiedToolName } from "../shared/mcp.ts";

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
  /** 工作区的常驻主智能体（命令带 mainAgent，且只认根会话）：提示词加身份与派活规矩一段 */
  mainAgent: boolean;
}

export function turnToolFlags(command: TurnInput): TurnToolFlags {
  const role: "root" | "child" = isChildSession(command) ? "child" : "root";
  return {
    role,
    memoryTools: "sessionMemory" in command && command.sessionMemory === true && role === "root",
    automationTools: "automationTools" in command && command.automationTools === true && role === "root",
    pluginTools: command.pluginTools === true && role === "root",
    mainAgent: "mainAgent" in command && command.mainAgent === true && role === "root",
  };
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
  planOptions: PlanToolOptions;
  /** 当前叶子路径上的会话条目（pi SessionEntry 的形状：`{ type: "message", message }` 等），update_goal 找上一个目标用 */
  branch: () => readonly unknown[];
  /** 用户附过的图（最近的在前），slides_insert_image 认 "attached" 用 */
  attachedImages: () => string[];
  /** 本轮轮号（记忆工具记 revise 新条的出处轮用） */
  memoryTurn: () => number;
}

/** 一组工具属于哪个模块：`base` 恒带（能力集只在纯聊天时拿掉它）；`mcp` 按服务名逐个挑 */
type ToolGroup = { module: CapabilityModule | "base" | "mcp"; tools: ToolDefinition[] };

/** 这一轮的非内建工具，按模块分组，**组序与组内顺序即发给模型的顺序**（与能力集之前逐字节相同）。 */
function turnToolGroups(deps: TurnToolDeps): ToolGroup[] {
  const { command, flags, broker } = deps;
  return [
    { module: "mcp", tools: [...deps.mcpTools] },
    // read_pdf 不过 broker：附件副本与工作区 PDF 都在 agent read 边界内，直读（./pdf-tools.ts）
    // cite_pdf 挂在实验功能「PDF 引用」的开关后面（缺席 = 关）
    // read_docx 同样直读（./docx-tools.ts）：word 文档的结构化提取，块号轴分片
    { module: "pdf-docx", tools: [...createPdfTools(command.cwd, { pdfCitations: command.pdfCitations === true }), ...createDocxTools(command.cwd)] },
    // show_image 同样直读展示（./image-tools.ts）：模型「把图给用户看」的显式动作
    { module: "image", tools: createImageTools(command.cwd) },
    {
      module: "base",
      tools: [
        // update_plan（./plan-tools.ts）：agent 写下计划、做一步勾一步；计划就在转录里，不另存
        ...createPlanTools(deps.planOptions),
        // update_goal（./goal-tools.ts）：agent 替用户记下会话级目标；目标就在转录里，不另存
        ...createGoalTools({ branch: deps.branch }),
      ],
    },
    { module: "store", tools: createStoreTools(broker, command.sessionId) },
    // 插件工具只给根会话（子会话不装插件）；能力集只给子会话，两者不相交，归在 base 不改变任何一边
    { module: "base", tools: flags.pluginTools ? createPluginTools(broker, command.sessionId) : [] },
    { module: "tasks", tools: createTaskTools(broker, command.sessionId) },
    { module: "browser", tools: createBrowserTools(broker, command.sessionId) },
    {
      module: "docs-slides",
      tools: [
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
        }),
      ],
    },
    // agent 的终端工具组（PR2）：开可见终端、写命令、读输出。
    // 本分支只有用户发起这一种来源（没有定时任务 / 委派 / 外部桥），所以这里不按来源
    // 拦；将来自动化入口出现时，在这里按来源决定要不要注册——Proma 的判据是
    // 「没有用户在场的来源不配拿可见终端」（它会悄悄扩大权限）
    {
      module: "terminal",
      tools: createTerminalTools(broker, command.sessionId, {
        cwd: command.cwd,
        // 授权目录与开轮目录清单同源：prompt 里说「你可以去这些目录」，这里就认这些
        authorizedDirs: [command.cwd, ...(command.directories?.attached ?? [])],
      }),
    },
    { module: "base", tools: createChannelTools(broker, command.sessionId, flags.role, flags.mainAgent) },
    {
      module: "base",
      tools: flags.memoryTools
        ? createMemoryTools(broker, command.sessionId, {
            scope: { workspaceId: command.workspaceId, cwd: command.cwd },
            turn: deps.memoryTurn,
          })
        : [],
    },
    { module: "base", tools: flags.automationTools ? createAutomationTools(broker, command.sessionId) : [] },
  ];
}

/** 这一轮按能力集挑过的工具，与被收掉的那些（工具名 → 它属于什么，缺模块回执用） */
export interface TurnToolSet {
  tools: ToolDefinition[];
  /** 被能力集收掉的工具：名字 → 给模型看的「它属于什么」（模块说明或 MCP 服务名）。全带时为空 */
  withheld: Map<string, string>;
}

/** MCP 工具属于哪台服务（名字是 mcp__<服务>__<工具>）；认不出 = null */
function mcpServerOf(tool: ToolDefinition): string | null {
  return parseQualifiedToolName(tool.name)?.server ?? null;
}

/**
 * 按能力集（command.capabilities）挑这一轮的工具。缺席 = 全带，结果与能力集之前逐字节相同；
 * `["none"]` = 纯聊天，一个不带。被收掉的记进 withheld：模型凭印象调到它们时给一句明白的回执。
 */
export function selectTurnTools(deps: TurnToolDeps): TurnToolSet {
  const capabilities = deps.command.capabilities;
  const groups = turnToolGroups(deps);
  if (capabilities === undefined) return { tools: groups.flatMap((group) => group.tools), withheld: new Map() };
  const chatOnly = isChatOnly(capabilities);
  const servers = new Set(namedInstalled(capabilities, "mcp:"));
  const tools: ToolDefinition[] = [];
  const withheld = new Map<string, string>();
  for (const group of groups) {
    for (const tool of group.tools) {
      const kept =
        !chatOnly &&
        (group.module === "base" ||
          (group.module === "mcp" ? servers.has(mcpServerOf(tool) ?? "") : hasModule(capabilities, group.module)));
      if (kept) tools.push(tool);
      else withheld.set(tool.name, withheldWhat(group.module, tool, chatOnly));
    }
  }
  return { tools, withheld };
}

function withheldWhat(module: ToolGroup["module"], tool: ToolDefinition, chatOnly: boolean): string {
  if (chatOnly) return "any tools (it is chat only)";
  if (module === "mcp") return `the MCP server "${mcpServerOf(tool) ?? tool.name}"`;
  if (module === "base") return "this tool";
  return `the ${module} module: ${MODULE_SUMMARY[module]}`;
}

/** 这一轮的非内建工具，**顺序即发给模型的顺序**（按能力集挑过）。 */
export function createTurnTools(deps: TurnToolDeps): ToolDefinition[] {
  return selectTurnTools(deps).tools;
}

/**
 * 缺模块回执：模型调了被这件活的能力集收掉的工具（durable 回的是 tool_unavailable）。
 * 只说事实与出路，不让它干等：要用就用 report_to_parent 跟派活的人说（纯聊天没有工具，就在回答里说）。
 */
export function withheldToolReceipt(name: string, what: string, chatOnly: boolean): string {
  return chatOnly
    ? `Tool ${name} is not available: this piece of work was handed out as chat only, without ${what}. Answer in your reply; if the work needs tools, say so in your answer so the agent that delegated you can hand it out again.`
    : `Tool ${name} is not available: this piece of work was handed out without ${what}. If you really need it, tell the agent that delegated you with report_to_parent (kind "question") and say what for; otherwise carry on with the tools you have.`;
}
