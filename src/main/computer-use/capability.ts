/**
 * computer use 能力探测 —— 全部只读，绝不自动执行提权命令。
 *
 * 六件事：
 *   1. reg query 读 EditionID，判版本档位（沙箱仅 Pro / Enterprise / Education，Home 没有）；
 *   2. 查 WindowsSandbox.exe 在不在 System32——它是「沙箱功能已启用」的非提权信号：
 *      功能启用时这个 exe 才出现，没启用就不在；
 *   3. 读 Win32_ComputerSystem 的 HypervisorPresent——BIOS/UEFI 关了虚拟化的机器
 *      功能与 exe 都对、一跑就退，这一项让探测提前拦住它（审查意见 B）；
 *   4. 查 wsl.exe 在不在、`wsl -l -v` 跑不跑得动。**WSL2 不是隔离档**（所有发行版共享
 *      同一个 utility VM），它只是这台机器虚拟化能力的一条旁证；
 *   5. 汇总成一个**隔离档位**（isolationTier）：能起沙箱就是 L2，否则 L1（内置浏览器那条
 *      车道所有平台都有）。到不了更高档的原因就是 guidance 里那几条；
 *   6. 以上全部的汇总：ready + 给用户看的手动开启指引（guidance）。
 *
 * 平台文案：非 Windows 分两种说法（macOS 用户要拿到「那我今天能用什么」的出路），
 * 两份文案都从 platformGuidance() 出——沙箱控制器的 start() 拒绝时读同一份，别分叉。
 *
 * 为什么不能查「可选功能状态」本身：DISM / Get-WindowsOptionalFeature 都需要管理员权限
 * （非提权跑 DISM 直接吃错误 740「需要提升权限才能运行 DISM」，2026-10-10 实测），
 * Orbita 以普通权限运行，这条路永远返回 unknown——所以删掉了 dism 探测，别加回来。
 *
 * 功能未启用时只报告 + 给手动开启指引文案（guidance），由用户自己去
 * 「启用或关闭 Windows 功能」勾选——Orbita 不代跑 dism /Enable-Feature 这类提权命令。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";
import type {
  ComputerUseProbeResult,
  HypervisorState,
  IsolationTier,
  SandboxFeatureState,
  WindowsEdition,
  WslState,
} from "../../shared/computer-use.ts";

const execFileP = promisify(execFile);

/** 探测命令的执行器。抽出来是为了测试注入 fixtures（不真跑 reg / powershell）。 */
export type RunCommand = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * 探测命令的超时（默认 run 注入）。这几条命令都是瞬时的（reg 与 CIM 查询都在百毫秒级，
 * `wsl -l -v` 冷启动偶发几秒），5 秒没回来说明环境卡住了——宁可当 unknown，
 * 不能让设置页的「检测能力」一直转。三条命令并行发，探测的最坏总时长也是这一条。
 */
export const PROBE_COMMAND_TIMEOUT_MS = 5_000;

const EDITION_REG_PATH = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";

/** WindowsSandbox.exe 的绝对路径（SystemRoot 可注入，测试里不用真环境变量）。
 * 用 win32.join：SystemRoot 是 Windows 侧路径，macOS/Linux 开发机上 host join 会拼出
 * `C:\Windows/System32/...` 这种混合分隔符——真机只在 Windows 上跑，但测试在任何平台都要过。 */
export function windowsSandboxExePath(systemRoot: string = process.env.SystemRoot ?? "C:\\Windows"): string {
  return win32.join(systemRoot, "System32", "WindowsSandbox.exe");
}

/** wsl.exe 的绝对路径（System32 下的系统件，Win10 2004+ 自带；同 windowsSandboxExePath 用 win32.join） */
export function windowsWslExePath(systemRoot: string = process.env.SystemRoot ?? "C:\\Windows"): string {
  return win32.join(systemRoot, "System32", "wsl.exe");
}

