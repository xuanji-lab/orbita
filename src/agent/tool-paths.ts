/**
 * 内建工具（read / write / edit，pi-durable 自带的实现）怎么把模型给的路径变成绝对路径——Orbita 这边的一份**同口径**实现，
 * 外加 Windows 上 Git Bash 盘符写法的折算。
 *
 * 为什么要有：文件账（file-tracker.ts，回退 / 撤销按快照还原）与受保护路径闸门（permission.ts）必须与工具算出
 * **同一个**绝对路径——工具写 A、账记 B，回退就静默失效；闸门比 B、工具写 A，就漏拦。durable 的 path-utils 不在包的
 * 公开入口里，所以照它的规则在这里写一份，测试拿真的 durable 工具在 NodeExecutionEnv 上落盘，逐形态比对（tool-paths.test.ts）。
 *
 * 规则（durable 1.5.2 的 normalizeToolPath + NodeExecutionEnv.absolutePath）：
 * 1. 不间断空格等 Unicode 空格换成普通空格；去掉开头的 `@`；
 * 2. `~` → 家目录；`~/x`（Windows 上还有 `~\x`）→ 家目录下；`file://` URL → 本地路径（畸形 URL 原样当路径）；
 * 3. 绝对路径 `resolve` 规整，相对路径按 cwd 解析。
 *
 * **Windows 上的 Git Bash 写法**：模型在 bash（Git Bash）里看到的是 `/c/Users/…`，拿它去 read / write / edit 很常见。
 * durable 不认这种写法（当成当前盘下的 `\c\Users\…`，等于把文件工具弄坏），旧内核认。所以工具包装层（durable-tools.ts）
 * 在交给工具之前先折算（toolPathArgument），文件账与闸门用同一个 toolTargetPath——三处同一套。只在 win32 上折：
 * macOS / Linux 上 `/c` 可能就是一个真实存在的目录。
 */
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface ToolPathOptions {
  /** 默认 process.platform；测试注入 */
  platform?: NodeJS.Platform;
  /** 默认 os.homedir()；测试注入 */
  home?: string;
}

/** 第 1 步：模型常带的花样（不间断空格、`@` 前缀） */
export function normalizeToolPathText(path: string): string {
  const spaced = path.replace(UNICODE_SPACES, " ");
  return spaced.startsWith("@") ? spaced.slice(1) : spaced;
}

/**
 * Git Bash / MSYS / Cygwin / WSL 的盘符写法折成 Windows 原生路径（`/c/x`、`/mnt/c/x`、`/cygdrive/c/x` → `C:\x`）；
 * 不是这种写法原样返回。纯字符串变换，不看平台——调用方决定只在 win32 上用。
 */
export function msysDrivePath(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) return path;
  const match = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(path);
  if (match === null || match[1] === undefined) return path;
  return `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
}

/**
 * 交给内建工具之前的路径参数：win32 上是 Git Bash 盘符写法就折成盘符路径（顺带去掉 `@` 与怪空格，工具本来也会去），
 * 否则原样不动——工具自己的规整照旧做。
 */
export function toolPathArgument(path: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== "win32") return path;
  const normalized = normalizeToolPathText(path);
  const converted = msysDrivePath(normalized);
  return converted === normalized ? path : converted;
}

/** 内建工具实际落盘的绝对路径（包装层折算之后，与 durable 的 resolveToolPath 同口径） */
export function toolTargetPath(path: string, cwd: string, options: ToolPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const api = platform === "win32" ? win32 : posix;
  const home = options.home ?? homedir();
  let normalized = normalizeToolPathText(toolPathArgument(path, platform));
  if (normalized === "~") {
    normalized = home;
  } else if (normalized.startsWith("~/") || (platform === "win32" && normalized.startsWith("~\\"))) {
    normalized = api.join(home, normalized.slice(2));
  } else if (normalized.startsWith("file://")) {
    try {
      normalized = fileURLToPath(normalized, { windows: platform === "win32" });
    } catch {
      // 畸形 URL 原样当普通路径（durable 同样不抛）
    }
  }
  return api.isAbsolute(normalized) ? api.resolve(normalized) : api.resolve(cwd, normalized);
}
