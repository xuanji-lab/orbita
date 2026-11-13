/**
 * 配置导入（技能、MCP）与自定义数据目录的 IPC —— 四层契约的第 2 层（契约在 shared/import.ts）。
 *
 * 每次调用**现读** store：刚导入的技能 / MCP 下一次扫描就算「已在 orbita」，刚加 / 删的自定义
 * 目录下一次扫描就生效。聊天记录不在这里（外部会话只读：external-ipc.ts、external-session.ts）。
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import {
  parseImportCustomRootInput,
  parseImportRunInput,
  parseImportScanInput,
  type ImportCustomRoot,
  type ImportDetectResult,
  type ImportRunReport,
  type ImportScanReport,
} from "../../shared/import.ts";
import type { SkillStore } from "../skill/store.ts";
import type { McpStore } from "../mcp/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { DATA_ROOT_SPECS, findDataRoots, type LocateContext } from "./import-locate.ts";
import { CustomRootsStore, dirsOf, mergeCustomRoots, type CustomRootSource } from "./import-custom-roots.ts";
import { probeConfig, runConfigImport, scanConfig, type ConfigImportDeps } from "./config-import.ts";

export function registerImportIpc(
  workspaces: WorkspaceStore,
  /** 自定义数据目录清单（import-custom-roots.ts），在 userData 下 */
  customRoots: CustomRootsStore,
  skills: SkillStore,
  mcp: McpStore,
  /** mcp.json 改完之后让运行时重读（与 MCP 面板加 server 同一个回调） */
  reloadMcp: () => Promise<void>,
): void {
  async function deps(): Promise<ConfigImportDeps> {
    const custom = await customRoots.read();
    const home = homedir();
    return {
      promaRoots: await rootsOf("proma", custom),
      claudeCode: (await rootsOf("claude-code", custom)).map((root) => ({
        skillsDir: join(root, "skills"),
        // 用户配置：默认目录的在家目录的 ~/.claude.json，另指的目录在目录自己里面
        claudeJson: root === join(home, ".claude") ? join(home, ".claude.json") : join(root, ".claude.json"),
      })),
      kimiCode: (await rootsOf("kimi-code", custom)).map((root) => ({ mcpFile: join(root, "mcp.json") })),
      // OpenCode 按 XDG 放：数据在 <XDG data>/opencode，配置在 <XDG config>/<同名目录>/opencode.json
      opencode: (await rootsOf("opencode", custom)).map((root) => ({
        configFile: join(process.env["XDG_CONFIG_HOME"] || join(home, ".config"), basename(root), "opencode.json"),
      })),
      agentSkillsDir: join(home, ".agents", "skills"),
      existingSkills: (await skills.list()).map((skill) => skill.slug),
      // mcp.json 坏了不挡扫描：技能照导，MCP 写入时会各自报错
      existingMcp: await mcp.read().then(Object.keys, () => []),
    };
  }

  // 第 1 步的来源与会读的路径：只 stat（页面一打开就跑，用户还什么都没勾）
  ipcMain.handle(ipcChannels.importDetect, async (): Promise<ImportDetectResult> => {
    const home = homedir();
    const environment = await deps();
    return {
      home,
      sources: await probeConfig(environment, {
        proma: join(home, ".proma"),
        claudeCode: { skillsDir: join(home, ".claude", "skills"), claudeJson: join(home, ".claude.json") },
        kimiCode: join(home, ".kimi-code", "mcp.json"),
        opencode: join(process.env["XDG_CONFIG_HOME"] || join(home, ".config"), "opencode", "opencode.json"),
      }),
    };
  });
  ipcMain.handle(ipcChannels.importScan, async (_event, raw: unknown): Promise<ImportScanReport> => {
    const input = parseImportScanInput(raw);
    // 一个来源都没勾 = 一个字节都不读
    if (input.sources.length === 0) return { skills: [], mcp: [] };
    return (await scanConfig(await deps(), input.sources)).report;
  });
  ipcMain.handle(ipcChannels.importRun, async (_event, raw: unknown): Promise<ImportRunReport> => {
    const input = parseImportRunInput(raw);
    return runConfigImport(
      await deps(),
      {
        skillTarget: skills,
        mcpTarget: { add: (name, server) => mcp.add(name, server), reload: reloadMcp },
        workspaceIds: new Set((await workspaces.list()).map((workspace) => workspace.id)),
      },
      input,
    );
  });
  // 自定义数据目录：三通道都是「校验 / 落盘在主进程，renderer 只传字符串」——
  // renderer 在 sandbox 里没有文件系统访问权，路径真伪不该由它判断
  ipcMain.handle(ipcChannels.importCustomRootsAdd, async (_event, raw: unknown): Promise<ImportCustomRoot[]> => {
    const input = parseImportCustomRootInput(raw);
    return customRoots.add(input.source, input.dir);
  });
  ipcMain.handle(ipcChannels.importCustomRootsRemove, async (_event, raw: unknown): Promise<ImportCustomRoot[]> => {
    const input = parseImportCustomRootInput(raw);
    return customRoots.remove(input.source, input.dir);
  });
  // 目录选择框：主进程开；选中返回路径，取消返回 null
  ipcMain.handle(ipcChannels.importPickDirectory, async (event): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const result = await (window
      ? dialog.showOpenDialog(window, { properties: ["openDirectory"] })
      : dialog.showOpenDialog({ properties: ["openDirectory"] }));
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}

/** findDataRoots 的环境：真实平台、家目录、环境变量。 */
function locateContext(): LocateContext {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/** 一个来源的数据目录：自动发现 + 自定义目录（合并去重，自定义的要过 validate）。 */
async function rootsOf(source: CustomRootSource, custom: readonly ImportCustomRoot[]): Promise<string[]> {
  const spec = DATA_ROOT_SPECS[source];
  return mergeCustomRoots(await findDataRoots(spec, locateContext()), dirsOf(custom, source), spec);
}
