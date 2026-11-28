/**
 * 隔离后端的统一面（provider）——P3 之前只有两个后端，各自一套控制器，接口「大体对齐」；
 * 这里把它写成一个类型，让「谁能当隔离桌面」只有一个答案，第三个后端（QEMU）有地方可插。
 *
 * 为什么要这一层：上层已经有一份门面（runtime.ts）在「选谁」了，但「一个后端能做哪些事」
 * 还是靠后端 id 猜的（`runningBackend() === "isolation-session"` 这种）。id 只能回答
 * 「是谁」，回答不了「它能不能上传文件 / 有没有真实指针」。能力是后端自己的事实，由后端声明；
 * 上层只读声明，不猜 id——否则每加一个后端都要回来改一次这些 if。
 *
 * **能力声明必须与实现同源**：每个后端在 `capabilities` 里说的，就是它自己代码里做的事。
 * 说 `realPointer: false` 的后端，像素输入命令必须在它自己的控制器里拒（L2b 就是这么做的）；
 * 声明与实现分叉过一次就没人再信它了。
 *
 * 这个文件**只有类型与常量**：不 import electron、不 import 任何后端，避免把三个后端
 * 互相绑在一起（provider 是它们共同的底座，不是它们的上级）。
 */
import type {
  ComputerUseGuestCommand,
  ComputerUseStartResult,
  ComputerUseStopResult,
  SandboxStatus,
} from "../../shared/computer-use.ts";
import type { ComputerUseGuest } from "./agent-requests.ts";
import type { GuestCommandReply, GuestShotReply } from "./sandbox.ts";

/**
 * 后端 id。`wsb` / `isolation-session` 是设置页可选的两个（shared 的 ComputerUseBackend）；
 * `qemu` 是 P3 的第三个位置：类型先齐，实现接在 P3-2，设置项到那时才开。
 */
export type SandboxProviderId = "wsb" | "isolation-session" | "qemu";

/**
 * 一个后端能做什么。**只写事实，不写愿望**：值取自这个后端已经在做的事，不是计划里打算做的事。
 *
 * 为什么这几项：L2b 的验收已经证明后端之间能力不同（会话里没有真实指针、没有共享映射目录），
 * P3 的 QEMU 又会是第三种形状（有真指针、有 GUI、能快照、但没有宿主机映射目录）。
 * 上层（上传/下载闸门、未来的 UI 能力行）按这些字段判断，就不再需要认识每个后端的名字。
 */
export interface SandboxCapabilities {
  /** 有没有一块真的图形桌面（能出画面）。false = 只有会话/无头，截图也无从谈起 */
  gui: boolean;
  /**
   * 有没有真实指针设备：`SendInput` 能落到桌面上。
   * false 时像素输入（click / type / key / scroll）一律不下发——它会「成功」但什么也没发生。
   */
  realPointer: boolean;
  /** 整桌面截图 */
  screenshot: boolean;
  /** 窗口枚举 + 按窗口截图（win-list / win-shot） */
  windows: boolean;
  /** UIAutomation 控件树（uia-list / uia-act） */
  uia: boolean;
  /**
   * 这个后端能提供什么级别的「动作生效证据」。
   *
   * 为什么要有这一项：像素动作的回执有五档（confirmed / partial / unverifiable /
   * suspected_noop / refused，见 shared/computer-use.ts），其中 confirmed 与 suspected_noop
   * **都要求有读回**。没有读回的后端（L3 的 Linux 桌面：没有 UIA、也没有按窗口截图）拿不到
   * 任何读回，所以它**永远**不能出这两档——否则模型会等一个永远不来的确认，然后开始瞎试。
   *
   *   value    有控件树，能读控件值（UIA）→ confirmed 有可能
   *   window   没有控件树，但有按窗口截图 / 窗口状态 → 读回最多到窗口一级
   *   none     没有任何精确读回：confirmed 与 suspected_noop 永不出现，工具层降级成
   *            unverifiable 并告诉模型「点完请截图确认」
   *
   * **一致性规则（单测逐后端校验，与实现同源）**：
   *   uia === true  ⇒ 必须是 "value"
   *   否则 windows === true ⇒ 必须是 "window"
   *   否则 ⇒ 必须是 "none"
   * 声明得比实现高（说了 value 却没有 UIA）就是「伪造证据」，比不说话更坏。
   */
  evidence: "value" | "window" | "none";
  /** guest 里 chromium 的调试口（cdp-* 车道） */
  cdp: boolean;
  /**
   * 浏览器车道的上传/下载：要把宿主文件放进 guest 的**映射目录**。
   * false = guest 里没有那个目录（文件会落进 guest 内部、宿主永远拿不到），必须在宿主侧就拒。
   */
  sandboxFiles: boolean;
  /** 桌面粒度：一块共享屏幕（全局独占）还是每会话一个桌面（每会话一把租约） */
  desktopScope: "shared" | "per-session";
  /** 整机快照能力：none = 只能冷启；overlay = qcow2 overlay 秒级回滚（P3 的 QEMU） */
  snapshot: "none" | "overlay";
}