/**
 * WSL 的探测参数。**只看退出码，不解析输出**：`wsl -l -v` 在不少版本上吐 UTF-16LE，
 * 按 utf8 读进来是一串夹空字节的名字——拿它判「有没有 Version 2 的发行版」会误判。
 * 能跑起来（退出码 0）= WSL 子系统在这个账号下可用，这已经是这条旁证要的全部信息。
 * 没有发行版时它会以非 0 退出，那种情况归 unknown（「没装发行版」不是「没有 WSL」）。
 */
export const WSL_PROBE_ARGS = ["-l", "-v"] as const;

/**
 * 从 reg query 输出里抠 EditionID。真实输出长这样：
 *   HKEY_LOCAL_MACHINE\SOFTWARE\...\CurrentVersion
 *       EditionID    REG_SZ    Professional
 */
export function parseRegEditionId(stdout: string): string | null {
  const match = /EditionID\s+REG_SZ\s+(\S+)/.exec(stdout);
  return match?.[1] ?? null;
}

/** EditionID → 版本档位。前缀归组：Professional 系是 Pro，Core、Cloud 系是 Home，其余 unknown。 */
export function editionToSku(editionId: string | null): WindowsEdition {
  if (editionId === null) return "unknown";
  const id = editionId.toLowerCase();
  if (id.startsWith("professional")) return "pro";
  // includes 而非 startsWith：IoTEnterprise 这类带前缀的变体也算 enterprise 档
  if (id.includes("enterprise")) return "enterprise";
  if (id.startsWith("education")) return "education";
  if (id.startsWith("core") || id.startsWith("cloud")) return "home";
  return "unknown";
}

/**
 * 「Windows 沙箱」可选功能的状态，由 WindowsSandbox.exe 存在性推导：
 * 在 → enabled，不在 → disabled（功能没启用 / 载荷被移除都是这个结果）。
 * 「unknown」保留给契约兼容（shared/computer-use.ts），当前实现不再产出——
 * 非提权进程查不了功能状态真值（DISM 错误 740），exe 存在性是能拿到的最好信号。
 */
export function featureStateFromExe(sandboxExeFound: boolean): SandboxFeatureState {
  return sandboxExeFound ? "enabled" : "disabled";
}

/**
 * 虚拟化在不在：读 Win32_ComputerSystem 的 HypervisorPresent。
 * 真机输出是 `True` / `False`（PowerShell 把布尔打印成这两个词），大小写不敏感。
 * 认不出的输出、非 0 退出、PowerShell 不在、超时——全归 unknown（不阻塞，见契约里
 * HypervisorState 的注释）。
 *
 * **不用 wmic**：24H2 起它是可选移除的功能（Win11 25H2 上已默认不在），而
 * Get-CimInstance 是 PowerShell 自带的。
 */
export function parseHypervisorPresent(stdout: string): HypervisorState {
  const text = stdout.trim().toLowerCase();
  if (text === "true") return "present";
  if (text === "false") return "absent";
  return "unknown";
}

/** 虚拟化查询的命令行（导出让测试认这一条，别在测试里另写一份） */
export const HYPERVISOR_PROBE_ARGS = [
  "-NoProfile",
  "-NonInteractive",
  "-Command",
  "(Get-CimInstance Win32_ComputerSystem).HypervisorPresent",
] as const;

/**
 * 非 Windows 平台的说法（probe 的 guidance 与 SandboxController.start() 的拒绝文案共用）。
 *
 * macOS 那条必须给出路：只说「只在 Windows 上可用」，macOS 用户会以为整个电脑使用都没法用。
 * 真正能用的是**内置浏览器**那条车道（browser_*，Electron 的 WebContentsView，跑在宿主上，
 * 与操作系统的虚拟化无关）；而 sandbox_* / computer_* 走的是 Windows 沙箱里的 guest 桥，
 * macOS 上根本没有那个桥。所以文案分两半说，不把 L1 写成 sandbox_*。
 *
 * 平台不是 win32 时**只给这一条**：reg / powershell 都没跑，再说「读不到版本档位」只会稀释信号。
 */
