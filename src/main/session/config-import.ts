/**
 * 从别的工具导入**配置**：技能与 MCP servers —— 纯模块（不 import electron），`node --test` 直接测。
 *
 * 配置复制一次就对（2026-10 用户裁决：「skills 和 MCP 是配置，复制一次就是对的做法……迁移
 * 保留」）；聊天记录不在这里——它们留在源头，由 read_task 只读读取（external-session.ts）。
 * 这里的规则与此前导入引擎里技能 / MCP 那一半逐字相同，只是不再连着会话一起扫。
 *
 * 源目录绝对只读：技能目录、MCP 配置都只 readFile / readdir；落盘只往 Orbita 自己的技能存储与
 * mcp.json 写（注入的 target）。执行时按同样的来源重扫，不接收 renderer 回传的扫描结果。
 */
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ImportRunInput, ImportRunReport, ImportScanReport, ImportSourceId } from "../../shared/import.ts";
import type { McpServer } from "../../shared/mcp.ts";
import {
  claudeCodeSkillDirs,
  importSkills,
  promaBuiltInSkills,
  promaSkillDirs,
  promaWorkspaceFolders,
  scanSkillDirs,
  type SkillImportTarget,
  type SkillSourceDir,
} from "../skill/import.ts";
import {
  importMcpServers,
  mergeMcpEntries,
  readClaudeCodeMcp,
  readKimiCodeMcp,
  readOpencodeMcp,
  readPromaMcp,
  type McpSourceEntry,
} from "../mcp/import.ts";

/** 各来源的配置在哪（每个数据目录一份；全部只读）。 */
export interface ConfigImportDeps {
  /** Proma 的数据目录：工作区的 skills、默认技能、各工作区的 mcp.json */
  promaRoots: readonly string[];
  /** Claude Code：skills 目录（~/.claude/skills）与用户配置（~/.claude.json 的 mcpServers） */
  claudeCode: readonly { skillsDir: string; claudeJson: string }[];
  /** Kimi Code：mcp.json */
  kimiCode: readonly { mcpFile: string }[];
  /** OpenCode：用户配置里的 mcp */
  opencode: readonly { configFile: string }[];
  /** 多家共用的 skills 目录（~/.agents/skills） */
  agentSkillsDir: string;
  /** Orbita 已有的 skill slug（含只剩断链的）：重名判断的底 */
  existingSkills: readonly string[];
  /** Orbita mcp.json 里已有的 server 名：重名判断的底 */
  existingMcp: readonly string[];
}

export interface ConfigImportTargets {
  skillTarget: SkillImportTarget;
  mcpTarget: { add(name: string, server: McpServer): Promise<void>; reload(): Promise<void> };
  /** 现有工作区 id：作用域指到已删工作区的那组记失败，不替用户换成全局（importSkills 的规则） */
  workspaceIds: ReadonlySet<string>;
}

/** 有会话索引的 Proma 数据目录（只 stat）：没有索引的不算一个 Proma 数据目录。 */
async function promaRootsWithIndex(roots: readonly string[]): Promise<string[]> {
  const out: string[] = [];
  for (const root of roots) {
    try {
      if ((await stat(join(root, "agent-sessions.json"))).isFile()) out.push(root);
    } catch {
      // 没有索引：跳过
    }
  }
  return out;
}

/**
 * 扫描：技能（组的顺序就是重名先到先得的顺序——Proma 各数据目录的各工作区 → 共用目录 →
 * Claude Code）与 MCP（同名取先到的：Proma → Claude Code → Kimi Code → OpenCode）。
 * 没勾的来源一个字节都不读。mcpServers 是配置本体（带密钥，不出主进程）。
 */
export async function scanConfig(
  deps: ConfigImportDeps,
  sources: readonly ImportSourceId[],
): Promise<{ report: ImportScanReport; mcpServers: Map<string, McpServer> }> {
  const promaRoots = sources.includes("proma") ? await promaRootsWithIndex(deps.promaRoots) : [];
  const promaFolders: { root: string; folders: { slug: string; name: string }[] }[] = [];
  for (const root of promaRoots) {
    const folders = await promaWorkspaceFolders(root);
    promaFolders.push({
      root,
      // 几个数据目录里多半有同名工作区（整份复制过来的），不止一个时组名后面带上目录名好分辨
      folders: promaRoots.length > 1 ? folders.map((folder) => ({ ...folder, name: `${folder.name} · ${basename(root)}` })) : folders,
    });
  }
  const skillDirs: SkillSourceDir[] = promaFolders.flatMap(({ root, folders }) => promaSkillDirs(root, folders));
  const promaBuiltIns = new Set<string>();
  for (const root of promaRoots) {
    for (const slug of await promaBuiltInSkills(root)) promaBuiltIns.add(slug);
  }
  if (sources.includes("agent-skills")) skillDirs.push({ source: "agent-skills", name: null, dir: deps.agentSkillsDir });
  if (sources.includes("claude-code")) {
    for (const paths of deps.claudeCode) skillDirs.push(...(await claudeCodeSkillDirs(paths.skillsDir)));
  }
  const skills = skillDirs.length === 0 ? [] : await scanSkillDirs(skillDirs, new Set(deps.existingSkills), promaBuiltIns);

  const mcpEntries: McpSourceEntry[] = [];
  for (const { root, folders } of promaFolders) mcpEntries.push(...(await readPromaMcp(root, folders)));
  if (sources.includes("claude-code")) {
    for (const paths of deps.claudeCode) mcpEntries.push(...(await readClaudeCodeMcp(paths.claudeJson)));
  }
  if (sources.includes("kimi-code")) {
    for (const paths of deps.kimiCode) mcpEntries.push(...(await readKimiCodeMcp(paths.mcpFile)));
  }
  if (sources.includes("opencode")) {
    for (const paths of deps.opencode) mcpEntries.push(...(await readOpencodeMcp(paths.configFile)));
  }
  const mcp = mergeMcpEntries(mcpEntries, new Set(deps.existingMcp));
  return { report: { skills, mcp: mcp.items }, mcpServers: mcp.servers };
}

/** 执行：按同样的来源重扫，再按勾选落盘（技能进中心存储、MCP 进 mcp.json 且停用）。 */
export async function runConfigImport(
  deps: ConfigImportDeps,
  targets: ConfigImportTargets,
  input: ImportRunInput,
): Promise<ImportRunReport> {
  const { report, mcpServers } = await scanConfig(deps, input.sources);
  const skillResult = await importSkills(
    report.skills,
    { skills: new Set(input.skills), mode: input.skillMode, scopes: input.skillScopes },
    targets.skillTarget,
    targets.workspaceIds,
  );
  const mcpResult = await importMcpServers(mcpServers, new Set(input.mcp), targets.mcpTarget);
  return {
    skillsImported: skillResult.imported,
    skillsFailed: skillResult.failed,
    mcpImported: mcpResult.imported,
    mcpFailed: mcpResult.failed,
  };
}
