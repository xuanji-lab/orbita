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
  type ComputerUseProbeResult,
  type ComputerUseScreenshotResult,
  type SandboxState,
} from "../../../../shared/computer-use.ts";
import type { AppSettings, SettingsPatch } from "../../../../shared/settings.ts";

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
 * 点一下开关要发的补丁。子对象整块回写（它目前只有这一项），
 * 不走 `{ allowNetwork }` 以外的推导——渲染层不替下一个人猜字段。
 */
export function allowNetworkPatch(enabled: boolean): Pick<SettingsPatch, "computerUse"> {
  return { computerUse: { allowNetwork: enabled } };
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
      src: `data:image/jpeg;base64,${result.jpegBase64}`,
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
