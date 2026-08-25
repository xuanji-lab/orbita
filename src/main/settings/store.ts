/**
 * 应用设置的落盘 —— 单个可移植 JSON，原子写（AGENTS.md「本地优先」）。
 * 形状与容错都在 `src/shared/settings.ts`，这里只管读写。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_SETTINGS, parseSettings, type AppSettings } from "../../shared/settings.ts";

export class SettingsStore {
  private readonly dir: string;
  private readonly filePath: string;
  private cache: AppSettings | null = null;

  constructor(dir: string) {
    this.dir = dir;
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

  /** 部分更新：只覆盖传进来的字段，其余保持。返回落盘后的完整设置。 */
  async write(patch: Partial<AppSettings>): Promise<AppSettings> {
    const next = parseSettings({ ...(await this.read()), ...patch });
    await mkdir(this.dir, { recursive: true });
    const tempPath = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
    this.cache = next;
    return next;
  }
}
