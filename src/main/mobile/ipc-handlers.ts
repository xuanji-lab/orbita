/**
 * 设置 IPC 的处理核心：校验 → 落盘 → 启停监听 → 回真实状态。
 * Electron 的 ipcMain 注册在 ipc.ts；这里不 import electron，所以每条 handler 可直接测。
 */
import {
  MOBILE_DEFAULT_PORT,
  type MobileBindCandidate,
  type MobileDevice,
  type MobileOffer,
  type MobileSettings,
} from "../../shared/mobile.ts";
import { parseDeviceId, parseSetBind } from "../../shared/mobile-wire.ts";
import type { MobileStore } from "./store.ts";
import { toMobileDevice } from "./store.ts";
import type { MobileServer } from "./server.ts";
import type { HostKeys } from "./host-keys.ts";

/** 处理核心实际需要的最小面；生产传 MobileStore / MobileServer / HostKeys，测试传假实现 */
export interface MobileIpcDeps {
  store: Pick<MobileStore, "read" | "devices" | "setEnabled" | "setBind">;
  server: Pick<MobileServer, "settings" | "stop" | "start" | "pairingBook" | "isConnected" | "revokeDevice" | "reportError">;
  hostKeys: Pick<HostKeys, "ensure">;
  candidates(): MobileBindCandidate[];
}

export function createMobileIpcHandlers(deps: MobileIpcDeps): {
  get(): Promise<MobileSettings>;
  setEnabled(raw: unknown): Promise<MobileSettings>;
  setBind(raw: unknown): Promise<MobileSettings>;
  offerCreate(): Promise<MobileOffer>;
  offerCancel(): void;
  devices(): Promise<MobileDevice[]>;
  revoke(raw: unknown): Promise<MobileDevice[]>;
} {
  const { store, server, hostKeys } = deps;

  const settings = async (extraMessage: string | null = null): Promise<MobileSettings> => {
    const current = await server.settings(deps.candidates());
    return extraMessage === null || current.message !== null ? current : { ...current, message: extraMessage };
  };

  const apply = async (): Promise<MobileSettings> => {
    const state = await store.read();
    if (!state.enabled) {
      await server.stop();
      return settings();
    }
    if (state.bind === null) {
      const first = deps.candidates()[0];
      if (first === undefined) {
        await store.setEnabled(false);
        await server.stop();
        const message = "这台电脑此刻没有可绑定的 Tailscale / 私网地址";
        server.reportError(message);
        return settings(message);
      }
      await store.setBind({ address: first.address, port: MOBILE_DEFAULT_PORT });
    }
    const keys = await hostKeys.ensure();
    if (!keys.ok) {
      await store.setEnabled(false);
      await server.stop();
      server.reportError(keys.reason);
      return settings(keys.reason);
    }
    await server.start(keys.crypto);
    return settings();
  };

  const devices = async (): Promise<MobileDevice[]> =>
    (await store.devices()).map((device) => toMobileDevice(device, server.isConnected(device.id)));

  return {
    get: () => settings(),
    setEnabled: async (raw) => {
      if (typeof raw !== "boolean") throw new Error("mobile:set-enabled 的载荷必须是布尔值");
      await store.setEnabled(raw);
      return apply();
    },
    setBind: async (raw) => {
      const parsed = parseSetBind(raw);
      if (!parsed.ok) throw new Error(`mobile:set-bind：${parsed.error.message}`);
      await store.setBind(parsed.value);
      return apply();
    },
    offerCreate: async () => {
      const state = await store.read();
      const book = server.pairingBook();
      const status = await server.settings([]);
      if (!state.enabled || state.bind === null || book === null || !status.listening) {
        throw new Error(status.message ?? "先开启手机服务并选好绑定的地址，再生成配对码");
      }
      const offer = await book.create();
      return { code: offer.code, expiresAt: offer.expiresAt, address: state.bind.address, port: state.bind.port };
    },
    offerCancel: () => server.pairingBook()?.cancel(),
    devices,
    revoke: async (raw) => {
      const parsed = parseDeviceId(raw);
      if (!parsed.ok) throw new Error(`mobile:revoke：${parsed.error.message}`);
      await server.revokeDevice(parsed.value);
      return devices();
    },
  };
}
