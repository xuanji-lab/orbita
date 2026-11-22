/**
 * 急停热键 —— 沙箱窗口在前台时用户够不到 Orbita 的「停止」按钮，所以急停必须是
 * 全局热键（`globalShortcut` → Windows 的 `RegisterHotKey`）。
 *
 * 为什么注册放在主进程：Electron 的 globalShortcut 只有主进程有；而且按下之后要做
 * 三件事，全部主进程都够得着（renderer 卡死时也不该失去保护）：
 *
 *   1. **中断当前轮**：给正在跑的会话发 `abort`（runtime 的 abortCycle +
 *      settlePendingPermissions，与「停止」同一条链）；
 *   2. **撤销本会话授权**：落 meta（`computerUseGrantedAt = null`）+ 推 agent 账本，
 *      闸门从此对本会话写工具一律拒绝——**急停后要用户重新授权才能再用**；
 *   3. **不关沙箱**：保留现场是刻意的（用户可能要看它停在哪一步），关沙箱是
 *      设置页里另一个动作。
 *
 * 这个模块只管「注册 / 注销 / 失败状态」——按下之后做什么由调用方注入（index.ts
 * 拿得到 sessions / agentHost / phases）。可注入的 register 让失败路径能被单测钉住：
 * 热键被别的应用占用时 `globalShortcut.register` **返回 false 而不是抛错**，不 surface
 * 的话用户以为自己有保护，其实没有。
 */

/** 键位候选里避开了系统占用：Alt+F4 / Ctrl+Shift+Esc / Win 系全部排除 */
export const EMERGENCY_STOP_ACCELERATOR = "Control+Alt+Shift+Escape";

export interface EmergencyStopStatus {
  /** 键位字符串（设置页展示用） */
  accelerator: string;
  /** 注册成功 = 这个热键真的能救命；false 时设置页必须如实说「被占用」 */
  registered: boolean;
  /** 注册失败的原因（给用户看的一句话）；成功时为 null */
  error: string | null;
}

export interface EmergencyStopDeps {
  /** 真实实现传 `(accelerator, callback) => globalShortcut.register(accelerator, callback)` */
  register: (accelerator: string, callback: () => void) => boolean;
  unregister: (accelerator: string) => void;
  /** 按下热键后做什么（中断 + 撤授权 + 广播；见文件头） */
  onTrigger: () => void;
}

export interface EmergencyStopController {
  status: () => EmergencyStopStatus;
  /** 应用退出前注销（Electron 在 quit 时也会清，但显式注销让释放时机可测） */
  dispose: () => void;
}

export function createEmergencyStop(deps: EmergencyStopDeps): EmergencyStopController {
  let registered = false;
  let error: string | null = null;
  try {
    registered = deps.register(EMERGENCY_STOP_ACCELERATOR, () => {
      // 按下时不再二次判 registered：能回调就说明注册成功过
      deps.onTrigger();
    });
  } catch (cause) {
    // 有的平台上非法键位会抛错而不是返回 false——两条路都要变成「设置页看得见的状态」
    registered = false;
    error = cause instanceof Error ? cause.message : String(cause);
  }
  if (!registered && error === null) {
    error = `快捷键 ${EMERGENCY_STOP_ACCELERATOR} 已被其它应用占用，急停不可用`;
  }

  return {
    status: () => ({
      accelerator: EMERGENCY_STOP_ACCELERATOR,
      registered,
      error,
    }),
    dispose: () => {
      if (!registered) return;
      try {
        deps.unregister(EMERGENCY_STOP_ACCELERATOR);
      } catch {
        // 退出路径：注销失败不影响退出（Electron 会随进程清理）
      }
      registered = false;
    },
  };
}
