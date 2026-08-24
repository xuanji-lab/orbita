/**
 * IPC 通道常量 —— 四层契约的第 1 层，双端唯一真源。
 * 旧仓两端各自硬编码过同一个通道名，改名要改两处、漏一处就是运行时静默失败。
 */
export const ipcChannels = {
  providerList: "provider:list",
  providerUpsert: "provider:upsert",
  providerRemove: "provider:remove",
} as const;

export type IpcChannel = (typeof ipcChannels)[keyof typeof ipcChannels];