/**
 * 一个隔离后端。两个已有控制器结构上就满足它（同一套 guest 车道方法），
 * 所以收编不需要包一层适配器——只是给它们加上 id / capabilities / desktopKey。
 */
export interface SandboxProvider extends ComputerUseGuest {
  readonly id: SandboxProviderId;
  readonly capabilities: SandboxCapabilities;
  status(): SandboxStatus;
  start(): Promise<ComputerUseStartResult>;
  stop(): Promise<ComputerUseStopResult>;
  /**
   * 桌面租约键。共享桌面用全局键（同一时间只允许一个会话用），
   * 每会话桌面用带 sessionId 的键（两个会话各用各的，互不排队）。
   */
  desktopKey(sessionId: string): string;
  /**
   * 带 `resp` 原样回执的那条命令道。CDP 车道（cdp-*）走它：桥回的字段要一字不改地
   * 交给上层，不能在这一层被解释。`guestCommand` 是它的「只要成功/失败」版本。
   */
  guestCommandReply(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestCommandReply>;
  /** 带 JPEG 兄弟文件的命令（cdp-shot / 像素截图共用） */
  guestShot(command: ComputerUseGuestCommand, fields: Record<string, unknown>): Promise<GuestShotReply>;
  /** 应用退出时的总清理（WSB 是同步的、其余是异步的，所以两边都允许） */
  dispose(): void | Promise<void>;
}

/** 一个后端都没在跑时，车道方法回给用户/模型的话（三个后端同源，别各写一份） */
export const SANDBOX_NOT_RUNNING = "隔离桌面没有在运行——先在「设置 › 实验功能 › 电脑使用」里启动它";

/**
 * 后端**在跑/在起，但还没就绪**时回给模型的话（2026-11-28 验收 P3-2）。
 *
 * 为什么需要它：runtime 只判「后端对象在不在」（state !== "off"），
 * 于是 starting / stopping / error 三态都会把命令下发给一个还没有桥的控制器，
 * 回执变成「没找到标题包含…的窗口」——模型读到的是一个**窗口名**，而不是真正的原因。
 * 统一成「先原因、后建议」，六个 computer_* 工具与 sandbox_* 都走这一句。
 *
 * 文案里先说不存在什么（桥 / 运行中的桌面），再说下一步；不给「换一个窗口」这种
 * 在错误前提下才成立的建议。
 */
export function sandboxReadinessError(state: SandboxStatus["state"]): string {
  if (state === "starting") {
    return (
      "隔离桌面还在启动，桥还没有就绪——这次命令没有执行。等设置页显示「运行中」再试" +
      "（首次启动要一两分钟；超时可以点停止再启动）"
    );
  }
  if (state === "stopping") {
    return "隔离桌面正在关闭，这次命令没有执行。等它关完再启动后再试";
  }
  if (state === "error") {
    return (
      "隔离桌面处于错误状态、没有在运行——这次命令没有执行。先去「设置 › 实验功能 › 电脑使用」里" +
      "点停止复位、再启动；起不来时看设置页那几行提示"
    );
  }
  return SANDBOX_NOT_RUNNING;
}

/** 未实现的后端（P3 的 QEMU 空位）统一用这句话，接上实现时删掉 */
export const SANDBOX_NOT_IMPLEMENTED = "这个隔离后端还没接上（P3-2 才实现）";
