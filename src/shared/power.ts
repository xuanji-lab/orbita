/**
 * 电源状态（四层契约第 1 层）：主进程用 Electron 的 powerMonitor 判断接没接电源，经 power:state（renderer 主动问）
 * 与 power:changed（on-battery / on-ac 时主进程广播）告诉 renderer。renderer 据此在离电时进省电档（星系停转、碎石带隐藏、眼睛不跟）。
 * 2026-11-24 用户：「还可以检测到电脑离电，提醒用户关掉来增加保证续航。能离电就默认关掉吗？」
 */
export interface PowerState {
  /** 正在用电池（没接电源）。台式机、拿不到电池信息的系统恒为 false */
  onBattery: boolean;
}

export function isPowerState(raw: unknown): raw is PowerState {
  return typeof raw === "object" && raw !== null && typeof (raw as { onBattery?: unknown }).onBattery === "boolean";
}
