/**
 * 把 bash 可执行文件的绝对路径**探一次**，之后钉在 pi 的 `shellPath` 设置上。
 *
 * 治的是 pi 在 Windows 上的一个每次调用都要付的固定成本：
 *
 *   `getShellConfig()`（`utils/shell.js`）在**每次 exec 时**都会被调一遍。它先
 *   `existsSync` 两个 `%ProgramFiles%\Git\bin\bash.exe`（约 0.1ms，便宜），
 *   **两个都不命中就退到 `spawnSync("where", ["bash.exe"])`——本机多轮实测 50~85ms（不同轮次波动就有这么宽），
 *   而且是同步的，会卡住 agent 进程的事件循环**。
 *
 * 谁会被咬：Git 不在默认安装位置的机器——scoop / portable / 用户级安装 / MSYS2。
 * 那些机器上每一次 bash 调用都白付 50~85ms（39ms 的 Git Bash 启动变成 ~90-125ms）。
 * 我们在启动探测一次、把结果作为 `shellPath` 传下去，pi 那条早退就只剩一次
 * `existsSync`——**查找顺序仍是 pi 自己那套，我们只是让它别每轮重算**。
 *
 * 为什么不自己重写一遍查找顺序：那是第二个真源。pi 的 `getShellConfig()` 是包入口的
 * 公开导出（同 `resolveToCwd`，见 file-tracker 的先例），直接用它，
 * 上游改了查找顺序我们跟着改，不会两边各说各话。
 */
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { getShellConfig } from "@earendil-works/pi-coding-agent";

/**
 * 这个路径能不能当 `shellPath` 交给 pi。
 *
 * 两条都必须成立，各有各的理由：
 *
 * - **必须是绝对路径**：POSIX 上 `getShellConfig()` 的最后一档兜底是裸名 `sh`
 *   （`{ shell: "sh" }`）。把它当 shellPath 传回去，pi 会走
 *   `existsSync("sh")` → false → 抛「Custom shell path not found: sh」——
 *   本来能跑的机器反而不跑了。
 * - **必须存在**：同上，`customShellPath` 那一支是 `existsSync` 门，不存在直接抛。
 */
function usableShellPath(path: string): boolean {
  return isAbsolute(path) && existsSync(path);
}

/**
 * pi 自己那套解析跑一次。**没装 Git Bash 时它抛**（错误信息是三条安装建议），
 * 这里吞掉返回 `undefined`——「探不到」不是错误，让 pi 自己去它原来的路径上抛，
 * 我们不改变那种机器上的行为。
 */
function findShellPathViaPi(): string | undefined {
  try {
    return getShellConfig().shell;
  } catch {
    return undefined;
  }
}

/**
 * 造一个带进程级缓存的探测器。
 *
 * `find` 探到给路径、探不到给 `undefined`。
 *
 * **只缓存成功**：探不到就每轮重试（那几个 `existsSync` 本身是廉价的），
 * 于是用户在会话进行中装好 Git Bash，下一轮就能用上，不需要重启应用。
 * 缓存了失败路径反而会让「装完了还是不生效」变成要查的 bug。
 *
 * 同一枚硬币的另一面（已知代价）：缓存命中后**不再复查存在性**——钉住的 bash 若在
 * 应用存活期间被卸载/挪走，pi 每次 exec 抛「Custom shell path not found」，直到重启
 * 应用才回到探测。取「装好即生效」舍「卸载即自愈」：中途卸载是罕见事件，且失败是
 * 响亮的（直接报错，不是静默走错 shell），一眼能查。
 */
export function createShellPathResolver(
  find: () => string | undefined = findShellPathViaPi,
  isUsable: (path: string) => boolean = usableShellPath,
): () => string | undefined {
  let cached: string | undefined;
  return () => {
    if (cached !== undefined) return cached;
    const found = find();
    if (found !== undefined && isUsable(found)) cached = found;
    return cached;
  };
}
