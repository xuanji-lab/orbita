/**
 * 「电脑使用」设置页的纯派生层：五态状态机 → 界面形态的全部换算。
 * 不碰 React、不碰 IPC（api 调用都留在 SettingsView.tsx），`node --test` 直接测
 * （computer-use-view.test.ts）。规矩照 shell/row-status.ts：图标 + 文字说话，
 * 颜色只是第二信号，tone 只装 CSS 变量名、不装裸色（设计系统硬规则）。
 */
import type { IconName } from "../../shell/Icon";
import type { Messages } from "../../messages-en.ts";
import {
  COMPUTER_USE_DEFAULT_ALLOW_NETWORK,
  COMPUTER_USE_DEFAULT_BACKEND,
  COMPUTER_USE_DEFAULT_BROWSER,
  backendNetworkControl,
  type ComputerUseBackend,
  type ComputerUseBackendChoice,
  type ComputerUseBrowser,
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type SandboxState,
  type SandboxStatus,
} from "../../../../shared/computer-use.ts";
import type { AppSettings, SettingsPatch } from "../../../../shared/settings.ts";
import { computerUsePlatformSupport, type ComputerUsePlatformSupport } from "../../../../shared/computer-use-platform.ts";

/**
 * 设置 › 电脑使用 这一页画什么：平台支持 → 控件 / 警示卡 / 中性提示。
 *
 * 非 Windows 上一整组控件全是「点了必失败」——start 在主进程就拒，模型那边也不注册工具。
 * 所以整页换成一张说明卡（不渲染任何会真去启动沙箱的按钮），但**入口不藏**：藏掉会让
 * 用户以为页面坏了。判定与主进程、agent 工具注册读同一个谓词（shared/computer-use-platform.ts）。
 *
 * 第三种是 preload 桥没就绪（`api.platform` 是空串，见 renderer/src/api.ts 的 bridgeless）：
 * 此刻全部 IPC 都不可用，再报一张「平台不支持」的卡就是把故障归错地方——既不给控件也不给卡，
 * 只留一句中性提示。空串 / 缺字段都走这一支。
 */
export type ComputerUsePage =
  | { kind: "controls" }
  | { kind: "unsupported"; support: ComputerUsePlatformSupport }
  | { kind: "unknown" };

export function computerUsePage(platform: string | null | undefined): ComputerUsePage {
  const value = typeof platform === "string" ? platform.trim() : "";
  if (value === "") return { kind: "unknown" };
  const support = computerUsePlatformSupport(value);
  return support.supported ? { kind: "controls" } : { kind: "unsupported", support };
}

/** 正在途中的那次点击；null = 没有在途动作 */
export type SandboxActionPending = "start" | "stop" | null;

export interface SandboxControl {
  canStart: boolean;
  canStop: boolean;
  canScreenshot: boolean;
}

/**
 * 五态 → 三个动作的可用性。规则来自主进程控制器的真实语义（src/main/computer-use/sandbox.ts）：
 *   start 只在 off / error 有意义（error 直接重试）；stop 幂等，starting / running / error
 *   都可点——starting 时它是「取消启动」，error 时它是「复位回 off」；截图只在 running。
 * pending 只压自己那颗按钮：starting 的 60 秒窗口里 start 本来就因状态被压着，
 * stop 必须随时可点，所以 start 在途不压 stop。
 */
export function sandboxControl(state: SandboxState, pending: SandboxActionPending): SandboxControl {
  return {
    canStart: (state === "off" || state === "error") && pending !== "start",
    canStop: (state === "starting" || state === "running" || state === "error") && pending !== "stop",
    canScreenshot: state === "running",
  };
}

/**
 * 状态兜底轮询：**事件不是唯一真相**。
 *
 * 真机 P0（2026-11-28）：QEMU 后端起起来了（进程在、端口在、截图是桌面），但主进程一条
 * `computer-use:status` 都没推——设置页一直「未启动」，「关闭」还是灰的，用户在界面上
 * 停不掉那台 VM。事件那一处已经补上（qemu.ts 每次迁移都发），但「漏一条就把用户锁死」
 * 这件事不能只靠事件：任何非稳态（启动中 / 运行中 / 关闭中）都可能在下一秒变，界面
 * 必须自己问一次主进程。
 *
 * 周期按「现在最可能发生什么」定：
 *   非稳态 / 刚点完动作 → 1.5 s（本来就在等状态变，慢一拍就难看）；
 *   off / error      → 5 s（稳定态，但**不是不轮询**：漏事件的现场恰恰是「界面说 off、
 *                        实际在跑」，若不轮询，用户永远等不到「关闭」变可点）。
 */
export const SANDBOX_STATUS_POLL_BUSY_MS = 1_500;
export const SANDBOX_STATUS_POLL_IDLE_MS = 5_000;

export function sandboxStatusPollMs(state: SandboxState, pending: boolean): number {
  if (pending) return SANDBOX_STATUS_POLL_BUSY_MS;
  return state === "starting" || state === "running" || state === "stopping"
    ? SANDBOX_STATUS_POLL_BUSY_MS
    : SANDBOX_STATUS_POLL_IDLE_MS;
}

