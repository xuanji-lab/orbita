/**
 * 导入的 IPC —— 四层契约的第 2 层。装配 ImporterDeps 并把探测 / 扫描 / 执行三个通道挂上。
 *
 * 每次调用**现读** store / providers / settings（不缓存装配结果）：导入完成的
 * 那一刻 UI 刷新，下一次扫描必须看到刚落盘的 meta（幂等判重的底），拿启动时的
 * 快照会把已导入的再导一遍。
 */
import { ipcMain } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  parseImportRunInput,
  parseImportScanInput,
  type ImportDetectResult,
  type ImportGreetingCheckResult,
  type ImportModelRef,
  type ImportRunReport,
  type ImportScanReport,
} from "../../shared/import.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SessionStore } from "./store.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { SkillStore } from "../skill/store.ts";
import type { McpStore } from "../mcp/store.ts";
import { findGreetingOnly } from "./greeting-only.ts";
import { WorkspaceStore } from "../workspace/store.ts";
import {
  emptyScanReport,
  probeAgentSkills,
  probeClaudeCode,
  probeKimiCode,
  probeOpencode,
  probeProma,
  probeReasonix,
  runImport,
  scanGreetingCandidates,
  scanImport,
  type ClaudeCodePaths,
  type ImporterDeps,
  type KimiCodePaths,
  type OpencodePaths,
  reasonixDataRoot,
  type ReasonixPaths,
} from "./importer.ts";

export function registerImportIpc(
  sessions: SessionStore,
  workspaces: WorkspaceStore,
  providers: ProviderStore,
  settings: SettingsStore,
  /** orbita 的 pi 本子目录——与 registerAgentIpc 传的是同一个值，路径策略在 main/index.ts */
  piSessionDir: string,
  /** 导入清单 imports.jsonl（import-ledger.ts），与会话数据同在 userData 下 */
  ledgerFile: string,
  skills: SkillStore,
  mcp: McpStore,
  /** mcp.json 改完之后让运行时重读（与 MCP 面板加 server 同一个回调） */
  reloadMcp: () => Promise<void>,
  /** 用指定模型判一批消息哪些是随手一句（agent 进程的 classifyGreetings），回判中的下标 */
  classifyGreetings: (model: ImportModelRef, messages: string[]) => Promise<number[]>,
): void {
  async function deps(): Promise<ImporterDeps> {
    const [providerList, appSettings] = await Promise.all([providers.list(), settings.read()]);
    const registered = providerList.flatMap((provider) =>
      provider.models.declared.map((model) => ({ providerId: provider.id, modelId: model.id })),
    );
    // 兜底模型：上次用的（还在注册表里就用它），否则第一家-provider 的第一个模型。
    // 一个模型都没有 = 没法兜底，直接报错让用户先去配 provider（映射 miss 的会话
    // 会拿到一个发不出请求的组合，不如在入口拦下）
    const last = appSettings.lastUsed;
    const lastHit =
      last?.providerId !== undefined && last.modelId !== undefined
        ? registered.find((m) => m.providerId === last.providerId && m.modelId === last.modelId)
        : undefined;
    const fallback = lastHit ?? registered[0];
    if (fallback === undefined) {
      throw new Error("No registered model — configure a provider before importing");
    }
    // 「只随手发了一句」检查用子会话模型（它就是给这类后台小活的）；没设或它的 provider 已删，
    // 用上面的兜底模型——页面上写明用的是哪一个
    const sub = appSettings.subSessionModel;
    const greetingModel =
      sub !== undefined && registered.some((m) => m.providerId === sub.providerId && m.modelId === sub.modelId)
        ? { ...sub, from: "sub-session" as const }
        : { ...fallback, from: "default" as const };
    return {
      promaRoot: joinPromaRoot(),
      // Proma 数据根迁移史：.proma → .proma-dev，索引里仍有条目指向旧根（本机实测
      // 66 条），文件仍在且是同一格式——旧根也是合法源，同样只读
      extraSourceRoots: legacyPromaRoots(),
      claudeCode: claudeCodePaths(),
      kimiCode: kimiCodePaths(),
      opencode: opencodePaths(),
      reasonix: reasonixPaths(),
      agentSkillsDir: agentSkillsDir(),
      existingSkills: (await skills.list()).map((skill) => skill.slug),
      // mcp.json 坏了不挡扫描：会话与 skills 照导，MCP 写入时会各自报错
      existingMcp: await mcp.read().then(Object.keys, () => []),
      piSessionDir,
      defaultCwd: workspaces.defaultPath(),
      workspaces: await workspaces.list(),
      existingMetas: await sessions.list(),
      ledgerFile,
      registeredModels: registered,
      fallbackModel: fallback,
      greetingModel,
      newId: randomUUID,
    };
  }

  // 探测只 stat，不装配 deps：没配 provider 的新用户也该看得到本机有哪些来源
  ipcMain.handle(ipcChannels.importDetect, async (): Promise<ImportDetectResult> => ({
    home: homedir(),
    sources: [
      await probeProma(joinPromaRoot(), legacyPromaRoots()),
      await probeClaudeCode(claudeCodePaths()),
      await probeKimiCode(kimiCodePaths()),
      await probeOpencode(opencodePaths()),
      await probeReasonix(reasonixPaths()),
      await probeAgentSkills(agentSkillsDir()),
    ],
  }));
  ipcMain.handle(ipcChannels.importScan, async (_event, raw: unknown): Promise<ImportScanReport> => {
    const input = parseImportScanInput(raw);
    // 一个来源都没勾 = 一个字节都不读；勾了的才读（scanImport 按 sources 分来源读）
    if (input.sources.length === 0) return emptyScanReport();
    return scanImport(await deps(), [], input.sources);
  });
  ipcMain.handle(
    ipcChannels.importCheckGreetings,
    async (_event, raw: unknown): Promise<ImportGreetingCheckResult> => {
      const input = parseImportScanInput(raw);
      const environment = await deps();
      const model = environment.greetingModel;
      if (model === undefined || model === null) throw new Error("No model to run the check with");
      const ref = { providerId: model.providerId, modelId: model.modelId };
      if (input.sources.length === 0) return { greetingOnly: [], checked: 0, asked: 0, model: ref };
      const candidates = await scanGreetingCandidates(environment, input.sources);
      const found = await findGreetingOnly(candidates, (messages) => classifyGreetings(ref, messages));
      return { greetingOnly: found.greetingOnly, checked: candidates.size, asked: found.asked, model: ref };
    },
  );
  ipcMain.handle(ipcChannels.importRun, async (_event, raw: unknown): Promise<ImportRunReport> => {
    const input = parseImportRunInput(raw);
    if (input.sources.length === 0) {
      return { imported: 0, updated: 0, skipped: 0, failed: [], createdWorkspaces: [], mergedWorkspaceIds: [], skillsImported: 0, skillsFailed: [], mcpImported: 0, mcpFailed: [] };
    }
    const environment = await deps();
    return runImport(
      {
        ...environment,
        createWorkspace: async (workspace) => {
          await workspaces.addImported(workspace);
        },
        persistSession: async (meta, records) => {
          await sessions.commitImported(meta, records);
        },
        refreshSession: async (id, records, patch) => {
          await sessions.commitImportUpdate(id, records, patch);
        },
        skillTarget: skills,
        mcpTarget: { add: (name, server) => mcp.add(name, server), reload: reloadMcp },
      },
      {
        sources: input.sources,
        sessions: new Set(input.sessions),
        destinations: input.destinations,
        skills: { skills: new Set(input.skills), mode: input.skillMode, scopes: input.skillScopes },
        mcp: new Set(input.mcp),
      },
    );
  });
}

