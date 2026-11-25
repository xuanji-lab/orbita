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
import type { SecretRead, SecretsPort } from "./store.ts";

type SecretsFile = Record<string, string>;

export class SafeStorageSecrets implements SecretsPort {
  private readonly dir: string;
  private readonly filePath: string;
  /**
   * 写操作排在这一条链上：set / delete 都是整文件的读改写，并发来两发会互相覆盖——
   * 手机的主机密钥与 provider 的 API key 共用一个文件，一边写丢了另一边就是静默丢密钥
   * （2026-11-25 手机端安全审查第 8 条）。读不排队：读到的要么是旧全量要么是新全量。
   */
  private writeChain: Promise<unknown> = Promise.resolve();

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
    await this.enqueue(async () => {
      const all = await this.readAll();
      all[account] = safeStorage.encryptString(plaintext).toString("base64");
      await this.persist(all);
    });
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
    await this.enqueue(async () => {
      const all = await this.readAll();
      if (!(account in all)) return;
      delete all[account];
      await this.persist(all);
    });
  }

  /**
   * 严格读：把「没有这条密文」「有、解得开」「有、解不开」分开说，不替调用方把失败说成「没有」。
   * 手机的主机私钥用它——`get` 那种「解不开当没有」对 API key 是对的（用户重填就是了），对主机私钥
   * 却意味着「读不出来 = 钥匙丢了 = 清空全部已配对设备」（2026-11-25 审查 S2）。
   */
  async readStrict(account: string): Promise<SecretRead> {
    const encoded = (await this.readAll())[account];
    if (encoded === undefined) return { status: "missing" };
    try {
      return { status: "ok", plaintext: safeStorage.decryptString(Buffer.from(encoded, "base64")) };
    } catch (cause) {
      return { status: "undecryptable", cause: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  /**
   * 这一刻系统密钥库给不给人解密：`exclude` 之外随便哪条密文解得开就算给。
   * 同一个应用的所有密文用同一把密钥库密码加密，有一条能解，密码就拿得到——主机私钥那条却解不开，
   * 坏的就是那条密文，不是密钥库。**只读**：不加密、不生成新密钥、不往密钥库写东西。
   * 只试遇到的第一条：钥匙串没解锁时每试一次都可能弹一次框，试完一条就能下结论。
   */
  async unlocksAny(exclude: string): Promise<boolean> {
    const all = await this.readAll();
    for (const [account, encoded] of Object.entries(all)) {
      if (account === exclude) continue;
      try {
        safeStorage.decryptString(Buffer.from(encoded, "base64"));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /** 排进写链；某一环失败不卡住后面的 */
  private enqueue(run: () => Promise<void>): Promise<void> {
    const next = this.writeChain.then(run, run);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
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
