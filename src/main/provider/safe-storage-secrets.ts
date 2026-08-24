/**
 * SecretsPort 的 Electron 实现：safeStorage 加密 + 旁挂密文文件。
 * macOS 走钥匙串、Windows 走 DPAPI；Linux 无 keyring 时 safeStorage 会降级为
 * 明文兜底，故此处显式检查 isEncryptionAvailable，不可用就拒绝写入而不是假装加密了。
 *
 * 密文单独存 secrets.json，不混进 providers.json —— providers.json 是可以贴给别人看的配置，
 * 密文不该跟着它一起被复制。
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { safeStorage } from "electron";
import type { SecretsPort } from "./store.ts";

type SecretsFile = Record<string, string>;

export class SafeStorageSecrets implements SecretsPort {
  private readonly dir: string;
  private readonly filePath: string;

  constructor(dir: string) {
    this.dir = dir;
    this.filePath = join(dir, "secrets.json");
  }

  async set(account: string, plaintext: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error(
        "OS secret storage is unavailable, refusing to store the API key in clear text",
      );
    }
    const all = await this.readAll();
    all[account] = safeStorage.encryptString(plaintext).toString("base64");
    await this.persist(all);
  }

  async get(account: string): Promise<string | null> {
    const encoded = (await this.readAll())[account];
    if (encoded === undefined) return null;
    try {
      return safeStorage.decryptString(Buffer.from(encoded, "base64"));
    } catch {
      // 换机器 / 换系统账户后密文解不开：当作没有密钥，让用户重填，不让整个列表挂掉
      return null;
    }
  }

  async delete(account: string): Promise<void> {
    const all = await this.readAll();
    if (!(account in all)) return;
    delete all[account];
    await this.persist(all);
  }

  private async readAll(): Promise<SecretsFile> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as SecretsFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }

  private async persist(all: SecretsFile): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const tempPath = `${this.filePath}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(all, null, 2)}\n`, "utf8");
      await rename(tempPath, this.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }
}
