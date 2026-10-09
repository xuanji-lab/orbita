/**
 * computer use 能力探测 —— 全部只读，绝不自动执行提权命令。
 *
 * 三件事：
 *   1. reg query 读 EditionID，判版本档位（沙箱仅 Pro / Enterprise / Education，Home 没有）；
 *   2. dism /English 查「Windows 沙箱」可选功能（Containers-DisposableClientVM）状态——
 *      /English 是为了绕开输出本地化（中文系统上 State 是「已启用」，没法稳定解析）；
 *   3. 检查 WindowsSandbox.exe 在不在 System32。
 *
 * 功能未启用时只报告 + 给手动开启指引文案（guidance），由用户自己去
 * 「启用或关闭 Windows 功能」勾选——Orbita 不代跑 dism /Enable-Feature 这类提权命令。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ComputerUseProbeResult, SandboxFeatureState, WindowsEdition } from "../../shared/computer-use.ts";

const execFileP = promisify(execFile);

/** 探测命令的执行器。抽出来是为了测试注入 fixtures（不真跑 reg / dism）。 */
export type RunCommand = (command: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

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
 * 从 dism /Get-FeatureInfo /English 的输出里抠功能状态。取「State :」那一行：
 *   Enabled / Enabled with Payload Removed → enabled（都算可用）
 *   Disabled / Disabled with Payload Removed → disabled
 * 没有这一行（本地化输出、命令失败）→ unknown，宁可如实说查不到。
 */
export function parseDismState(stdout: string): SandboxFeatureState {
  const match = /^\s*State\s*:\s*(.+)$/im.exec(stdout);
  if (!match) return "unknown";
  const value = match[1]?.trim().toLowerCase() ?? "";
  if (value.startsWith("enabled")) return "enabled";
  if (value.startsWith("disabled")) return "disabled";
  return "unknown";
}

function buildGuidance(result: {
  platformOk: boolean;
  edition: WindowsEdition;
  editionOk: boolean;
  featureState: SandboxFeatureState;
  sandboxExeFound: boolean;
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
  if (result.featureState === "disabled") {
    lines.push(
      "Windows 沙箱功能未启用。手动开启：控制面板 → 程序 → 启用或关闭 Windows 功能 → 勾选「Windows 沙箱」，按提示重启；" +
        '或在管理员 PowerShell 运行：Enable-WindowsOptionalFeature -Online -FeatureName "Containers-DisposableClientVM" -All。' +
        "Orbita 不会替你执行这条提权命令。",
    );
  } else if (result.featureState === "unknown") {
    lines.push("查不到 Windows 沙箱功能的状态，可以打开「启用或关闭 Windows 功能」人工确认。");
  }
  if (!result.sandboxExeFound) {
    lines.push(`找不到 ${windowsSandboxExePath()}——沙箱功能可能没有装全。`);
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

/** 能力探测：并行三查全只读，任何一查失败都按「unknown / 未找到」处理并给指引，绝不抛。 */
export async function probe(deps: ProbeDeps = {}): Promise<ComputerUseProbeResult> {
  const platform = deps.platform ?? process.platform;
  const run =
    deps.run ?? ((command: string, args: string[]) => execFileP(command, args, { encoding: "utf8", windowsHide: true }));
  const exeExists = deps.exeExists ?? existsSync;
  const platformOk = platform === "win32";

  let edition: WindowsEdition = "unknown";
  let featureState: SandboxFeatureState = "unknown";
  if (platformOk) {
    try {
      const output = await run("reg", ["query", EDITION_REG_PATH, "/v", "EditionID"]);
      edition = editionToSku(parseRegEditionId(output.stdout));
    } catch {
      edition = "unknown";
    }
    try {
      // /English：固定输出英文，绕开中文系统上「State : 已启用」没法稳定解析的问题
      const output = await run("dism", [
        "/Online",
        "/Get-FeatureInfo",
        "/FeatureName:Containers-DisposableClientVM",
        "/English",
      ]);
      featureState = parseDismState(output.stdout);
    } catch {
      featureState = "unknown";
    }
  }

  const sandboxExeFound = platformOk && exeExists(windowsSandboxExePath(deps.systemRoot));
  const editionOk = edition === "pro" || edition === "enterprise" || edition === "education";
  const ready = platformOk && editionOk && featureState === "enabled" && sandboxExeFound;
  const partial = { platformOk, edition, editionOk, featureState, sandboxExeFound };
  return { ...partial, ready, guidance: ready ? null : buildGuidance(partial) };
}
