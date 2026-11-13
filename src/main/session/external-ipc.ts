/**
 * 外部来源的 IPC —— 四层契约的第 2 层（契约在 shared/external-sources.ts）。
 * 设置 › 外部来源一打开就调：每个来源的数据目录、会话数（只 stat）、开关与读不全的原因。
 * 开关本身走 settingsSet（AppSettings.externalSources），自定义目录走 import:custom-roots:*。
 */
import { ipcMain } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isExternalSourceEnabled, type ExternalSourcesResult } from "../../shared/external-sources.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { ExternalSessionReader } from "./external-session.ts";
import { EXTERNAL_ADAPTERS } from "./external-adapters.ts";
import { locateExternalSources } from "./external-locate.ts";
import type { CustomRootsStore } from "./import-custom-roots.ts";
import { hasDirectory } from "./import-locate.ts";
import { stat } from "node:fs/promises";

async function hasSessionData(root: string, entry: { path: readonly string[]; type: "file" | "dir" }): Promise<boolean> {
  if (entry.type === "dir") return hasDirectory(join(root, ...entry.path));
  try {
    return (await stat(join(root, ...entry.path))).isFile();
  } catch {
    return false;
  }
}

export function registerExternalSourcesIpc(reader: ExternalSessionReader, customRoots: CustomRootsStore, settings: SettingsStore): void {
  ipcMain.handle(ipcChannels.externalSourcesList, async (): Promise<ExternalSourcesResult> => {
    const custom = await customRoots.read();
    const context = { platform: process.platform, home: homedir(), env: process.env };
    const [located, counts, current] = await Promise.all([
      locateExternalSources(context, custom),
      reader.inventory(),
      settings.read(),
    ]);
    const customDirs = new Set(custom.map((root) => `${root.source}\n${join(root.dir)}`));
    const sources = await Promise.all(
      located.map(async (item) => {
        const count = counts.find((entry) => entry.source === item.source);
        const roots = await Promise.all(
          item.roots.map(async (dir) => ({
            dir,
            custom: customDirs.has(`${item.source}\n${join(dir)}`),
            hasData: await hasSessionData(dir, EXTERNAL_ADAPTERS[item.source].entry),
          })),
        );
        return {
          id: item.source,
          roots,
          expected: item.expected,
          expectedExists: item.expectedExists,
          sessions: count?.total ?? 0,
          enabled: isExternalSourceEnabled(current.externalSources, item.source),
          // 「这里没有会话数据」已经标在那一行数据目录上（hasData），不再重复列一遍英文原因
          problems: (count?.problems ?? []).filter((problem) => !roots.some((root) => !root.hasData && problem.includes(root.dir))),
        };
      }),
    );
    return { home: homedir(), sources, customRoots: custom };
  });
}
