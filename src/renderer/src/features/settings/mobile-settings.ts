/**
 * 设置 › 手机 的纯计算：倒计时、配对码分组、绑定地址的处境、设备的排序与在线状态。
 * 不碰 React 与 IPC，`mobile-settings.test.ts` 直接测。
 */
import {
  classifyBindAddress,
  type MobileBindCandidate,
  type MobileBindKind,
  type MobileDevice,
  type MobileSettings,
} from "../../../../shared/mobile.ts";

/** 配对码还剩几秒（向上取整，过期为 0） */
export function offerSecondsLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

/** 倒计时写成 m:ss（3 分钟以内，不会过小时） */
export function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

/** 6 位配对码按 3 + 3 分组，念和抄都不容易错位；不是 6 位就原样 */
export function groupPairingCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

/**
 * 绑定地址此刻的处境：
 * - `kind`：从候选里认出来的类别；地址不在候选里时按地址本身分类（地址没了也说得出它曾是哪一类）
 * - `missing`：设了地址，但它此刻不在本机的候选里（换了网络 / Tailscale 断了）——如实说，不静默换
 */
export interface BindView {
  address: string;
  port: number;
  kind: MobileBindKind | null;
  interfaceName: string | null;
  missing: boolean;
}

export function bindView(settings: Pick<MobileSettings, "bind" | "candidates">): BindView | null {
  if (settings.bind === null) return null;
  const { address, port } = settings.bind;
  const match: MobileBindCandidate | undefined = settings.candidates.find((candidate) => candidate.address === address);
  return {
    address,
    port,
    kind: match?.kind ?? classifyBindAddress(address),
    interfaceName: match?.interfaceName ?? null,
    missing: match === undefined,
  };
}

/**
 * 设备的排法：此刻在线的在前；其余按最近一次连上（没连过的按配对时间）从新到旧。
 * 丢了的手机多半是很久没连过的那台，沉在下面；正在用的总在最上面。
 */
export function sortDevices(devices: readonly MobileDevice[]): MobileDevice[] {
  const recency = (device: MobileDevice): number => device.lastSeenAt ?? device.pairedAt;
  return [...devices].sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1;
    return recency(b) - recency(a);
  });
}

/** 「很久没用了」的门槛：最近一次连上（没连过的按配对时间）早于 30 天前 */
export const STALE_DEVICE_MS = 30 * 24 * 3600_000;

/**
 * 很久没用的设备：此刻不在线，且最近一次连上（没连过的按配对时间）在 30 天以前。
 * 设置页把它整行退成三级灰、行尾写「很久没用了」——丢了的、换掉的手机多半就是它，提醒用户可以移除。
 */
export function isStaleDevice(device: MobileDevice, now: number): boolean {
  if (device.connected) return false;
  return now - (device.lastSeenAt ?? device.pairedAt) > STALE_DEVICE_MS;
}

/**
 * 地址菜单里要不要写网卡名：同一类（Tailscale / 局域网 / 仅本机）只有一个地址时，类名就够分了，
 * utun4、en0 这种名字对用户是噪音；同类有两个以上，才靠网卡名区分。
 */
export function needsInterfaceName(candidate: MobileBindCandidate, candidates: readonly MobileBindCandidate[]): boolean {
  return candidates.filter((other) => other.kind === candidate.kind).length > 1;
}

/** 生成配对码之后新冒出来的设备（配上了）：前后两份列表按 id 比，取最新配对的一台 */
export function newlyPaired(before: ReadonlySet<string>, after: readonly MobileDevice[]): MobileDevice | null {
  const fresh = after.filter((device) => !before.has(device.id));
  if (fresh.length === 0) return null;
  return fresh.reduce((latest, device) => (device.pairedAt > latest.pairedAt ? device : latest));
}

/** 端口输入框的文字 → 端口；不是 1–65535 的整数返回 null */
export function parsePortInput(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,5}$/.test(trimmed)) return null;
  const port = Number(trimmed);
  return port >= 1 && port <= 65535 ? port : null;
}
