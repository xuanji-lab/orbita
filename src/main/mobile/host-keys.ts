/**
 * 主机加密私钥的生命周期（安全审查第 8 条的三条硬规矩都在这儿）：
 *
 * 1. **密钥库不可用时拒绝启用，不是假装加密了。** 除 `isEncryptionAvailable()` 外还要看
 *    `getSelectedStorageBackend()`——Linux 没有 keyring 时 Electron 会用硬编码口令「加密」，
 *    等于明文（safeStorage 文档明说）。这种环境生成私钥就是自欺，直接拒绝并说明原因。
 * 2. **写走串行化。** `SafeStorageSecrets` 的 set 是整文件读改写，并发会互相覆盖、连带丢同一文件里的
 *    API 密钥——那一份实现里已有实例级的写锁，这里调用就天然安全；单测里跑并发写验证过。
 * 3. **读不回来时不许悄悄换新钥匙。** 密钥不见了或密文解不开（换机 / 重装系统 / 删掉 secrets.json）：
 *    旧设备的公钥对着新私钥全是死的，留着列表只会误导——**先清空设备、留告示**，再重铸。
 *    告示一直挂到成功配上一台新设备（`MobileStore.addDevice` 清掉）。
 *
 * 私钥的存储形态：32 字节原始 X25519（base64）进 SafeStorageSecrets，account = `mobile-host-box`。
 */
import type { KeyObject } from "node:crypto";
import { boxKeyPairFromRaw, generateBoxKeyPair } from "./crypto.ts";
import type { SecretsPort } from "../provider/store.ts";

export const MOBILE_HOST_KEY_ACCOUNT = "mobile-host-box";

/** safeStorage 的那点事，注入进来（测试不进 electron）。backend 是 `getSelectedStorageBackend()` 的原值 */
export interface SafeStorageProbe {
  available(): boolean;
  backend(): string;
}

export interface HostCrypto {
  privateKey: KeyObject;
  /** 原始 32 字节（`pair.start` 应答里发给手机） */
  publicRaw: Buffer;
}

export type HostKeyResult = { ok: true; crypto: HostCrypto } | { ok: false; reason: string };

export interface HostKeysDeps {
  secrets: SecretsPort;
  safeStorage: SafeStorageProbe;
  /** 此刻登记着几台设备（密钥丢了要不要清列表，看它） */
  deviceCount(): Promise<number>;
  /** 密钥丢了：清空设备 + 落盘告示 */
  onKeyLost(notice: string): Promise<void>;
}

const LOST_NOTICE = "主机私钥从系统密钥库读不回来了（换机或重装系统？）：已配对的设备已清空，钥匙已重铸，请让手机重新配对";

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
      return { ok: false, reason: "这台电脑的系统密钥库不可用，主机私钥没有安全的地方存——手机服务开不了" };
    }
    if (this.deps.safeStorage.backend() === "basic_text") {
      return {
        ok: false,
        reason: "系统密钥库退化成明文存储了（Linux 常见：没装 keyring）——主机私钥存进去等于没加密，先给系统配上 keyring 再开手机服务",
      };
    }
    return { ok: true };
  }

  /**
   * 拿到主机密钥对：第一次生成并落库；读得回就复用；读不回（不存在 / 密文损坏）时若还有登记设备，
   * **清空设备、留告示**再重铸。`usable()` 不过时直接拒绝。
   */
  /** 并发启用 / 改绑定共用同一次初始化，绝不并发生成两把主机钥匙 */
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

  private async ensureFresh(): Promise<HostKeyResult> {
    if (this.cached !== null) return { ok: true, crypto: this.cached };
    const usable = this.usable();
    if (!usable.ok) return { ok: false, reason: usable.reason };

    const stored = await this.deps.secrets.get(MOBILE_HOST_KEY_ACCOUNT);
    if (stored !== null) {
      try {
        const privateRaw = Buffer.from(stored, "base64");
        const { privateKey, publicRaw } = boxKeyPairFromRaw(privateRaw);
        this.cached = { privateKey, publicRaw };
        return { ok: true, crypto: this.cached };
      } catch {
        // 密文在、解不开（不是合法的 X25519 私钥）：与「不存在」同罪，落到底下重铸
      }
    }

    if ((await this.deps.deviceCount()) > 0) await this.deps.onKeyLost(LOST_NOTICE);

    const generated = generateBoxKeyPair();
    // 写是串行的（secrets 实例级写锁），生成与写入之间没有竞争
    await this.deps.secrets.set(MOBILE_HOST_KEY_ACCOUNT, generated.privateRaw.toString("base64"));
    const { privateKey, publicRaw } = boxKeyPairFromRaw(generated.privateRaw);
    this.cached = { privateKey, publicRaw };
    return { ok: true, crypto: this.cached };
  }
}
