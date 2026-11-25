/**
 * 手机服务的持久化：`<userData>/mobile.json`——开关、绑定的地址、已配对的设备。
 *
 * **里面没有私钥，也没有令牌**（规格第 5 节）：主机私钥在系统密钥库（SafeStorageSecrets），
 * 设备登记的是公钥——忘掉设备就是删掉这条记录，之后它再也算不出信道密钥。
 *
 * 原子写（`writeJsonAtomic`），读改写串行化：设置页、配对、心跳更新 `lastSeenAt` 都可能并发来改，
 * 整文件读改写不排队会互相覆盖（`SafeStorageSecrets` 同一条教训，安全审查第 8 条）。
 */
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { writeJsonAtomic } from "../atomic-write.ts";
import { isBindableAddress, isMobilePort, MOBILE_CRYPTO, type MobileBindCandidate, type MobileDevice, type MobileSettings } from "../../shared/mobile.ts";

export interface StoredMobileDevice {
  /** 32 个小写十六进制字符（16 字节随机） */
  id: string;
  name: string;
  /** base64：设备的 X25519 公钥，32 字节 */
  boxPublic: string;
  /** Unix 毫秒 */
  pairedAt: number;
  /** 从没连上过是 null */
  lastSeenAt: number | null;
}

export interface MobileState {
  enabled: boolean;
  bind: { address: string; port: number } | null;
  devices: StoredMobileDevice[];
  /**
   * 主机私钥读不回来时留下的告示（安全审查第 8 条：不许悄悄换新钥匙还留着旧设备）。
   * 设备已被清空、钥匙已重铸；下次配对成功才清掉这句。null = 一切正常。
   */
  hostKeyNotice: string | null;
}