export function platformGuidance(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return (
      "Windows 沙箱用不上 macOS——这是 Windows 自己的功能，不是 Orbita 还没做。" +
      "macOS 上能用的是浏览器档：内置浏览器里的 browser_navigate / browser_observe / browser_click 等工具不受影响，网页任务照做；" +
      "沙箱里的像素操作与沙箱浏览器（computer_* / sandbox_*）要等路线图上的 Linux 微虚拟机（L3）。"
    );
  }
  return "电脑使用沙箱只在 Windows 上提供（且需要专业版 / 企业版 / 教育版）；当前平台用不了这些工具。";
}

/**
 * 启用 Windows 沙箱的代价：它会同时打开 Hyper-V 平台，而微软自己写明 Hyper-V 与第三方
 * 虚拟机不兼容——这台机器上已有的 VMware / VirtualBox 虚拟机可能起不来或明显变慢。
 * 用户点「去启用沙箱」时没人告诉他这件事，就是产品级事故（2026-10 产品裁决）。
 *
 * 同一句话在 `build/installer.nsh` 的安装提示里还有一份：那是 NSIS，读不到这段 TS。
 * 两边改一处就要改另一处（改字时搜「Hyper-V」）。
 */
const HYPERVISOR_CONFLICT_NOTE =
  "注意：启用 Windows 沙箱会同时打开 Hyper-V 平台。微软明确说明它与第三方虚拟机不兼容——" +
  "这台机器上已有的 VMware / VirtualBox 虚拟机可能起不来或明显变慢（新版本可以用兼容模式，但仍会变慢）。" +
  "还要用它们的话，先在别的机器上启用沙箱，或者做好取舍。";

function buildGuidance(result: {
  platform: NodeJS.Platform;
  platformOk: boolean;
  edition: WindowsEdition;
  sandboxExeFound: boolean;
  hypervisorState: HypervisorState;
}): string {
  const lines: string[] = [];
  if (!result.platformOk) {
    // 非 Windows 上 reg / powershell 都没跑：只给平台这一条（见 platformGuidance 的注释）
    return platformGuidance(result.platform);
  }
  if (result.edition === "home") {
    lines.push("Windows 家庭版没有 Windows 沙箱功能，需要专业版 / 企业版 / 教育版。");
  } else if (result.edition === "unknown") {
    // reg query 真的跑过才报「读不到」；非 Windows 上根本没跑，报这条只会稀释平台那一条
    lines.push("读不到 Windows 版本档位（reg query 失败），无法确认沙箱可用。");
  }
  // 版本档位不是 Home 才有「去开功能」的意义；家庭版开不了，别误导
  if (!result.sandboxExeFound && result.edition !== "home") {
    lines.push(
      "Windows 沙箱功能未启用（System32 下找不到 WindowsSandbox.exe）。手动开启：Win+R 输入 optionalfeatures.exe 回车 → " +
        "勾选「Windows 沙箱」→ 确定 → 重启；或在管理员 PowerShell 运行：" +
        'Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All。' +
        "Orbita 不会替你执行这条提权命令。",
    );
    // 紧跟在「去启用」后面：用户读完就会去做，代价必须在他动手之前说
    lines.push(HYPERVISOR_CONFLICT_NOTE);
  }
  if (result.hypervisorState === "absent") {
    lines.push(
      "这台机器的虚拟化（VT-x / AMD-V）在 BIOS/UEFI 里被关了，Windows 沙箱起不来。" +
        "重启进 BIOS/UEFI → 打开虚拟化（各厂商名字不同：Intel Virtualization Technology / VT-x、AMD-V / SVM Mode）→ 保存重启后回来重试。" +
        "（Windows 里也可确认：任务管理器 › 性能 › CPU 的「虚拟化」应为「已启用」。）",
    );
  }
  return lines.join("\n");
}