/**
 * 两次拉到的状态是否等价（相等就不 setState，免得每 1.5–5 秒白重渲染整页）。
 * 只比这套状态机真有的字段：五个分支的并集（message / startedAt / bridgeVersion /
 * backend / agentUserName）；off 与 stopping 没有额外字段。
 */
export function sameSandboxStatus(a: SandboxStatus, b: SandboxStatus): boolean {
  if (a.state !== b.state) return false;
  const left = a as { message?: string; startedAt?: number; bridgeVersion?: string; backend?: string; agentUserName?: string };
  const right = b as typeof left;
  return (
    left.message === right.message &&
    left.startedAt === right.startedAt &&
    left.bridgeVersion === right.bridgeVersion &&
    left.backend === right.backend &&
    left.agentUserName === right.agentUserName
  );
}

export interface StatusVisual {
  icon: IconName;
  /** CSS 变量名（不写裸色），调用方挂到图标的 color 上 */
  tone: string;
  label: string;
  spin: boolean;
}

/** 五态 → 图标 / 颜色变量 / 文字。running 是唯一的上色态（success 绿），转场态画转圈。 */
export function statusVisual(state: SandboxState, t: Messages): StatusVisual {
  switch (state) {
    case "off":
      return { icon: "circle-off", tone: "var(--color-text-tertiary)", label: t.computerUse.states.off, spin: false };
    case "starting":
      return {
        icon: "loader-circle",
        tone: "var(--color-text-secondary)",
        label: t.computerUse.states.starting,
        spin: true,
      };
    case "running":
      return { icon: "circle-check", tone: "var(--color-success)", label: t.computerUse.states.running, spin: false };
    case "stopping":
      return {
        icon: "loader-circle",
        tone: "var(--color-text-secondary)",
        label: t.computerUse.states.stopping,
        spin: true,
      };
    case "error":
      return { icon: "triangle-alert", tone: "var(--color-danger)", label: t.computerUse.states.error, spin: false };
  }
}

/**
 * 出网开关的当前值：**缺席 = 缺省**（与主进程 `effectiveAllowNetwork`、控制器缺省分支读的是
 * 同一个 `COMPUTER_USE_DEFAULT_ALLOW_NETWORK`）。
 * 解析层只在用户真的动过开关时落这个键，所以 UI 必须自己兜这一层——
 * 否则新用户看到的是 Off，而沙箱实际在联网。
 */
export function allowNetworkEnabled(settings: AppSettings): boolean {
  return settings.computerUse?.allowNetwork ?? COMPUTER_USE_DEFAULT_ALLOW_NETWORK;
}

/**
 * 点一下开关要发的补丁。**只发自己改的那个键**：`SettingsStore.write` 对 computerUse 做
 * 按键合并（同 drawer / lastUsed），整对象回写会把手写的 allowedApps / browser 冲掉。
 */
export function allowNetworkPatch(enabled: boolean): Pick<SettingsPatch, "computerUse"> {
  return { computerUse: { allowNetwork: enabled } };
}

/**
 * 「允许沙箱出网」这一行在这只后端上能不能动——派生层，不碰组件。
 *
 * 为什么要有这一格：这个开关连着三个后端，其中 L2b（isolation-session）做不到断网
 * （它就在用户自己这台机器的另一个登录会话里）。以前设置页对三个后端一视同仁：用户把
 * 开关关掉，界面说「已关」，而 L2b 照样联网——**设置骗人**。现在这一行在后端做不到时
 * 变成不可操作，并把原因写在行底；**已存的值一个字节也不改**（只是不让编辑），所以
 * 换回 wsb / qemu 时用户原来的选择还在。
 *
 * 判定只读 shared 的 `backendNetworkControl`：提示词那边用的是同一个谓词，两边不会分叉。
 */
export type AllowNetworkRow =
  | { editable: true }
  /** reason 是行底那句人话（i18n 表里来，不在这里拼） */
  | { editable: false; reason: string };

export function allowNetworkRow(backend: ComputerUseBackend, t: Messages): AllowNetworkRow {
  if (backendNetworkControl(backend) === "enforced") return { editable: true };
  return { editable: false, reason: t.computerUse.allowNetworkLocked };
}

/**
 * 沙箱浏览器的当前值：**缺席 = 缺省**（与主进程 `effectiveGuestBrowser`、桥的缺省读的是
 * 同一个 `COMPUTER_USE_DEFAULT_BROWSER`）。解析层只在用户真的选过时才落这个键。
 */
export function browserChoice(settings: AppSettings): ComputerUseBrowser {
  return settings.computerUse?.browser ?? COMPUTER_USE_DEFAULT_BROWSER;
}

/** 选一个浏览器：同样只发 browser 这一个键（不碰 allowNetwork / allowedApps） */
export function browserPatch(browser: ComputerUseBrowser): Pick<SettingsPatch, "computerUse"> {
  return { computerUse: { browser } };
}

