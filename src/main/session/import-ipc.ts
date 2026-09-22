/**
 * 导入的 IPC —— 四层契约的第 2 层。装配 ImporterDeps 并把两个通道挂上。
 *
 * 每次调用**现读** store / providers / settings（不缓存装配结果）：导入完成的
 * 那一刻 UI 刷新，下一次扫描必须看到刚落盘的 meta（幂等判重的底），拿启动时的
 * 快照会把已导入的再导一遍。
 */
import { ipcMain } from "electron";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { ImportRunReport, ImportScanReport } from "../../shared/import.ts";
import type { ProviderStore } from "../provider/store.ts";
import type { SessionStore } from "./store.ts";
import type { SettingsStore } from "../settings/store.ts";
import { WorkspaceStore } from "../workspace/store.ts";
import { runImport, scanImport, type ImporterDeps } from "./importer.ts";

export function registerImportIpc(
  sessions: SessionStore,
  workspaces: WorkspaceStore,
  providers: ProviderStore,
  settings: SettingsStore,
  /** orbita 的 pi 本子目录——与 registerAgentIpc 传的是同一个值，路径策略在 main/index.ts */
  piSessionDir: string,
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
    return {
      promaRoot: joinPromaRoot(),
      // Proma 数据根迁移史：.proma → .proma-dev，索引里仍有条目指向旧根（本机实测
      // 66 条），文件仍在且是同一格式——旧根也是合法源，同样只读
      extraSourceRoots: [`${homedir()}/.proma`],
      piSessionDir,
      defaultCwd: workspaces.defaultPath(),
      workspaces: await workspaces.list(),
      existingMetas: await sessions.list(),
      registeredModels: registered,
      fallbackModel: fallback,
      newId: randomUUID,
    };
  }

  ipcMain.handle(ipcChannels.importScan, (): Promise<ImportScanReport> =>
    deps().then((environment) => scanImport(environment)),
  );
  ipcMain.handle(ipcChannels.importRun, (): Promise<ImportRunReport> =>
    deps().then(async (environment) =>
      runImport({
        ...environment,
        createWorkspace: async (workspace) => {
          await workspaces.addImported(workspace);
        },
        persistSession: async (meta, records) => {
          await sessions.commitImported(meta, records);
        },
      }),
    ),
  );
}

/** Proma 数据根固定在 ~/.proma-dev（应用数据目录约定，不做配置面）。 */
function joinPromaRoot(): string {
  return `${homedir()}/.proma-dev`;
}
