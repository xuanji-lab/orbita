/**
 * 手机服务的 contextBridge 面 —— 四层契约的第 3 层。
 * 通道名与类型在 `src/shared/mobile.ts`；设置页（renderer）只用这个面。
 */
import { ipcRenderer } from "electron";
import {
  mobileChannels,
  type MobileDevice,
  type MobileOffer,
  type MobileSetBindInput,
  type MobileSettings,
} from "../../shared/mobile.ts";

export const mobileApi = {
  /** 设置页打开时读一次：开关、绑定、可绑候选、监听状态 */
  get: (): Promise<MobileSettings> => ipcRenderer.invoke(mobileChannels.get),
  /** 开 / 关手机服务；密钥库不可用等原因在返回的 message 里 */
  setEnabled: (enabled: boolean): Promise<MobileSettings> =>
    ipcRenderer.invoke(mobileChannels.setEnabled, enabled),
  /** 换绑定的地址与端口；地址此刻不在本机时 message 里如实说 */
  setBind: (input: MobileSetBindInput): Promise<MobileSettings> =>
    ipcRenderer.invoke(mobileChannels.setBind, input),
  /** 生成配对码（3 分钟有效）；没开启服务时会抛错 */
  offerCreate: (): Promise<MobileOffer> => ipcRenderer.invoke(mobileChannels.offerCreate),
  offerCancel: (): Promise<void> => ipcRenderer.invoke(mobileChannels.offerCancel),
  devices: (): Promise<MobileDevice[]> => ipcRenderer.invoke(mobileChannels.devices),
  /** 忘掉一台设备：它立刻断线、排队的话作废、之后再也连不上。返回剩下的设备 */
  revoke: (deviceId: string): Promise<MobileDevice[]> =>
    ipcRenderer.invoke(mobileChannels.revoke, deviceId),
};
