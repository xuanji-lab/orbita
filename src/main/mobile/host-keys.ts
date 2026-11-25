/**
 * 主机加密私钥的生命周期（安全审查第 8 条的三条硬规矩都在这儿）：
 *
 * 1. **密钥库不可用时拒绝启用，不是假装加密了。** 除 `isEncryptionAvailable()` 外还要看
 *    `getSelectedStorageBackend()`——Linux 没有 keyring 时 Electron 会用硬编码口令「加密」，
 *    等于明文（safeStorage 文档明说）。这种环境生成私钥就是自欺，直接拒绝并说明原因。
 * 2. **写走串行化。** `SafeStorageSecrets` 的 set 是整文件读改写，并发会互相覆盖、连带丢同一文件里的
 *    API 密钥——那一份实现里已有实例级的写锁，这里调用就天然安全；单测里跑并发写验证过。
 * 3. **读不回来时不许悄悄换新钥匙。** 读不回来分两种，处置完全不同（2026-11-25 审查 S2）：
 *    - **确认丢了 / 坏了**：密文不在了；或者解得开、解出来的却不是一把合法的私钥；或者系统密钥库
 *      明明解得开别的密文（密码拿得到），唯独这一条连读两次都解不开。这时旧设备的公钥对着新私钥
 *      全是死的，留着列表只会误导——记一行日志，**先清空设备、留告示**，再重铸。
 *      告示一直挂到成功配上一台新设备（`MobileStore.addDevice` 清掉）。
 *    - **这会儿读不出来**：密文在、解不开，而密钥库此刻连别的密文也解不开——钥匙串还没解锁
 *      （Linux 自动登录后常见）、或者访问被拒了。这**不是**钥匙丢了：设备、密文都不动，也不重铸，
 *      回一句原因，记一行日志，解锁后再开一次开关就好。以前这一种也按「丢了」处置：一次没解锁就
 *      清空全部已配对设备、重铸钥匙，还不留日志。
 *
 * 私钥的存储形态：32 字节原始 X25519（base64）进 SafeStorageSecrets，account = `mobile-host-box`。
 */
import type { KeyObject } from "node:crypto";
import { boxKeyPairFromRaw, generateBoxKeyPair } from "./crypto.ts";
import type { SecretRead, SecretsPort } from "../provider/store.ts";

export const MOBILE_HOST_KEY_ACCOUNT = "mobile-host-box";

/** safeStorage 的那点事，注入进来（测试不进 electron）。backend 是 `getSelectedStorageBackend()` 的原值 */
export interface SafeStorageProbe {
  available(): boolean;
  backend(): string;
}

/**
 * 主机密钥要的那种读法。`SecretsPort.get` 把「解不开」也说成「没有」——对 API key 是对的
 * （用户重填就是了），对主机私钥却等于「读不出来 = 钥匙丢了 = 清空全部已配对设备」，所以这里要分开报。
 * `SafeStorageSecrets` 同时满足它与 `SecretsPort`。
 */
export interface HostKeySecrets extends Pick<SecretsPort, "set"> {
  readStrict(account: string): Promise<SecretRead>;
  /** 这一刻系统密钥库给不给人解密（只读，见 `SafeStorageSecrets.unlocksAny`） */
  unlocksAny(exclude: string): Promise<boolean>;
}

export interface HostCrypto {
  privateKey: KeyObject;
  /** 原始 32 字节（`pair.start` 应答里发给手机） */
  publicRaw: Buffer;
}

export type HostKeyResult = { ok: true; crypto: HostCrypto } | { ok: false; reason: string };

export interface HostKeysDeps {
  secrets: HostKeySecrets;
  safeStorage: SafeStorageProbe;
  /** 此刻登记着几台设备（密钥丢了要不要清列表，看它） */
  deviceCount(): Promise<number>;
  /** 密钥丢了：清空设备 + 落盘告示 */
  onKeyLost(notice: string): Promise<void>;
  /** 诊断日志；不给就打到 console.error */
  log?(line: string): void;
}

const LOST_NOTICE = "主机私钥从系统密钥库读不回来了（换机或重装系统？）：已配对的设备已清空，钥匙已重铸，请让手机重新配对";

const UNREADABLE_NOW_REASON =
  "主机私钥这会儿读不出来，已配对的设备都还在——多半是系统密钥库还没解锁，或者访问被拒了（Linux 自动登录后常见）。" +
  "解锁后再打开一次开关就会重试；如果确定不是没解锁（比如换了电脑、重装了系统），把设备逐个忘掉，再打开开关会重新生成钥匙";

/**
 * 库里那条密文此刻的状态。`undecryptable` 还不能定罪：钥匙串没解锁、访问被拒、密文坏了，落到底下都是它。
 */
type StoredKey =
  | { status: "ready"; crypto: HostCrypto }
  | { status: "missing" }
  /** 解得开，解出来的却不是一把合法的 X25519 私钥——密钥库给了密码，坏的是密文 */
  | { status: "corrupt" }
  | { status: "undecryptable"; cause: string };

export class HostKeys {
  private readonly deps: HostKeysDeps;
  private cached: HostCrypto | null = null;
  private ensuring: Promise<HostKeyResult> | null = null;

  constructor(deps: HostKeysDeps) {
    this.deps = deps;
  }

