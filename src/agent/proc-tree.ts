/**
 * 进程树 CPU 累计采样——给「疑似停滞」判定提供唯一的事实依据。
 *
 * **为什么需要它**：一条 bash 命令卡住时，界面上只有「没有新输出」这一个信号，而这个
 * 信号**单独用不成立**——`sleep 60`、等网络、等输入全都不吐字，它们是合法的静默；反过
 * 来 CPU 自旋的死循环也不吐字。其实用户真正想知道的是「这条命令还在干活吗」，而
 * 「有没有输出」答不了。所以要另取一个与输出无关的量：整棵进程树的累计 CPU 时间。
 *
 * **为什么两个信号必须联合**（本机实测结论，不是推理）：
 * - 只看输出静默 → 把「安静的合法等待」和「真卡死」判成一类；
 * - 只看 CPU 零增长 → 只写 stdout 的命令（`echo` 循环、`cat` 大文件）CPU 几乎不涨，
 *   会被误判成卡住。
 * 两个一起看（静默 90 秒 **且** 这 60 秒里 CPU 增长 < 100ms）才算「疑似停滞」，
 * 误报面小得多。即便如此它仍然**只是提示**：Windows 实测「合法静默」与「阻塞读
 * stdin」的线程状态逐项相同（WaitReason 也区分不出来），没有任何判据可以据此杀进程。
 *
 * **为什么只采样两次**：Windows 上一次进程表快照约 700ms（本机 737 个进程），
 * 常驻采样会跟 UI 抢事件循环（utility 进程是所有会话共用的）。判定只需要两个时刻的
 * 差值，所以常态零成本（只挂 data 事件），静默超阈值才取 S0，再隔确认窗口取 S1。
 *
 * 拿不到就返回 `null`：判定放弃。宁可漏报，不可猜。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";

/**
 * Linux 上 `/proc/<pid>/stat` 的时间字段单位是 clock tick（USER_HZ）。Linux 的
 * USER_HZ 在所有主流架构（x86 / arm / aarch64 / ppc64）上固定为 100，且不随
 * CONFIG_HZ 变，所以这里写死 100，不为它去 spawn 一次 `getconf CLK_TCK`。
 */
const LINUX_CLOCK_TICKS_HZ = 100;

/** 一次快照的单个进程：父 pid + 累计 CPU 毫秒。 */
export interface ProcCpuNode {
  parentPid: number;
  cpuMs: number;
}

/** 一次进程表快照：pid → 父 pid 与累计 CPU 毫秒。 */
export type ProcCpuTable = Map<number, ProcCpuNode>;

/**
 * 解析 `/proc/<pid>/stat`。comm（第 2 字段）可以是任意字符、可能带空格与括号，
 * 所以从**最后一个** `)` 之后开始切字段：那里第一个字段是 state（stat 的第 3 字段），
 * 于是 ppid = 第 4 字段 → 下标 1，utime = 第 14 → 下标 11，stime = 第 15 → 下标 12。
 */
export function parseLinuxProcStat(text: string, ticksHz = LINUX_CLOCK_TICKS_HZ): ProcCpuNode | null {
  const close = text.lastIndexOf(")");
  if (close < 0) return null;
  const fields = text.slice(close + 1).trim().split(/\s+/);
  if (fields.length < 13) return null;
  const parentPid = Number(fields[1]);
  const utime = Number(fields[11]);
  const stime = Number(fields[12]);
  if (!Number.isInteger(parentPid) || parentPid < 0) return null;
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return { parentPid, cpuMs: ((utime + stime) * 1000) / ticksHz };
}

/**
 * 解析 Windows 那份「一次吐全表」的文本：每行 `pid ppid KernelModeTime UserModeTime`。
 * CIM 的两个时间字段单位是 100 纳秒 → 除 10000 得毫秒。
 * CPU 字段读不到（受保护 / 已退出）的进程整行丢弃：**不能当 0 算**——少算 CPU 会
 * 把「在干活」判成「停滞」，那是我们要避免的那类错。
 */
export function parseWindowsProcessTable(stdout: string): ProcCpuTable {
  const table: ProcCpuTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4) continue;
    const pid = Number(parts[0]);
    const parentPid = Number(parts[1]);
    const kernel = Number(parts[2]);
    const user = Number(parts[3]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isInteger(parentPid) || parentPid < 0) continue;
    if (!Number.isFinite(kernel) || !Number.isFinite(user)) continue;
    table.set(pid, { parentPid, cpuMs: (kernel + user) / 10_000 });
  }
  return table;
}

/**
 * 解析 `ps -o time=` 的 CPU 时间。形态有三种：`MM:SS.ss`、`HH:MM:SS`、
 * `D-HH:MM:SS`（跑了多天的进程）；读不到时 ps 给 `-`。
 */
