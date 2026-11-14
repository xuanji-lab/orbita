/**
 * 新内核（pi-durable）的系统提示：与旧内核**逐字节相同**的那一份。
 *
 * 旧内核发出的系统提示 = pi 的基础提示（pi-coding-agent 按工具清单、规则、项目说明 AGENTS.md、技能索引、cwd
 * 拼的 buildSystemPrompt）→ adaptSystemPrompt（prompt-narration.ts）→ 拼上 Orbita 自己的各段
 * （system-prompt.ts 的 orbitaSystemSegments）→ joinSystemPrompt。后两步本来就是纯函数，两个内核共用；
 * 这里补第一步：用 pi **同一个函数**（buildSystemPrompt，patch 导出）、**同一个资源加载器**
 * （DefaultResourceLoader，同样的 noSkills + additionalSkillPaths）、**同一份设置**（~/.pi/agent 的
 * SettingsManager）重建基础提示，输入的组法照抄 agent-session 的 _rebuildSystemPrompt。
 *
 * 唯一有意的差别：`noExtensions: true`。旧内核里 pi 会加载用户 pi TUI 的全局扩展（~/.pi/agent/extensions/），
 * 它们的工具与提示词片段会混进 Orbita 的会话；那是另一个应用的配置，新内核不接（也接不了——那些扩展写的是
 * pi-coding-agent 的 ExtensionAPI）。报告里列为有意差异，待用户定。
 */
import {
  buildSystemPrompt,
  DefaultResourceLoader,
  getAgentDir,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { BuiltinToolOptions } from "./durable-tools.ts";

/** 一轮重建基础提示要的资源快照（规则文件与技能索引；上下文面板的清单也读它） */
export interface PiResources {
  basePrompt: (selectedTools: readonly string[], definitions: readonly ToolDefinition[]) => string;
  agentsFiles: { path: string; content: string }[];
  skills: { name: string; description: string }[];
  agentDir: string;
  /** 内建工具的装配选项：与旧内核里 pi 从同一份设置读出的三项相同 */
  builtinOptions: BuiltinToolOptions;
}

/**
 * 每轮开一次（旧内核也是每轮 createAgentSessionServices → resourceLoader.reload()）：用户中途改了 AGENTS.md、
 * 链了新技能，下一轮就生效。`resolveShellPath` 是旧内核同款的进程级缓存探测（shell-path.ts）。
 */
export async function loadPiResources(input: {
  cwd: string;
  skillsDirs: readonly string[];
  resolveShellPath: () => string | undefined;
}): Promise<PiResources> {
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(input.cwd, agentDir);
  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    agentDir,
    settingsManager,
    noSkills: true,
    additionalSkillPaths: [...input.skillsDirs],
    noExtensions: true,
  });
  await loader.reload();
  const skills = loader.getSkills().skills;
  const contextFiles = loader.getAgentsFiles().agentsFiles;
  const customPrompt = loader.getSystemPrompt();
  const appendParts = loader.getAppendSystemPrompt();
  const appendSystemPrompt = appendParts.length > 0 ? appendParts.join("\n\n") : "";
  return {
    basePrompt: (selectedTools, definitions) => {
      // 与 _rebuildSystemPrompt 同组法：片段取全部注册工具的，规则按选中工具走
      const toolSnippets: Record<string, string> = {};
      const toolGuidelines: Record<string, string[]> = {};
      for (const definition of definitions) {
        // 归一化照抄 agent-session 的 _normalizePromptSnippet / _normalizePromptGuidelines
        const snippet = (definition.promptSnippet ?? "").replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
        if (snippet !== "") toolSnippets[definition.name] = snippet;
        const guidelines = [...new Set((definition.promptGuidelines ?? []).map((line) => line.trim()).filter((line) => line !== ""))];
        if (guidelines.length > 0) toolGuidelines[definition.name] = guidelines;
      }
      return buildSystemPrompt({
        cwd: input.cwd,
        skills,
        contextFiles,
        customPrompt,
        appendSystemPrompt,
        selectedTools: [...selectedTools],
        hiddenTools: [],
        toolSnippets,
        toolGuidelines,
      });
    },
    agentsFiles: contextFiles.map((file) => ({ path: file.path, content: file.content })),
    skills: skills.map((skill) => ({ name: skill.name, description: skill.description })),
    agentDir,
    builtinOptions: {
      autoResizeImages: settingsManager.getImageAutoResize(),
      commandPrefix: settingsManager.getShellCommandPrefix(),
      // 与旧内核同：用户在 pi 设置里显式指定了 shell 就用它，没指定才补探测到的
      shellPath: settingsManager.getShellPath() ?? input.resolveShellPath(),
    },
  };
}

/**
 * 工具清单的顺序：已在的保持原位、新出现的接在后面（pi 的 _applyToolLoadout 与 durable 的 planTools 是同一条规则）。
 * `previous` 是模型此前看到的清单（durable 从会话的 pi.system 条目回放；刚迁来的会话用旧本子里记录的那份）。
 */
export function loadoutOrder(previous: readonly string[], desired: readonly string[]): string[] {
  const wanted = new Set(desired);
  const kept = previous.filter((name) => wanted.has(name));
  const keptSet = new Set(kept);
  return [...kept, ...desired.filter((name) => !keptSet.has(name))];
}
