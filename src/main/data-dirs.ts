/**
 * 开发版与正式版各用各的数据。**纯模块**（不 import electron），可被 `node --test` 直接加载。
 *
 * 为什么要分（2026-09-23 自举裁决）：用 Orbita 开发 Orbita 时，正式版在跑真实会话，
 * 它里面的 agent 又会起一个开发版来测改动——两个进程同时写同一批会话 JSONL 与
 * settings.json。原子写只防「写到一半」，防不了两个进程互相覆盖。
 * 真实数据归正式版：它的路径一个字都不改，只有开发版挪走。
 *
 * 分两处：
 * - userData：Electron 按应用名算（`~/Library/Application Support/orbita`）。改 productName
 *   不管用——macOS 默认的 APFS 不分大小写，`Orbita` 与 `orbita` 是同一个目录。
 * - 工作区根：`~/Orbita` 是写死的（工作区文件夹与 Home 都在它下面），不跟 userData 走。
 *
 * 密钥：safeStorage 的钥匙串条目按应用名取，开发版与正式版同名，但 provider 列表本身
 * 在 userData 里——开发版第一次启动是空的，要在设置里重新填一次 key。
 */
import { basename, join } from "node:path";

/** 开发版的目录名。正式版是 `orbita` / `Orbita`（Electron 默认值与 WorkspaceStore 默认值），这里不重复定义 */
const DEV_USER_DATA = "orbita-dev";
const DEV_ORBITA_ROOT = "Orbita-dev";

/**
 * 开发版的两个数据根。**正式版返回 null**：正式版的路径不由这里决定，保持 Electron /
 * WorkspaceStore 的默认值——真实数据的位置不能因为这层逻辑的一个 bug 而漂走。
 *
 * 隔离实例：只分 userData 不分工作区根的话，两个进程还是写同一批会话文件，单实例锁
 * 就白分了（2026-10-03「一键隔离实例」）。两种给法，userData 与工作区根总是一起分：
 * - `ORBITA_DEV_INSTANCE=<名字>`（如 `ORBITA_DEV_INSTANCE=2 ORBITA_DEV_PORT=5274 bun run dev`）：orbita-dev-<名字> 与
 *   ~/Orbita-dev-<名字>，appData 由 Electron 按平台给——不在脚本里拼 `$APPDATA`
 *   （那只在 Windows 有值，macOS 上会展开成根目录下的 `/orbita-dev-2`）。
 * - 显式 `--user-data-dir`：userData 用调用方给的值（Chromium 已应用它），工作区根
 *   从目录名派生——orbita-dev-2 → ~/Orbita-dev-2。两者都给时它优先：命令行比环境变量更近。
 */
export function devDataDirs(input: {
  packaged: boolean;
  appData: string;
  home: string;
  /** `--user-data-dir` 的值；没给（或空串）走默认开发版目录 */
  userDataSwitch?: string;
  /** `ORBITA_DEV_INSTANCE` 的值；没给（或空串）走默认开发版目录 */
  instance?: string;
}): { userData: string; orbitaRoot: string } | null {
  if (input.packaged) return null;
  // 尾部分隔符去掉再取名：目录名才是身份，斜杠不是
  const given = input.userDataSwitch?.replace(/[\\/]+$/, "");
  if (given !== undefined && given !== "") {
    const name = basename(given).replace(/^orbita-/i, "");
    return { userData: given, orbitaRoot: join(input.home, `Orbita-${name}`) };
  }
  const instance = input.instance ?? "";
  if (instance !== "") {
    // 名字直接拼进路径：只认字母数字与 - _，打错就当场失败——悄悄落回 orbita-dev 恰恰是隔离要防的事
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(instance)) {
      throw new Error(`ORBITA_DEV_INSTANCE 只能含字母、数字、- 与 _：${instance}`);
    }
    return { userData: join(input.appData, `${DEV_USER_DATA}-${instance}`), orbitaRoot: join(input.home, `${DEV_ORBITA_ROOT}-${instance}`) };
  }
  return { userData: join(input.appData, DEV_USER_DATA), orbitaRoot: join(input.home, DEV_ORBITA_ROOT) };
}