export interface ProbeDeps {
  /** 默认 process.platform */
  platform?: NodeJS.Platform;
  /** 默认 execFile（utf8 + windowsHide，不让探测命令在任务栏闪黑框） */
  run?: RunCommand;
  /** 默认 existsSync */
  exeExists?: (path: string) => boolean;
  /** 默认 %SystemRoot%，测试可注入 */
  systemRoot?: string;
}

/** 能力探测：五项全只读，任何一查失败都按「unknown / 未找到」处理并给指引，绝不抛。
 *
 * 三条命令（reg / powershell / wsl）互不依赖，**并行发**：串行时最坏 3×5s，设置页的
 * 「检测中」会转 15 秒。它们各自在内部 catch，任何一条失败都不会拖垮另外两条。 */
export async function probe(deps: ProbeDeps = {}): Promise<ComputerUseProbeResult> {
  const platform = deps.platform ?? process.platform;
  const run =
    deps.run ??
    ((command: string, args: string[]) =>
      execFileP(command, args, { encoding: "utf8", windowsHide: true, timeout: PROBE_COMMAND_TIMEOUT_MS }));
  const exeExists = deps.exeExists ?? existsSync;
  const platformOk = platform === "win32";

  // 功能状态不走 DISM（非提权必失败，错误 740）：exe 在不在是唯一可靠的非提权信号
  const sandboxExeFound = platformOk && exeExists(windowsSandboxExePath(deps.systemRoot));
  const wslExeFound = platformOk && exeExists(windowsWslExePath(deps.systemRoot));

  /** 版本档位：reg 失败 → unknown（不判死，也不当成 Home） */
  const probeEdition = async (): Promise<WindowsEdition> => {
    if (!platformOk) return "unknown";
    try {
      const output = await run("reg", ["query", EDITION_REG_PATH, "/v", "EditionID"]);
      return editionToSku(parseRegEditionId(output.stdout));
    } catch {
      return "unknown";
    }
  };

  /** 虚拟化：PowerShell 不在 / 被策略拦 / 超时 → unknown（少一条信号，不当成「虚拟化被关」） */
  const probeHypervisor = async (): Promise<HypervisorState> => {
    if (!platformOk) return "unknown";
    try {
      const output = await run("powershell", [...HYPERVISOR_PROBE_ARGS]);
      return parseHypervisorPresent(output.stdout);
    } catch {
      return "unknown";
    }
  };

  /** WSL2：exe 不在 → unavailable；在但 `wsl -l -v` 没跑成 → unknown（见 WSL_PROBE_ARGS） */
  const probeWsl = async (): Promise<WslState> => {
    if (!wslExeFound) return "unavailable";
    try {
      await run("wsl", [...WSL_PROBE_ARGS]);
      return "available";
    } catch {
      return "unknown";
    }
  };

  const [edition, hypervisorState, wsl2] = await Promise.all([probeEdition(), probeHypervisor(), probeWsl()]);

  const featureState = featureStateFromExe(sandboxExeFound);
  const editionOk = edition === "pro" || edition === "enterprise" || edition === "education";
  // unknown 不拦（见 HypervisorState 的注释）；只有明确 absent 才判不就绪
  const ready = platformOk && editionOk && sandboxExeFound && hypervisorState !== "absent";
  // 浏览器档（内置浏览器 + browser_*）在哪个平台都有，所以下限恒为 l1；
  // 只有沙箱真能起来才算到 L2（wsl2 **不参与**——它不是隔离边界）
  const isolationTier: IsolationTier = ready ? "l2" : "l1";
  const facts = { platform, platformOk, edition, sandboxExeFound, hypervisorState };
  return {
    platformOk,
    edition,
    editionOk,
    featureState,
    sandboxExeFound,
    hypervisorState,
    isolationTier,
    wsl2,
    ready,
    guidance: ready ? null : buildGuidance(facts),
  };
}
