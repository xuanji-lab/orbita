/**
 * P3 的第三个后端：每 agent 一台真 Linux 桌面 VM（QEMU + WHPX）。**本文件是空位，不是实现。**
 *
 * 为什么现在就在仓里：P3-1 的任务是「把第三个后端的位置留出来」，让 runtime 的注册表、
 * 能力声明、租约粒度三件事在 QEMU 真的接上时不用再改一遍结构。这里给出一个完整的
 * `SandboxProvider`，每个方法都如实回「还没接上」——不假装能起，也不抛异常把上层打崩。
 *
 * 能力声明是**P3 的目标形态**（不是现状，因为现状什么都没有）：真桌面 + 真指针 + GUI，
 * 能快照（qcow2 overlay），但**没有宿主映射目录**——QEMU on Windows 没有 9p/virtfs，
 * 文件只有 SMB / SFTP / VVFAT 三条路（2026-10-26 调研，P3-1 预检再次确认 Windows 构建
 * 连 `-vnc` 都没编）。接实现时以这几条为设计约束，别假设它能像 WSB 那样映射文件夹。
 *
 * 接上实现的顺序（P3-2）：预检 → 起 VM + 串口/桥 → 截图与输入 → 快照回滚 → 并行 4 台。
 * 那时把 start/stop 与 guest 车道换成本文件里的真实现，`capabilities` 只改「已做到」的项。
 */
import {
  sessionDesktopKey,
  type ComputerUseScreenshotResult,
  type ComputerUseStartResult,
  type ComputerUseStopResult,
  type ComputerUseUiaActResult,
  type ComputerUseUiaAction,
  type ComputerUseUiaListResult,
  type ComputerUseWindowListResult,
  type ComputerUseWindowShotResult,
  type SandboxStatus,
} from "../../shared/computer-use.ts";
import type { GuestCommandReply, GuestShotReply } from "./sandbox.ts";
import { SANDBOX_NOT_IMPLEMENTED, type SandboxCapabilities, type SandboxProvider, type SandboxProviderId } from "./provider.ts";

/**
 * QEMU 后端的**目标**能力（P3-2 才逐条成立）。故意写在实现之前：这几项就是 P3-2 的验收清单。
 *   - gui / realPointer / screenshot / windows：guest 里有真的 XFCE 桌面与指针设备；
 *   - uia：**没有** Windows UIAutomation（Linux 侧是 AT-SPI，桥不通用）；
 *   - cdp：guest 里可以跑 chromium，调试口走 TCP；
 *   - sandboxFiles：没有宿主映射目录 → 只能靠 SMB/SFTP 另开一条路，先按做不到声明；
 *   - snapshot：qcow2 overlay，秒级回滚（live savevm 在 WHPX 下不可用，见 P3-1 预检）；
 *   - 每会话一台 VM → 每会话一个桌面。
 */
export const QEMU_CAPABILITIES: SandboxCapabilities = {
  gui: true,
  realPointer: true,
  screenshot: true,
  windows: true,
  uia: false,
  cdp: true,
  sandboxFiles: false,
  desktopScope: "per-session",
  snapshot: "overlay",
};

export class QemuSandboxProvider implements SandboxProvider {
  readonly id: SandboxProviderId = "qemu";
  readonly capabilities: SandboxCapabilities = QEMU_CAPABILITIES;

  /** 永远 off：没有 VM 可报。接上实现后改成真状态机 */
  status(): SandboxStatus {
    return { state: "off" };
  }

  async start(): Promise<ComputerUseStartResult> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async stop(): Promise<ComputerUseStopResult> {
    // 没起来过 → 已经是停的。这里不报错：stop 的语义是「让它别在跑」，本来就达成了
    return { ok: true };
  }

  desktopKey(sessionId: string): string {
    // 每会话一台 VM。没接上之前也不该让两个会话排队等同一块屏幕
    return sessionDesktopKey(sessionId);
  }

  async screenshot(): Promise<ComputerUseScreenshotResult> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async windowShot(): Promise<ComputerUseWindowShotResult> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async listWindows(): Promise<ComputerUseWindowListResult> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async uiaList(): Promise<ComputerUseUiaListResult> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async uiaAct(options: { perform: ComputerUseUiaAction }): Promise<ComputerUseUiaActResult> {
    void options;
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async guestCommand(): Promise<GuestCommandReply> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async guestCommandReply(): Promise<GuestCommandReply> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  async guestShot(): Promise<GuestShotReply> {
    return { ok: false, error: SANDBOX_NOT_IMPLEMENTED };
  }

  dispose(): void {
    // 没有资源要收
  }
}
