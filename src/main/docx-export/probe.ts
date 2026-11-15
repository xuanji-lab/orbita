/**
 * pandoc 探测 —— 本机装没装、装在哪、版本够不够。
 *
 * 版本要求不是「最好新一点」：**3.10.2 修了 `\tag`**（公式编号），更早的 pandoc
 * 会把 `\tag` 转错 / 转丢。低版本在这里直接判 supported:false，由设置页与工具
 * 给出升级路径——**不静默降级**（静默降级的产物是一份编号全错的论文）。
 *
 * 探测顺序与 latex 的 probe 同一条纪律：显式路径（设置）→ PATH → 常见安装根。
 * 验活只有一个判据：`pandoc --version` 退出码 0 且第一行解得出三段号。
 * 结果按显式路径分键缓存（一次导出会探两次：开编前与设置页）。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { posix, win32 } from "node:path";
import {
  DOCX_EXPORT_MIN_PANDOC,
  DOCX_EXPORT_RECOMMENDED_PANDOC,
  formatPandocVersion,
  isPandocSupported,
  parsePandocVersion,
  type PandocProbeResult,
  type PandocVersion,
} from "../../shared/docx-export.ts";

/** `pandoc --version` 的上限。pandoc 是原生二进制，本机实测 < 100 ms */
const VERSION_TIMEOUT_MS = 3000;

export interface PandocProbeDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  /** 跑 `<command> --version`：退出码 0 回 stdout，否则 null */
  version(command: string): Promise<string | null>;
}

export interface PandocProbe {
  probe(explicit?: string): Promise<PandocProbeResult>;
  /**
   * 只验这一条路径，**不回退**到 PATH。设置页「选择 / 手填路径」用它：
   * 选到一个坏文件时报「这条路径跑不起 pandoc」，而不是悄悄拿 PATH 上那份顶包。
   * 路径不存在 / `--version` 非 0 / 版本解不出都回 null。
   */
  probeExact(path: string): Promise<PandocProbeResult | null>;
  refresh(): void;
}

export function createPandocProbe(deps: PandocProbeDeps = realDeps()): PandocProbe {
  const cache = new Map<string, PandocProbeResult>();
  const exact = new Map<string, PandocProbeResult | null>();
  return {
    async probe(explicit?: string): Promise<PandocProbeResult> {
      const key = explicit?.trim() ?? "";
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const result = await probeOnce(deps, explicit);
      cache.set(key, result);
      return result;
    },
    async probeExact(path: string): Promise<PandocProbeResult | null> {
      const command = path.trim();
      if (command === "" || !deps.exists(command)) return null;
      if (exact.has(command)) return exact.get(command) ?? null;
      const output = await deps.version(command);
      const version = output === null ? null : parsePandocVersion(output);
      const result = version === null ? null : found(command, version, []);
      exact.set(command, result);
      return result;
    },
    refresh(): void {
      cache.clear();
      exact.clear();
    },
  };
}

function realDeps(): PandocProbeDeps {
  return {
    platform: process.platform,
    env: process.env,
    exists: (path) => existsSync(path),
    version: (command) =>
      new Promise((resolve) => {
        execFile(
          command,
          ["--version"],
          { timeout: VERSION_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 },
          (error, stdout) => resolve(error === null ? String(stdout) : null),
        );
      }),
  };
}

/** 平台对应的路径算法：探测做的全是平台相关路径，测试要能在任何宿主上跑 mac / linux 分支 */
function pathApi(platform: NodeJS.Platform) {
  return platform === "win32" ? win32 : posix;
}

function executableNames(platform: NodeJS.Platform): string[] {
  return platform === "win32" ? ["pandoc.exe", "pandoc"] : ["pandoc"];
}

function pathDirs(deps: PandocProbeDeps): string[] {
  const raw = deps.env["PATH"] ?? deps.env["Path"] ?? "";
  return raw
    .split(deps.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry !== "");
}

/**
 * 常见安装根。Order matters only for the message; PATH is tried first either way.
 * Windows：官方 MSI 装到 `C:\Program Files\Pandoc`，用户级（scoop/winget 的便携包）
 * 常见 `%LOCALAPPDATA%\Pandoc`。macOS：Homebrew 两处 + pkg 安装的 /usr/local/bin。
 */