  /** 系统密钥库此刻能不能存真正的密文（Linux basic_text 等于明文，不算） */
  usable(): { ok: true } | { ok: false; reason: string } {
    if (!this.deps.safeStorage.available()) {
      return {
        ok: false,
        reason: "这台电脑的系统密钥库不可用（Linux 自动登录后钥匙串可能还没解锁；也可能是没装钥匙串服务）——手机服务开不了，已配对的设备都还在",
      };
    }
    if (this.deps.safeStorage.backend() === "basic_text") {
      return {
        ok: false,
        reason: "系统密钥库退化成明文存储了（Linux 常见：没装 keyring）——主机私钥存进去等于没加密，先给系统配上 keyring 再开手机服务",
      };
    }
    return { ok: true };
  }

  /** 并发启用 / 改绑定共用同一次初始化，绝不并发生成两把主机钥匙。失败不缓存：下一次调用会重读密钥库 */
  ensure(): Promise<HostKeyResult> {
    if (this.cached !== null) return Promise.resolve({ ok: true, crypto: this.cached });
    if (this.ensuring !== null) return this.ensuring;
    const pending = this.ensureFresh();
    this.ensuring = pending;
    void pending.then(
      () => {
        this.ensuring = null;
      },
      () => {
        this.ensuring = null;
      },
    );
    return pending;
  }

  /**
   * 拿到主机密钥对：第一次生成并落库；读得回就复用。读不回时按文件头上第 3 条的两种处置。
   * `usable()` 不过时直接拒绝。
   */
  private async ensureFresh(): Promise<HostKeyResult> {
    if (this.cached !== null) return { ok: true, crypto: this.cached };
    const usable = this.usable();
    if (!usable.ok) return { ok: false, reason: usable.reason };

    const stored = await this.readStoredKey();
    if (stored.status === "ready") return this.ready(stored.crypto);

    // 读不出合法私钥。没有设备要保护时没什么可丢的，直接重铸；有设备时「解不开」还不能定罪
    const devices = await this.deps.deviceCount();
    if (stored.status === "undecryptable" && devices > 0) {
      const judged = await this.judgeUndecryptable(stored.cause);
      if (judged.verdict === "ready") return this.ready(judged.crypto);
      if (judged.verdict === "unreadableNow") return { ok: false, reason: UNREADABLE_NOW_REASON };
    }

    // 走到这儿的是确认过的（或者没有设备要保护、没什么可丢的）
    if (devices > 0 || stored.status !== "missing") {
      const what =
        stored.status === "missing"
          ? "密文不在了"
          : stored.status === "corrupt"
            ? "解出来的不是一把合法的私钥"
            : devices === 0
              ? "解不开，也没有设备要保护"
              : "密钥库解得开别的密文，唯独这一条解不开";
      this.log(
        devices > 0
          ? `[mobile] 主机私钥确认丢了或坏了（${what}）：清空 ${devices} 台已配对设备并重铸`
          : `[mobile] 主机私钥的密文坏了（${what}），没有已配对设备要清：直接重铸`,
      );
    }
    if (devices > 0) await this.deps.onKeyLost(LOST_NOTICE);

    const generated = generateBoxKeyPair();
    // 写是串行的（secrets 实例级写锁），生成与写入之间没有竞争
    await this.deps.secrets.set(MOBILE_HOST_KEY_ACCOUNT, generated.privateRaw.toString("base64"));
    return this.ready(boxKeyPairFromRaw(generated.privateRaw));
  }

  /**
   * 有设备要保护、密文又解不开：先看密钥库这会儿解不解得开别的密文。解不开就没法定罪——钥匙串没解锁、
   * 访问被拒都是这个样子，什么都不动。解得开才回头再读这一条一次，还不行才算密文真的坏了。
   */
  private async judgeUndecryptable(cause: string): Promise<{ verdict: "unreadableNow" | "corrupt" } | { verdict: "ready"; crypto: HostCrypto }> {
    if (!(await this.deps.secrets.unlocksAny(MOBILE_HOST_KEY_ACCOUNT))) {
      const devices = await this.deps.deviceCount();
      this.log(`[mobile] 主机私钥这会儿读不出来（${cause}）：系统密钥库可能还没解锁或访问被拒。已配对的 ${devices} 台设备、密文都不动，不重铸；解锁后重试`);
      return { verdict: "unreadableNow" };
    }
    const again = await this.readStoredKey();
    if (again.status === "ready") return { verdict: "ready", crypto: again.crypto };
    return { verdict: "corrupt" };
  }

  /** 严格读一次并把明文变成密钥对。明文不是 32 字节的规范 base64，或者解出来的不是合法私钥，都算 `corrupt` */
  private async readStoredKey(): Promise<StoredKey> {
    const read = await this.deps.secrets.readStrict(MOBILE_HOST_KEY_ACCOUNT);
    if (read.status !== "ok") return read;
    try {
      const raw = Buffer.from(read.plaintext, "base64");
      if (raw.length !== 32 || raw.toString("base64") !== read.plaintext) return { status: "corrupt" };
      return { status: "ready", crypto: boxKeyPairFromRaw(raw) };
    } catch {
      return { status: "corrupt" };
    }
  }

  private ready(crypto: HostCrypto): HostKeyResult {
    this.cached = crypto;
    return { ok: true, crypto };
  }

  private log(line: string): void {
    (this.deps.log ?? ((entry: string) => console.error(entry)))(line);
  }
}