export function parsePsCpuTimeToMs(text: string): number | null {
  const raw = text.trim();
  if (raw === "" || raw === "-") return null;
  let days = 0;
  let rest = raw;
  const dash = raw.indexOf("-");
  if (dash >= 0) {
    days = Number(raw.slice(0, dash));
    rest = raw.slice(dash + 1);
  }
  const parts = rest.split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const seconds = Number(parts[parts.length - 1]);
  const minutes = Number(parts[parts.length - 2]);
  const hours = parts.length === 3 ? Number(parts[0]) : 0;
  if (![days, hours, minutes, seconds].every((value) => Number.isFinite(value))) return null;
  return (((days * 24 + hours) * 60 + minutes) * 60 + seconds) * 1000;
}

/** 解析 `ps -A -o pid=,ppid=,time=` 的输出（macOS / 其它没有 /proc 的 POSIX）。 */
export function parsePsTable(stdout: string): ProcCpuTable {
  const table: ProcCpuTable = new Map();
  for (const line of stdout.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue;
    const pid = Number(parts[0]);
    const parentPid = Number(parts[1]);
    const cpuMs = parsePsCpuTimeToMs(parts[2] ?? "");
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isInteger(parentPid) || parentPid < 0) continue;
    if (cpuMs === null) continue;
    table.set(pid, { parentPid, cpuMs });
  }
  return table;
}

/**
 * 在内存里把整棵子树展开求和。为什么不在系统侧递归查：命令早退时中间那层 bash
 * 常常已经没了，逐层问会断链；一次全表快照 + 内存 BFS 才抓得住还在跑的孙进程。
 * 深度上限防 pid 复用造出的假父子环。
 */
export function sumTreeCpuMs(table: ProcCpuTable, rootPid: number): number | null {
  const root = table.get(rootPid);
  if (root === undefined) return null;
  let total = root.cpuMs;
  const seen = new Set<number>([rootPid]);
  let frontier = [rootPid];
  for (let depth = 0; depth < 12 && frontier.length > 0; depth += 1) {
    const next: number[] = [];
    for (const parent of frontier) {
      for (const [pid, node] of table) {
        if (node.parentPid !== parent || seen.has(pid)) continue;
        seen.add(pid);
        total += node.cpuMs;
        next.push(pid);
      }
    }
    frontier = next;
  }
  return total;
}

/** 一次异步取全表（不阻塞事件循环：utility 进程是所有会话共用的）。 */
function spawnTable(file: string, args: string[], parse: (stdout: string) => ProcCpuTable): Promise<ProcCpuTable | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ProcCpuTable | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.once("error", () => finish(null));
    child.once("close", (code) => {
      if (code !== 0) {
        finish(null);
        return;
      }
      const table = parse(stdout);
      finish(table.size > 0 ? table : null);
    });
  });
}

/** Linux：直接读 /proc，不 spawn（一次几十毫秒，比一次 powershell 快两个量级）。 */
async function readLinuxTable(): Promise<ProcCpuTable | null> {
  let entries: string[];
  try {
    entries = await readdir("/proc");
  } catch {
    return null;
  }
  const table: ProcCpuTable = new Map();
  await Promise.all(
    entries.map(async (name) => {
      if (!/^\d+$/.test(name)) return;
      try {
        const text = await readFile(`/proc/${name}/stat`, "utf8");
        const node = parseLinuxProcStat(text);
        if (node !== null) table.set(Number(name), node);
      } catch {
        // 进程在枚举与读取之间退出：跳过（它会自然落到「未在表里」的判定上）
      }
    }),
  );
  return table.size > 0 ? table : null;
}

/** 取一次全表快照。拿不到（起不来 / 非零退出 / 超时）一律 null。 */
export async function readProcessCpuTable(): Promise<ProcCpuTable | null> {
  if (process.platform === "win32") {
    // 一次 powershell 把整张表吐完。**不要**循环 Get-Process / 逐 pid 查询：
    // 本机 737 个进程，逐个查是几百次进程创建，秒级起步。
    return spawnTable(
      "powershell",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.KernelModeTime) $($_.UserModeTime)\" }",
      ],
      parseWindowsProcessTable,
    );
  }
  if (process.platform === "linux") return readLinuxTable();
  // macOS 等没有 /proc 的 POSIX。**注意**：`ps -o time=` 分辨率只有 1 秒，
  // 这条判据在这些平台上只能做粗判（60 秒窗口内 1 秒以内的 CPU 变化看不到）。
  return spawnTable("ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "time="], parsePsTable);
}

/** 整棵进程树（含 root）的累计 CPU 毫秒。拿不到返回 null——调用方必须放弃判定。 */
export async function readTreeCpuMs(rootPid: number): Promise<number | null> {
  const table = await readProcessCpuTable();
  if (table === null) return null;
  return sumTreeCpuMs(table, rootPid);
}