const EMPTY: MobileState = { enabled: false, bind: null, devices: [], hostKeyNotice: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 坏行 / 坏文件当空文件处理：宁可回默认，也不让手机服务因为一份坏 JSON 起不来 */
function shape(raw: unknown): MobileState {
  if (!isRecord(raw)) return { ...EMPTY };
  const enabled = raw["enabled"] === true;
  let bind: MobileState["bind"] = null;
  const rawBind = raw["bind"];
  if (isRecord(rawBind) && typeof rawBind["address"] === "string" && isBindableAddress(rawBind["address"]) && isMobilePort(rawBind["port"])) {
    bind = { address: rawBind["address"], port: rawBind["port"] };
  }
  const devices: StoredMobileDevice[] = [];
  if (Array.isArray(raw["devices"])) {
    for (const item of raw["devices"] as unknown[]) {
      if (!isRecord(item)) continue;
      const { id, name, boxPublic, pairedAt, lastSeenAt } = item as Record<string, unknown>;
      if (typeof id !== "string" || !MOBILE_CRYPTO.deviceIdPattern.test(id)) continue;
      if (typeof name !== "string" || typeof boxPublic !== "string") continue;
      const decodedKey = Buffer.from(boxPublic, "base64");
      if (decodedKey.length !== 32 || decodedKey.toString("base64") !== boxPublic) continue;
      if (typeof pairedAt !== "number" || !Number.isFinite(pairedAt)) continue;
      devices.push({
        id,
        name,
        boxPublic,
        pairedAt,
        lastSeenAt: typeof lastSeenAt === "number" && Number.isFinite(lastSeenAt) ? lastSeenAt : null,
      });
    }
  }
  return {
    enabled: enabled && bind !== null,
    bind,
    devices,
    hostKeyNotice: typeof raw["hostKeyNotice"] === "string" ? raw["hostKeyNotice"] : null,
  };
}

export class MobileStore {
  private readonly filePath: string;
  private cache: MobileState | null = null;
  /** 读改写排在这一条链上；某一环失败不卡住后面的 */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(userDataDir: string) {
    this.filePath = join(userDataDir, "mobile.json");
  }

  /** 此刻的快照（内存里的为准；第一次读盘）。坏文件 / 半截文件当空文件——服务不能因为它起不来 */
  async read(): Promise<MobileState> {
    if (this.cache !== null) return this.cache;
    let raw: unknown = null;
    try {
      raw = JSON.parse(await readFile(this.filePath, "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return (this.cache = { ...EMPTY });
      if (cause instanceof SyntaxError) return (this.cache = { ...EMPTY });
      throw cause;
    }
    this.cache = shape(raw);
    return this.cache;
  }

  /**
   * 串行读改写：`fn` 拿到当前状态的**可变副本**，直接改它；落盘后的完整状态作为返回值。
   * `fn` 抛错不落盘。
   */
  async update(fn: (state: MobileState) => void | Promise<void>): Promise<MobileState> {
    const next = this.chain.then(async () => {
      const state = structuredClone(await this.read());
      await fn(state);
      await writeJsonAtomic(this.filePath, state);
      this.cache = state;
      return state;
    });
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // ———————————————————— 常用的小口子 ————————————————————

  /** 已配对的设备（登记的就是公钥，不是令牌） */
  async devices(): Promise<StoredMobileDevice[]> {
    return (await this.read()).devices;
  }

  async device(id: string): Promise<StoredMobileDevice | null> {
    return (await this.read()).devices.find((device) => device.id === id) ?? null;
  }

  /** 配对成功登记一台。同 id 覆盖（不该发生，发生也以后来的为准） */
  async addDevice(device: StoredMobileDevice): Promise<MobileState> {
    return this.update((state) => {
      state.devices = [...state.devices.filter((existing) => existing.id !== device.id), device];
      // 配上新设备，「密钥丢过」的告示就完成了它的使命
      state.hostKeyNotice = null;
    });
  }

  /**
   * 忘掉一台设备。给了 `beforePersist`（撤销在线设备）时，**先改内存**，再执行断连 / 清回复，最后落盘；
   * 这样清回复的 await 期间，新 hello 也已经查不到这台设备。落盘失败不回退内存里的安全状态。
   */
  async removeDevice(id: string, beforePersist?: () => void | Promise<void>): Promise<MobileState> {
    const next = this.chain.then(async () => {
      const state = structuredClone(await this.read());
      state.devices = state.devices.filter((device) => device.id !== id);
      this.cache = state;
      await beforePersist?.();
      await writeJsonAtomic(this.filePath, state);
      return state;
    });
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** 连上过一次：刷新 lastSeenAt（心跳每次都写太勤，由调用方节流） */
  async touchDevice(id: string, at: number): Promise<void> {
    await this.update((state) => {
      const device = state.devices.find((entry) => entry.id === id);
      if (device !== undefined) device.lastSeenAt = at;
    });
  }

  /** 改名（手机在 hello 里带了新名字） */
  async renameDevice(id: string, name: string): Promise<void> {
    await this.update((state) => {
      const device = state.devices.find((entry) => entry.id === id);
      if (device !== undefined && name !== "") device.name = name;
    });
  }

  async setEnabled(enabled: boolean): Promise<MobileState> {
    return this.update((state) => {
      state.enabled = enabled;
    });
  }

  async setBind(bind: { address: string; port: number } | null): Promise<MobileState> {
    return this.update((state) => {
      state.bind = bind;
    });
  }

  /** 主机私钥丢过：清空设备、留下告示（设备旧公钥对着新私钥全是死的，留一条都只会误导） */
  async clearDevicesForLostKey(notice: string): Promise<MobileState> {
    return this.update((state) => {
      state.devices = [];
      state.hostKeyNotice = notice;
    });
  }
}

/** 设置页的 MobileSettings：合并「此刻可绑的地址」（现算，不落盘）与监听的真实状态（服务器的内存） */
export function mobileSettingsOf(
  state: MobileState,
  candidates: MobileBindCandidate[],
  listening: boolean,
  message: string | null,
): MobileSettings {
  return { enabled: state.enabled, bind: state.bind, candidates, listening, message, hostKeyNotice: state.hostKeyNotice };
}

export function toMobileDevice(stored: StoredMobileDevice, connected: boolean): MobileDevice {
  return { id: stored.id, name: stored.name, pairedAt: stored.pairedAt, lastSeenAt: stored.lastSeenAt, connected };
}
