/**
 * 应用设置的落盘 —— 单个可移植 JSON，原子写（AGENTS.md「本地优先」）。
 * 形状与容错都在 `src/shared/settings.ts`，这里只管读写。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../atomic-write.ts";
import { DEFAULT_SETTINGS, parseSettings, type AppSettings, type SettingsPatch } from "../../shared/settings.ts";

export class SettingsStore {
  private readonly filePath: string;
  private cache: AppSettings | null = null;

  constructor(dir: string) {
    this.filePath = join(dir, "settings.json");
  }

  async read(): Promise<AppSettings> {
    if (this.cache !== null) return this.cache;
    try {
      this.cache = parseSettings(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch {
      // 文件不存在或不是 JSON 都退回默认——设置随时可以再选，不值得为此让应用起不来
      this.cache = DEFAULT_SETTINGS;
    }
    return this.cache;
  }

  /**
   * 部分更新：只覆盖传进来的字段，其余保持。返回落盘后的完整设置。
   *
   * 对象值（drawer）做**一层深合并**：渲染层各处只发自己改的那个键
   * （{drawer:{docked}} / {drawer:{open}}），谁后到谁合并，不存在整块覆盖——
   * 渲染层闭包里的旧 settings 拼完整对象会有先后覆盖的竞态（真机冒烟实测：
   * open 先落盘、随后 docked 被旧闭包整块冲掉）。
   */
  async write(patch: SettingsPatch): Promise<AppSettings> {
    const current = await this.read();
    const drawer =
      patch.drawer === undefined
        ? current.drawer
        : parseSettings({ theme: current.theme, drawer: { ...current.drawer, ...patch.drawer } })
            .drawer;
    // lastUsed 同款按键合并：切档只写 mode，不该把已记的 providerId/modelId 抹掉
    const lastUsed =
      patch.lastUsed === undefined
        ? current.lastUsed
        : { ...current.lastUsed, ...patch.lastUsed };
    // 实验功能同款按键合并：设置页每张卡只发自己那个 id，不该把别的卡刚写的开关抹掉
    const experimentalFeatures =
      patch.experimentalFeatures === undefined
        ? current.experimentalFeatures
        : { ...current.experimentalFeatures, ...patch.experimentalFeatures };
    const next = parseSettings({ ...current, ...patch, drawer, lastUsed, experimentalFeatures });
    await writeJsonAtomic(this.filePath, next);
    this.cache = next;
    return next;
  }
}