/**
 * 隔离后端（L2 Window沙箱 / L2b 多会话隔离）的当前值。缺席 = 缺省（wsb）：
 * P2 是可选升级，不是默认路径。
 */
export function backendChoice(settings: AppSettings): ComputerUseBackend {
  return settings.computerUse?.backend ?? COMPUTER_USE_DEFAULT_BACKEND;
}

/** 换后端：只发 backend 一个键。**改完不自动重启**：正在跑的会话按它启动时的档位继续，
 *  设置页那一行常驻说明这件事（与出网开关同一条纪律）。 */
export function backendPatch(backend: ComputerUseBackend): Pick<SettingsPatch, "computerUse"> {
  return { computerUse: { backend } };
}

/** 设置页要画的一档后端 */
export interface BackendOptionView {
  id: ComputerUseBackend;
  /** 开发者后端（实验）：UI 用文字 / 图标标出来，不靠颜色 */
  experimental: boolean;
  /**
   * 已存但不在主进程给的可选列表里（开发者开关关着）。**照样画出来、保持选中、不可点**：
   * 静默把用户存的 qemu 改回 wsb 是在改写他的设置，而且下一次开开关时他又要重选一次。
   */
  locked: boolean;
}

export interface BackendChoicesView {
  options: readonly BackendOptionView[];
  /**
   * 存的是开发者后端、但开关没开：**保留选中态 + 在行下画一行警示 + 启动置灰**。
   * 主进程那边同样会拒（runtime.start 的第一道门），这里只是不让用户无谓地试。
   */
  devBlocked: boolean;
}

/**
 * 主进程给的可选列表 + 已存值 → 设置页要画的形态（纯函数，单测直接验三种状态）。
 *
 * 三态：
 *   开关开（列表含 qemu）           → 三档，qemu 标实验，可以点；
 *   开关关（列表两档）+ 存的是 wsb / isolation-session → 两档；
 *   开关关 + 存的是 qemu             → 两档 + 一个锁住的 qemu（选中），devBlocked = true。
 */
export function backendChoicesView(
  saved: ComputerUseBackend,
  choices: readonly ComputerUseBackendChoice[],
): BackendChoicesView {
  const options: BackendOptionView[] = choices.map((choice) => ({ ...choice, locked: false }));
  if (!choices.some((choice) => choice.id === saved)) {
    // 只有 qemu 会被门挡住；它的能力与开关都写在 shared 的声明里，不在这里按名字猜别的后端
    options.push({ id: saved, experimental: true, locked: true });
  }
  return { options, devBlocked: options.some((option) => option.id === saved && option.locked) };
}

/**
 * 选项 → 芯片文字。浏览器名是专有名词，不翻译（翻成「边缘」只会更难认）；
 * 只有 auto 是行为而不是名字，交回 i18n。
 */
export function browserLabel(choice: ComputerUseBrowser, autoLabel: string): string {
  if (choice === "edge") return "Edge";
  if (choice === "chrome") return "Chrome";
  if (choice === "brave") return "Brave";
  if (choice === "chromium") return "Chromium";
  return autoLabel;
}

export type ProbeVisual = { kind: "ready" } | { kind: "not-ready"; guidance: string[] };

/**
 * 探测结果 → 展示形态。guidance 是主进程给好的人话（一条一行），按行拆开、丢空行；
 * 就绪时 guidance 恒为 null，不就绪而 guidance 又空（理论外）就只剩未就绪的标题行。
 */
export function probeVisual(result: ComputerUseProbeResult): ProbeVisual {
  if (result.ready) return { kind: "ready" };
  const guidance = (result.guidance ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return { kind: "not-ready", guidance };
}

/**
 * 探测结果说平台不对 → 「启动」没有意义：主进程 start() 同样会拒（先报平台那条）。
 * 探测还没做过（null）不拦——状态机 / 主进程自己会兜底，别把首次进入页面就置灰当成默认。
 */
export function probeBlocksStart(result: ComputerUseProbeResult | null): boolean {
  return result !== null && result.platformOk === false;
}

export type ShotView =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ok"; src: string; width: number; height: number; takenAt: number }
  | { kind: "failed"; message: string };

/** 截图回执 → 展示形态：成功带 data URL 与元信息；失败只留主进程给的原因原话。 */
export function shotFromResult(result: ComputerUseScreenshotResult): ShotView {
  if (result.ok) {
    return {
      kind: "ok",
      src: `data:${result.mime ?? "image/jpeg"};base64,${result.jpegBase64}`,
      width: result.nativeWidth,
      height: result.nativeHeight,
      takenAt: result.takenAt,
    };
  }
  return { kind: "failed", message: result.error };
}

/** 截图元信息（机器事实）：原始桌面尺寸 + 拍摄时间。mono 字形由组件的样式管。 */
export function shotMeta(width: number, height: number, takenAt: number, t: Messages): string {
  return `${width} × ${height} · ${t.time.dateTime(takenAt)}`;
}