/** Proma 数据根固定在 ~/.proma-dev（应用数据目录约定，不做配置面）。 */
function joinPromaRoot(): string {
  return `${homedir()}/.proma-dev`;
}

/** Proma 的旧数据根：索引里仍有条目指向它（见 deps 里的注释）。探测与扫描同一份清单 */
function legacyPromaRoots(): string[] {
  return [`${homedir()}/.proma`];
}

/**
 * Claude Code 的会话在 ~/.claude/projects（命令行与桌面应用共用）；桌面应用的会话清单在它自己的
 * 应用数据目录（macOS 路径，别的系统上不存在，扫描照常）。探测与扫描同一份。
 */
function claudeCodePaths(): ClaudeCodePaths {
  const home = homedir();
  return {
    projectsDir: join(home, ".claude", "projects"),
    desktopSessionsDir: join(home, "Library", "Application Support", "Claude", "claude-code-sessions"),
    home,
    skillsDir: join(home, ".claude", "skills"),
    claudeJson: join(home, ".claude.json"),
  };
}

/** Kimi Code 的数据都在 ~/.kimi-code 下（命令行，各平台同一位置）。探测与扫描同一份。 */
function kimiCodePaths(): KimiCodePaths {
  const home = homedir();
  const root = join(home, ".kimi-code");
  return {
    sessionsDir: join(root, "sessions"),
    workspacesFile: join(root, "workspaces.json"),
    mcpFile: join(root, "mcp.json"),
    home,
  };
}

/**
 * opencode 按 XDG 目录放数据：会话库在 ~/.local/share/opencode，配置在 ~/.config/opencode
 * （macOS 上也是这两处，不在 Library 下）。探测与扫描同一份。
 */
function opencodePaths(): OpencodePaths {
  const home = homedir();
  return {
    dbFile: join(home, ".local", "share", "opencode", "opencode.db"),
    configFile: join(home, ".config", "opencode", "opencode.json"),
    home,
  };
}

/**
 * Reasonix 桌面版来源要读的位置（数据根按平台各归各位，见 reasonixDataRoot）。探测与扫描同一份。
 */
function reasonixPaths(): ReasonixPaths {
  const home = homedir();
  return { projectsRoot: join(reasonixDataRoot(process.platform, home, process.env), "projects"), home };
}

/** 多家 agent 共用的 skills 目录（agent-skills 来源）。探测与扫描同一个。 */
function agentSkillsDir(): string {
  return join(homedir(), ".agents", "skills");
}
