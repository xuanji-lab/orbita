/**
 * 随包的 OfficeCLI 二进制落在哪。**纯模块**（不 import electron），`node --test` 直接加载。
 *
 * 与 rg / fd（search-bins.ts）同一套落点风格，但**不同目录**：rg / fd 在 `resources/bin`
 * （那个目录挂在 agent 进程 PATH 最前面），officecli 在它的子目录 `resources/bin/officecli`。
 * 理由：rg / fd 挂 PATH 是为了让 pi 的 grep / find 直接用；而 OfficeCLI 的命令面里有 `open`（起常驻
 * 服务）与 `install`（自更新）——它一旦也在 PATH 上，模型在 bash 里随手就能绕过我们
 * 「只用 batch、15 s 超时、禁 resident、禁自更新」的约束；而把二进制放进子目录，就等于把它从
 * PATH 可发现面里拿掉了（子目录不会被递归查找），只有拿到绝对路径才调得到它。
 *
 * 这个落点与 scripts/officecli-source.mjs 的 OFFICECLI_SUBDIR 必须一致（两边各自有测试盯着）。
 *
 * `ORBITA_OFFICECLI_PATH` 是**绝对路径**覆盖（不是目录、不进 PATH）：验收换版本、或临时指向
 * 一台机器上已有的二进制时用。没有 PATH 探测兜底——找不到就明确报错，不静默换实现。
 */
import { join } from "node:path";

/** 子目录名：与 scripts/officecli-source.mjs 的 OFFICECLI_SUBDIR 同一个值 */
const BIN_SUBDIR = "officecli";

/** 覆盖用的环境变量名：主进程把它写进 agent 进程环境，工具层读它 */
export const OFFICECLI_PATH_ENV = "ORBITA_OFFICECLI_PATH";

export function officecliBinPath(input: {
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
}): string {
  const exe = input.platform === "win32" ? "officecli.exe" : "officecli";
  return input.packaged
    ? join(input.resourcesPath, "bin", BIN_SUBDIR, exe)
    : join(input.appPath, "build", "bin", `${input.platform}-${input.arch}`, BIN_SUBDIR, exe);
}

/**
 * 最终用哪一份：环境变量优先（显式路径，且文件真在），否则打包 / 开发态的默认落点。
 * 返回 null = 没有可用的二进制（没跑过 fetch 脚本、或安装包坏了）。调用方据此报
 * 「Office 能力未就绪」，不要退化成 PATH 里随便哪个 officecli。
 */
export function resolveOfficecliPath(input: {
  env: Record<string, string | undefined>;
  exists: (path: string) => boolean;
  packaged: boolean;
  resourcesPath: string;
  appPath: string;
  platform: string;
  arch: string;
}): string | null {
  const override = input.env[OFFICECLI_PATH_ENV];
  if (override !== undefined && override.trim() !== "" && input.exists(override)) return override;
  const bundled = officecliBinPath(input);
  return input.exists(bundled) ? bundled : null;
}
