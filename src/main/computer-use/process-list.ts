/**
 * `tasklist /FO CSV /NH` 输出 → 沙箱侧进程 PID。
 *
 * 为什么需要它：2026-10-23（Windows 更新后的新沙箱架构）真机实测，`WindowsSandbox.exe`
 * 只是启动器——spawn 后 0 秒就以 code 0 退出，把 VM 交给 `WindowsSandboxServer`；真正占着
 * ~2.5GB 的是 `WindowsSandboxServer` / `WindowsSandboxRemoteSession` / `vmwp` 三类进程。
 * 启动器一退，stop 就没有 PID 可杀（当时留了孤儿 VM，得手动 `taskkill /PID <pid> /T /F`）。
 *
 * 这里**只做观测**：谁是我们这只沙箱由控制器用「启动前基线 → 现在」的差集算出来；
 * 关闭先发给 RemoteSession 的窗口一条 WM_CLOSE（见 isRemoteSessionImage），不行才按 PID
 * 走 taskkill /T /F。**绝不按镜像名杀**（仓规：禁 pkill/killall 式按名字匹配）。
 *
 * 按前缀比而不是全名比：tasklist 的 Image Name 列在部分 Windows 版本上会被截到 25 个字符，
 * `WindowsSandboxRemoteSession.exe`（32 字符）就会被切成 `WindowsSandboxRemoteSessi`，
 * 全名相等会静默漏掉它——那正是最占内存、最该被杀的那个。
 *
 * 前缀只用于两个长名字；`vmwp` 短得能被别人前缀命中（如 vmwpctl），它只认精确值。
 */
const SERVER_STEM = "windowssandboxserver";
const REMOTE_SESSION_STEM = "windowssandboxremotesession";
const SANDBOX_IMAGE_PREFIXES = [SERVER_STEM, REMOTE_SESSION_STEM];
const SANDBOX_IMAGE_EXACT = ["vmwp"];
/**
 * 截断容忍的下限：观察到的那半截至少这么长，才允许反过来用「它是长名的前缀」判。
 * 不然启动器 `WindowsSandbox.exe`（16 字符）也是 `windowssandboxserver` 的前缀，会被误认。
 */
const TRUNCATED_MIN_LENGTH = 20;

/**
 * 一行 CSV：`"ImageName","PID","SessionName","Session#","Mem Usage"`。
 * 只认前三列里前两列——内存列里带千分位逗号（"12,345 K"），按逗号切会把它切进来。
 */
const TASKLIST_CSV_LINE = /^"([^"]*)","(\d+)"/;

export function isSandboxImage(imageName: string): boolean {
  // 镜像名本身不含空格（WindowsSandboxServer.exe），去掉 .exe 后比较
  const stem = imageName.toLowerCase().replace(/\.exe$/, "");
  if (SANDBOX_IMAGE_EXACT.includes(stem)) return true;
  return SANDBOX_IMAGE_PREFIXES.some((expected) => matchesStem(stem, expected));
}

/**
 * 是不是这只沙箱的「窗口」进程（RemoteSession）。优雅关闭只发给它。
 *
 * 2026-10-23 真机实测（主会话）：给它发 WM_CLOSE（等价用户点 X）后 9~12 秒内
 * RemoteSession → Server → vmwp → vmmemWindowsSandbox 全部自行退出，VM 内存释放；
 * 而 `taskkill /F` 打掉 RemoteSession 会留下 vmwp + 3.4GB 的 vmmemWindowsSandbox（关了窗但从
 * 宿主泄漏 VM），不带 /F 则完全无效（它不是控制台进程）。所以这条路径必须先走优雅关闭。
 */
export function isRemoteSessionImage(imageName: string): boolean {
  return matchesStem(imageName.toLowerCase().replace(/\.exe$/, ""), REMOTE_SESSION_STEM);
}

/** 前缀相等（含 tasklist 的 25 字符截断容忍；截断只对够长的半截有效，否则启动器会被误认） */
function matchesStem(stem: string, expected: string): boolean {
  return stem.startsWith(expected) || (stem.length >= TRUNCATED_MIN_LENGTH && expected.startsWith(stem));
}

/** 一个沙箱侧进程：镜像名（tasklist 原样，可能被截断）+ PID */
export interface SandboxProcessInfo {
  image: string;
  pid: number;
}

/** 按 tasklist CSV 解析出沙箱侧进程（带镜像名）；坏行 / 别的进程一律跳过，不抛错 */
export function parseSandboxProcesses(csv: string): SandboxProcessInfo[] {
  const processes: SandboxProcessInfo[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const match = TASKLIST_CSV_LINE.exec(line.trim());
    if (match === null) continue;
    const image = match[1] ?? "";
    const pid = Number(match[2]);
    if (!Number.isInteger(pid) || !isSandboxImage(image)) continue;
    processes.push({ image, pid });
  }
  return processes;
}
