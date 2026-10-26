/**
 * 让 agent 进程里的 pi 认得出自己是哪个版本。**纯模块**（不 import electron），可被 `node --test` 直接加载。
 *
 * 根因（2026-10-24 实测）：electron-vite 把 pi 打进 out/main/chunks 之后，pi 的 config.js 从
 * bundle 所在目录往上找 package.json，找到的是 **Orbita 自己的**（0.1.x），于是 pi 的 VERSION
 * 成了 Orbita 的版本号。别处无所谓，但 pi.dev 的目录接口按 User-Agent 里的版本分发
 * （`pi/0.1.16` → 307 到 `?pi-version=0.1.16` → 404），pi 把 404 记成「这家没有远端目录」，
 * 4 小时内不再试——目录联网刷新在真应用里一份也拉不到（单测与裸 node 里都好好的）。
 *
 * 修法用 pi 自己留的口子 `PI_PACKAGE_DIR`：指到一个放着 pi 真 package.json 的目录。
 * 开发版就是 node_modules 里那份；打包版由 electron-builder 的 extraResources 拷一份 package.json
 * 进 resources/pi-coding-agent（package.json 的 build 配置，测试守着两边的路径一致）。
 */
import { join } from "node:path";

/** pi 读版本用的环境变量（pi-coding-agent config.js 的 getPackageDir） */
export const PI_PACKAGE_DIR_ENV = "PI_PACKAGE_DIR";

/** 打包版 resources 下放 pi package.json 的子目录名 */
export const PACKAGED_PI_DIR = "pi-coding-agent";

export function piPackageDir(input: { packaged: boolean; resourcesPath: string; appPath: string }): string {
  return input.packaged
    ? join(input.resourcesPath, PACKAGED_PI_DIR)
    : join(input.appPath, "node_modules", "@earendil-works", "pi-coding-agent");
}
