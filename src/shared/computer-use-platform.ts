/**
 * 电脑使用（computer use）能不能在这台机器上跑——**平台**这一个问题的唯一真源。
 *
 * 三个地方各读过各的信号（设置页、主进程开轮装配、agent 工具注册），平台这一项却谁都没问：
 * 设置页照样画「启动」，macOS 上点了必失败；模型照样拿着 computer_* / sandbox_*，
 * 拒绝文案又让它「去设置里启动」——一句永远做不到的建议，它只会反复重试。
 * 所以平台判定收敛到这里：纯函数、不读 process.platform（调用方传进来），两边共用一份。
 *
 * 为什么只有 Windows：电脑使用的每一档隔离都建在 Windows 宿主之上——
 * L2 是 Windows 沙箱（WSB），L2b 是 MXC 的 IsolationSession，L3 是 QEMU 的 Linux 桌面
 * （宿主侧仍是 Windows 的 WHPX 与 guest 桥）。macOS / Linux 上既没有那个 guest 桥，
 * 也没有可替代的隔离桌面；宿主浏览器那组工具（browser_*）不经过沙箱，不受这里影响。
 *
 * 这一层只回答「平台」，不回答「这台 Windows 上沙箱装没装、开没开、是不是家庭版」——
 * 那是 capability.ts 的 probe（要真去读注册表与 System32），别把两件事混成一个谓词。
 */
import type { ComputerUseTurnContext } from "./agent-ipc.ts";

/** 平台归档。只用于措辞与统计，判「能不能用」只看 supported。 */
export type ComputerUsePlatformKind = "windows" | "macos" | "linux" | "other";

/**
 * 不支持时该讲哪一种环境：与 `messages.computerUse.platform.body` 下的三条同名，
 * 设置页与拒绝文案按它取词（做成独立的联合而不是复用 kind，是为了让 Windows 永远
 * 取不到一条「不支持」的文案——kind 里含 windows，这里不含）。
 */
export type ComputerUsePlatformReason = "macos" | "linux" | "other";

export interface ComputerUsePlatformSupport {
  /** 只有 win32 为 true */
  supported: boolean;
  kind: ComputerUsePlatformKind;
  /** supported 时为 null；否则是 message.computerUse.platform.body 的键 */
  reasonKey: ComputerUsePlatformReason | null;
}

/** platform 是 process.platform 的原值（NodeJS.Platform，但这里收 string：renderer 也调它） */
export function computerUsePlatformKind(platform: string): ComputerUsePlatformKind {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "other";
}

/**
 * 电脑使用的平台支持。**认不出的平台一律不支持**（fail closed）：宁可少给一组工具，
 * 也不要在没验证过的系统上让模型去点一个不存在的沙箱。
 */
export function computerUsePlatformSupport(platform: string): ComputerUsePlatformSupport {
  const kind = computerUsePlatformKind(platform);
  if (kind === "windows") return { supported: true, kind, reasonKey: null };
  return { supported: false, kind, reasonKey: kind };
}

/**
 * 这一轮到底注不注册电脑使用工具组（computer_* + sandbox_*，它们操作的是同一个沙箱）。
 *
 * 两个条件**都**要成立：实验开关开着，且这台机器是 Windows。为什么平台也在这里判，
 * 而不是只靠主进程在 start 时拒绝：在 macOS / Linux 上拒绝文案只能给「去设置里启动沙箱」
 * ——一句永远做不到的建议，模型拿到之后只会换个说法反复重试。不给工具比给了再拒绝诚实
 * （同 cite_pdf 的纪律）。**缺席的 platformSupported 按不支持算**（fail closed：宁可少
 * 给一组工具，也不要在没平台支持的地方让模型去点一个不存在的沙箱）。
 *
 * runtime 有四处要问同一个问题（预算、提示词工具名单、两组工具注册），提示词里讲
 * 沙箱出网与动作预算的那两段也靠它——工具没注册却讲它们怎么用，同样是假话。
 */
export function computerUseToolsActive(computerUse: ComputerUseTurnContext | undefined): boolean {
  return computerUse?.enabled === true && computerUse.platformSupported === true;
}
