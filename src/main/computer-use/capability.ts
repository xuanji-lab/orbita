/**
 * computer use 能力探测 —— 全部只读，绝不自动执行提权命令。
 *
 * 四件事：
 *   1. reg query 读 EditionID，判版本档位（沙箱仅 Pro / Enterprise / Education，Home 没有）；
 *   2. 查 WindowsSandbox.exe 在不在 System32——它是「沙箱功能已启用」的非提权信号：
 *      功能启用时这个 exe 才出现，没启用就不在；
 *   3. 读 Win32_ComputerSystem 的 HypervisorPresent——BIOS/UEFI 关了虚拟化的机器
 *      功能与 exe 都对、一跑就退，这一项让探测提前拦住它（审查意见 B）；
 *   4. 以上三项的汇总：ready + 给用户看的手动开启指引。
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
import { join } from "node:path";
import { promisify } from "node:util";
import type {
  ComputerUseProbeResult,
  HypervisorState,
  SandboxFeatureState,
  WindowsEdition,
} from "../../shared/computer-use.ts";

const execFileP = promisify(execFile);

/** 探测命令的执行器。抽出来是为了测试注入 fixtures（不真跑 reg / powershell）。 */
export type RunCommand = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

/**
 * 探测命令的超时（默认 run 注入）。这两条命令都是瞬时的（reg 与 CIM 查询都在百毫秒级），
 * 5 秒没回来说明环境卡住了——宁可当 unknown，不能让设置页的「检测能力」一直转。
 */
export const PROBE_COMMAND_TIMEOUT_MS = 5_000;

const EDITION_REG_PATH = "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion";

/** WindowsSandbox.exe 的绝对路径（SystemRoot 可注入，测试里不用真环境变量）。 */
export function windowsSandboxExePath(systemRoot: string = process.env.SystemRoot ?? "C:\\Windows"): string {
  return join(systemRoot, "System32", "WindowsSandbox.exe");
}

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

function buildGuidance(result: {
  platformOk: boolean;
  edition: WindowsEdition;
  editionOk: boolean;
  sandboxExeFound: boolean;
  hypervisorState: HypervisorState;
}): string {
  const lines: string[] = [];
  if (!result.platformOk) {
    lines.push("电脑使用沙箱目前只在 Windows 上可用。");
  }
  if (result.edition === "home") {
    lines.push("Windows 家庭版没有 Windows 沙箱功能，需要专业版 / 企业版 / 教育版。");
  } else if (result.edition === "unknown") {
    lines.push("读不到 Windows 版本档位（reg query 失败），无法确认沙箱可用。");
  }
  // 版本档位不是 Home 才有「去开功能」的意义；家庭版开不了，别误导
  if (!result.sandboxExeFound && result.edition !== "home" && result.platformOk) {
    lines.push(
      "Windows 沙箱功能未启用（System32 下找不到 WindowsSandbox.exe）。手动开启：Win+R 输入 optionalfeatures.exe 回车 → " +
        "勾选「Windows 沙箱」→ 确定 → 重启；或在管理员 PowerShell 运行：" +
        'Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All。' +
        "Orbita 不会替你执行这条提权命令。",
    );
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

/** 能力探测：四项全只读，任何一查失败都按「unknown / 未找到」处理并给指引，绝不抛。 */
export async function probe(deps: ProbeDeps = {}): Promise<ComputerUseProbeResult> {
  const platform = deps.platform ?? process.platform;
  const run =
    deps.run ??
    ((command: string, args: string[]) =>
      execFileP(command, args, { encoding: "utf8", windowsHide: true, timeout: PROBE_COMMAND_TIMEOUT_MS }));
  const exeExists = deps.exeExists ?? existsSync;
  const platformOk = platform === "win32";

  let edition: WindowsEdition = "unknown";
  let hypervisorState: HypervisorState = "unknown";
  if (platformOk) {
    try {
      const output = await run("reg", ["query", EDITION_REG_PATH, "/v", "EditionID"]);
      edition = editionToSku(parseRegEditionId(output.stdout));
    } catch {
      edition = "unknown";
    }
    try {
      const output = await run("powershell", [...HYPERVISOR_PROBE_ARGS]);
      hypervisorState = parseHypervisorPresent(output.stdout);
    } catch {
      // PowerShell 不在 / 被策略拦 / 超时：少一条信号，不当成「虚拟化被关」（那会误杀能用的机器）
      hypervisorState = "unknown";
    }
  }

  // 功能状态不走 DISM（非提权必失败，错误 740）：exe 在不在是唯一可靠的非提权信号
  const sandboxExeFound = platformOk && exeExists(windowsSandboxExePath(deps.systemRoot));
  const featureState = featureStateFromExe(sandboxExeFound);
  const editionOk = edition === "pro" || edition === "enterprise" || edition === "education";
  // unknown 不拦（见 HypervisorState 的注释）；只有明确 absent 才判不就绪
  const ready = platformOk && editionOk && sandboxExeFound && hypervisorState !== "absent";
  const partial = { platformOk, edition, editionOk, sandboxExeFound, hypervisorState };
  return { ...partial, featureState, ready, guidance: ready ? null : buildGuidance(partial) };
}