function commonRoots(deps: PandocProbeDeps): string[] {
  const join = pathApi(deps.platform).join;
  if (deps.platform === "win32") {
    const dirs = [
      deps.env["ProgramFiles"] === undefined ? undefined : join(deps.env["ProgramFiles"], "Pandoc"),
      deps.env["ProgramW6432"] === undefined ? undefined : join(deps.env["ProgramW6432"], "Pandoc"),
      deps.env["ProgramFiles(x86)"] === undefined ? undefined : join(deps.env["ProgramFiles(x86)"], "Pandoc"),
      deps.env["LOCALAPPDATA"] === undefined ? undefined : join(deps.env["LOCALAPPDATA"], "Pandoc"),
      deps.env["APPDATA"] === undefined ? undefined : join(deps.env["APPDATA"], "Pandoc"),
    ].filter((dir): dir is string => dir !== undefined && dir.trim() !== "");
    return [...new Set(dirs)];
  }
  if (deps.platform === "darwin") {
    return ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/Applications/pandoc.app/Contents/MacOS"];
  }
  const home = deps.env["HOME"];
  return [
    "/usr/local/bin",
    "/usr/bin",
    "/snap/bin",
    ...(home === undefined || home === "" ? [] : [join(home, ".local/bin"), join(home, "bin")]),
  ];
}

function firstExisting(deps: PandocProbeDeps, dir: string, names: readonly string[]): string | null {
  const join = pathApi(deps.platform).join;
  for (const name of names) {
    const candidate = join(dir, name);
    if (deps.exists(candidate)) return candidate;
  }
  return null;
}

async function probeOnce(deps: PandocProbeDeps, explicit: string | undefined): Promise<PandocProbeResult> {
  const searched: string[] = [];
  const names = executableNames(deps.platform);
  const dirs = [...pathDirs(deps), ...commonRoots(deps)];

  const tryCommand = async (command: string): Promise<PandocProbeResult | null> => {
    const output = await deps.version(command);
    if (output === null) return null;
    const version = parsePandocVersion(output);
    if (version === null) return null;
    return found(command, version, searched);
  };

  if (explicit !== undefined && explicit.trim() !== "") {
    const candidate = explicit.trim();
    if (deps.exists(candidate)) {
      const result = await tryCommand(candidate);
      if (result !== null) return result;
    }
    console.warn(`[docx-export] 设置里的 pandoc 路径不可用：${candidate}，改从 PATH 与常见安装位置找`);
  }

  for (const dir of pathDirs(deps)) {
    searched.push(dir);
    const candidate = firstExisting(deps, dir, names);
    if (candidate === null) continue;
    const result = await tryCommand(candidate);
    if (result !== null) return result;
  }

  for (const dir of commonRoots(deps)) {
    searched.push(dir);
    const candidate = firstExisting(deps, dir, names);
    if (candidate === null) continue;
    const result = await tryCommand(candidate);
    if (result !== null) return result;
  }

  return {
    ok: false,
    path: null,
    version: null,
    versionText: null,
    supported: false,
    minVersion: DOCX_EXPORT_MIN_PANDOC,
    recommendedVersion: DOCX_EXPORT_RECOMMENDED_PANDOC,
    message:
      `pandoc was not found. Word export needs pandoc ${DOCX_EXPORT_MIN_PANDOC} or newer ` +
      `(recommended ${DOCX_EXPORT_RECOMMENDED_PANDOC}). Install it from https://pandoc.org/installing.html, ` +
      "then run the export again.",
    searched: [...new Set(searched)],
  };
}

function found(command: string, version: PandocVersion, searched: string[]): PandocProbeResult {
  const versionText = formatPandocVersion(version);
  const supported = isPandocSupported(version);
  return {
    ok: true,
    path: command,
    version,
    versionText,
    supported,
    minVersion: DOCX_EXPORT_MIN_PANDOC,
    recommendedVersion: DOCX_EXPORT_RECOMMENDED_PANDOC,
    message: supported
      ? `pandoc ${versionText} at ${command}`
      : `pandoc ${versionText} at ${command} is too old: Word export needs ${DOCX_EXPORT_MIN_PANDOC} or newer ` +
        `(${DOCX_EXPORT_RECOMMENDED_PANDOC} recommended). The older release converts \\tag wrongly, so equation ` +
        "numbering would be broken. Upgrade pandoc (https://pandoc.org/installing.html) and retry.",
    searched: [...new Set(searched)],
  };
}
