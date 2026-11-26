/**
 * 离电省电档的判定（纯计算，可被 node --test 直接加载）：App 拿主进程的电源状态（shared/power.ts）与设置 › 外观「离电时省电」算出要不要省电，
 * 往下发给星系（停转、碎石带隐藏）与眼睛（不跟指针）。
 */
export interface PowerSaveInput {
  onBattery: boolean;
  /** 设置 › 外观 › 离电时省电（缺席 = 开） */
  enabled: boolean;
}

export function powerSaveOf(input: PowerSaveInput): boolean {
  return input.enabled && input.onBattery;
}

/** 「已切到省电」那条轻提示：第一次进省电档时出一次，之后不再出（seen 存进设置） */
export function powerNoticeDue(saving: boolean, seen: boolean): boolean {
  return saving && !seen;
}

/** 省电档下碎石带画多少：不显示（只删碎石带里的普通会话，在跑 / 等你 / 最近的碎石块照旧） */
export function dustKeepUnderPower(keep: number, saving: boolean): number {
  return saving ? 0 : keep;
}
