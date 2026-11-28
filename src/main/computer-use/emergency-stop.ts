/**
 * 急停热键 —— 沙箱窗口在前台时用户够不到 Orbita 的「停止」按钮，所以急停必须是
 * 全局热键（`globalShortcut` → Windows 的 `RegisterHotKey`）。
 *
 * 为什么注册放在主进程：Electron 的 globalShortcut 只有主进程有；而且按下之后要做
 * 三件事，全部主进程都够得着（renderer 卡死时也不该失去保护）：
 *
 *   1. **中断当前轮**：给正在跑的会话发 `abort`（runtime 的 abortCycle，与「停止」
 *      同一条链）；
 *   2. **撤销电脑使用授权**（2026-11-27）：还活着的会话 `computerUseConsent` 复位成
 *      `unset`（下一次电脑操作会重新问一次用户），挂起中的授权提问按 **cancelled** 结掉
 *      ——**不写盘**，用户没有表态，那不是拒绝。
 *      注意这不是已删除的 PermissionMode / 审批卡——它只是「本会话能不能碰这台桌面」
 *      这条持久记录被收回；
 *   3. **不关沙箱**：保留现场是刻意的（用户可能要看它停在哪一步），关沙箱是
 *      设置页里另一个动作。
 *
 * **一个键位不够**（2026-11-28 验收 P2-2）：验收机上第一个组合被别的应用占着，
 * `registered=false`，而设置页没有换键入口——安全兜底等于不存在。现在按候选表
 * 依次尝试，取第一个注册成功的；设置页显示**实际生效**的那个（与主选不同时给一句
 * 「主快捷键被占用，已改用 X」）。全失败才是失败态，且文案给出可执行的下一步。
 *
 * 这个模块只管「注册 / 注销 / 状态」——按下之后做什么由调用方注入（index.ts
 * 拿得到 sessions / agentHost / phases）。可注入的 register 让失败路径能被单测钉住：
 * 热键被别的应用占用时 `globalShortcut.register` **返回 false 而不是抛错**，不 surface
 * 的话用户以为自己有保护，其实没有。
 */

import { cuTexts } from "./ui-language.ts";

/**
 * 候选键位，按顺序尝试。选型原则：**三条都是「三个修饰键 + 一个不常用的键」**——
 * 与常见桌面快捷键错开（Alt+F4 / Ctrl+Shift+Esc / Win 系全部排除），也不跟输入法
 * 切换（Ctrl+Space / Ctrl+Shift）、终端（Ctrl+Shift+字母）撞。
 *
 *   - `Control+Alt+Shift+Escape`：主选。三个修饰键同时按的组合几乎没人注册，
 *     Escape 也不被系统单独占用（Ctrl+Shift+Esc 是任务管理器，多一个 Alt 就不是）。
 *   - `Control+Alt+Shift+End`：End 在全局热键里很少见；与 Ctrl+Alt+Del 不同键。
 *   - `Control+Shift+F12`：F12 只有浏览器开发者工具用它（局部的），全局注册很少冲突。
 *
 * 顺序即优先级：第一个能注册上的就是实际生效的。
 */
export const EMERGENCY_STOP_ACCELERATORS = [
  "Control+Alt+Shift+Escape",
  "Control+Alt+Shift+End",
  "Control+Shift+F12",
] as const;

/** 主选（设置页在「被占用、已降级」时拿它做对比；历史代码也引用这个名字） */
export const EMERGENCY_STOP_ACCELERATOR = EMERGENCY_STOP_ACCELERATORS[0];

export interface EmergencyStopStatus {
  /** **实际生效**的键位（全失败时回主选，设置页据此显示「本该是它」） */
  accelerator: string;
  /** 主选键位：与 accelerator 不同时说明已降级到候选 */
  preferred: string;
  /** 注册成功 = 这个热键真的能救命；false 时设置页必须如实说「全都不可用」 */
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
  let active: string | null = null;
  let error: string | null = null;
  const attempts: string[] = [];

  // 让每一条候选都拿到**同一个**回调：按下时不再二次判 active（能回调就说明注册成功过）
  const onPress = (): void => deps.onTrigger();

  for (const accelerator of EMERGENCY_STOP_ACCELERATORS) {
    attempts.push(accelerator);
    let ok = false;
    try {
      ok = deps.register(accelerator, onPress);
    } catch (cause) {
      // 有的平台上非法键位会抛错而不是返回 false——继续试下一个候选
      error = cause instanceof Error ? cause.message : String(cause);
      continue;
    }
    if (ok) {
      active = accelerator;
      error = null;
      break;
    }
  }

  if (active === null && error === null) {
    // 全失败且没有抛错：说清试过哪些组合、下一步能做什么（用户没有换键入口，
    // 唯一能做的是腾出键位再重启）
    error = cuTexts().emergencyHotkeyTaken(attempts.join(" / "));
  }

  return {
    status: () => ({
      accelerator: active ?? EMERGENCY_STOP_ACCELERATOR,
      preferred: EMERGENCY_STOP_ACCELERATOR,
      registered: active !== null,
      error,
    }),
    dispose: () => {
      if (active === null) return;
      try {
        deps.unregister(active);
      } catch {
        // 退出路径：注销失败不影响退出（Electron 会随进程清理）
      }
      active = null;
    },
  };
}
