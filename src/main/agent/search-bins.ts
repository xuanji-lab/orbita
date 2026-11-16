/**
 * 随安装包分发的 rg / fd。**纯模块**（不 import electron），可被 `node --test` 直接加载。
 *
 * 为什么要分发：搜索走 bash（grep / find / ls 三个搜索工具 2026-11-16 删了），模型在 bash 里最常用的是
 * rg / fd——它们尊重 .gitignore、不递归进 node_modules。很多机器（尤其 Windows）没装，安装包带一份、
 * 挂到 agent 与内核进程 PATH 的最前面，bash 里就能直接用：不往用户目录拷文件。
 * （以前另一个理由是 pi 的 grep / find 工具依赖它们、没有就去 GitHub 下载，工具删了，这条不再成立。）
 *
 * 二进制不进 git：打包前由 scripts/fetch-search-bins.mjs 按钉死的版本与 sha256 下载到
 * build/bin/<platform>-<arch>/，electron-builder 再放进 resources/bin。
 */
import { join } from "node:path";

/** 打包版在 resources/bin；开发版用 fetch 脚本落在仓库里的那份（没跑过脚本就不存在，pi 照旧兜底） */
export function bundledBinDir(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
}): string {
  return input.packaged
    ? join(input.resourcesPath, "bin")
    : join(input.appPath, "build", "bin", `${input.platform}-${input.arch}`);
}

/**
 * agent 进程的环境：binDir 挂到 PATH 最前面（安装包里那份优先于系统里不知道哪个版本的 rg）。
 * Windows 的环境变量名不分大小写，常见的是 `Path`——拷贝出来的普通对象却分大小写，
 * 不按原名写回就会多出第二个 PATH 键，子进程拿到哪个看运气。
 */
export function agentEnv(base: Record<string, string | undefined>, binDir: string, platform: string): Record<string, string | undefined> {
  const delimiter = platform === "win32" ? ";" : ":";
  const key = (platform === "win32" ? Object.keys(base).find((name) => name.toUpperCase() === "PATH") : undefined) ?? "PATH";
  const current = base[key];
  return { ...base, [key]: current === undefined || current === "" ? binDir : `${binDir}${delimiter}${current}` };
}
