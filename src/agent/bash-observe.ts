/**
 * bash 执行观察层 —— 顶掉 pi 内建 bash 的 `BashOperations`。
 *
 * **为什么要接管**（已实测的语义错误，不是猜测）：pi 的 bash 在子进程 `exit` 之后
 * 「管道静默 100ms」就 finalize。`bash -c '(sleep 2; echo LATE_OUTPUT) & echo early'`
 * 实测 164ms 返回，只拿到 `early`；2 秒后写的 `LATE_OUTPUT` 永久丢失，而那个后台进程
 * （dev server / 探针）还活着——模型却已经被告知「命令完成」，于是去抢端口、重跑，
 * 或判断服务没起来。最近 60 个会话里 830/8,808 次 bash 调用（9.4%）以 `&` 结尾。
 *
 * 本模块**不改** pi 的 finalize 语义（同样的 100ms 宽限、同样的 exitCode），只在
 * 「exit 之后管道没关、宽限到期才收尾」这条稀有路径上补一句后代存活提示：让模型知道
 * 自己看到的是半份结果，并且还有东西在跑。提示走 `options.onData`，自然落进工具结果，
 * 不需要 toolCallId 关联、不需要新 IPC、不改协议。
 *
 * 第二件观察：命令长时间没输出、进程也没消耗 CPU 时，在返回前补一句「疑似停滞
 * （只提示，不杀）」——判据与文案见 `./bash-stall.ts`，进程树 CPU 采样见 `./proc-tree.ts`。
 * 它救的是实测那批「跑 30 分钟以上、最长 3.7 小时」的探针命令：模型当时看不到任何
 * 异常，只能干等或反复问你。
 *
 * 第三件：**到点不再无条件杀**。到 `timeout` 时先看证据（最近有没有输出、进程树
 * 有没有涨 CPU），有进展就按 10 分钟一档延长，最多两次，再往上被封在
 * `COMMAND_TIMEOUT_HARD_MAX_SECONDS`；没进展才照旧杀。理由与阈值取舍见
 * `ExtensionOptions` 上方那段注释。
 *
 * **提示行的契约**：所有提示都是 `[orbita] kind=<名字> <key=value…> | <英文散文>`，
 * 独占一行。竖线之前是渲染层解析的契约（`renderer/features/chat/tool-results.ts`
 * 的 `parseBashNotices`），竖线之后是给模型的整句解释（改字不影响界面）。
 * 提示仍然进工具结果：**会话记录与模型看到的文本一个字不少**，只是界面把它收进
 * 「行尾 / 次行 / 展开体」三个槽位，不再混在 stdout 里当一行机器话。
 *
 * **与 pi 的 `createLocalShellOperations` 逐条对齐**：超时解析、错误文案、spawn 参数、
 * 杀树、结束后等待方式。错误字符串必须逐字一致——pi 靠
 * `err.message === "aborted"` 与 `err.message.startsWith("timeout:")` 翻译成
 * `Command aborted` / `Command timed out after N seconds`；差一个字，模型看到的文案就退化
 * （不是报错，是悄悄变成一句看不懂的原文）。
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import {
  createBashToolDefinition,
  getShellConfig,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { COMMAND_TIMEOUT_HARD_MAX_SECONDS } from "../shared/permission.ts";
import { createStallWatcher, STALL_CPU_DELTA_MS, type StallWatchOptions } from "./bash-stall.ts";
import { readTreeCpuMs } from "./proc-tree.ts";

/**
 * pi 的 `ShellConfig` 没从包根导出（只导出 `getShellConfig`）。用它的返回类型代替：
 * 结构随 pi 变，我们不另抄一份定义。
 */
type ShellConfig = ReturnType<typeof getShellConfig>;

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * exit 之后等管道静默的宽限（与 pi 的 `EXIT_STDIO_GRACE_MS` 同值）。
 * 每来一块数据就重新计时：还在写就继续等，静下来了才收尾。
 */
const EXIT_STDIO_GRACE_MS = 100;

/* ------------------------------------------------------------------ *
 * 到点延长：证据与阈值
 * ------------------------------------------------------------------ */

/**
 * 每次延长给多久。10 分钟：长到足以让一条真的在干活的构建 / 安装跨过它的慢段，
 * 又短到即使判错了（把停滞当成在干活）也不会让模型干等十几分钟。
 */
const EXTEND_BY_MS = 600_000;
/**
 * 最多延长几次。两次 + 每档 10 分钟 = 在声明的超时之外最多再给 20 分钟，
 * 仍然封在 `COMMAND_TIMEOUT_HARD_MAX_SECONDS`(60 分钟) 之内。
 */
const MAX_EXTENSIONS = 2;
/**
 * 「最近有输出」的窗口。**为什么用「最近有输出」而不是「整段都静默」**：
 * 长构建 / 长安装的输出是脉冲式的——编译一批吐几行，接着几分钟细致地链接、打包。
 * 「整段都没输出」这种判据会把最典型的合法长任务判成停滞；而「到点前一分钟还在吐字」
 * 已经足以说明它没死。静止不动的真卡死命令（探针脚本、等 CSI 的交互程序）在这个窗口里
 * 一块数据都没有，照样会被杀。
 */
const EXTEND_RECENT_OUTPUT_MS = 120_000;

/**
 * 到点决策的可注入参数（同 `StallWatchOptions` 的模式：线上用默认值，测试把 10 分钟、
 * 60 分钟压到毫秒级，否则这条路径根本测不了）。
 */
export interface ExtensionOptions {
  /** 每次延长的毫秒数，默认 `EXTEND_BY_MS`。 */
  extendByMs?: number;
  /** 最多延长几次，默认 `MAX_EXTENSIONS`。 */
  maxExtensions?: number;
  /** 「最近有输出」的窗口，默认 `EXTEND_RECENT_OUTPUT_MS`。 */
  recentOutputMs?: number;
  /**
   * 绝对天花板（从命令开始算的总时长），默认 `COMMAND_TIMEOUT_HARD_MAX_SECONDS * 1000`。
   * **为什么是绝对天花板，而不是 `timeout × 2`**：与声明值无关的硬边界才拦得住
   * 「每一档都有证据所以一直延」的链条；`timeout × 2` 会随声明值水涨船高，
   * 声明 2900 秒的命令就能跑到 5800 秒，把权限层的上限整个架空。
   */
  hardMaxMs?: number;
  /** CPU 增长阈值，默认复用停滞判据的 `STALL_CPU_DELTA_MS`(100ms)。 */
  cpuDeltaMs?: number;
  /** 进程树 CPU 采样实现（测试注入用），默认 `readTreeCpuMs`。 */
  sampleCpuMs?: (pid: number) => Promise<number | null>;
}

/**
 * 本进程 spawn 出去的 shell 登记表（模块级：`killObservedChildren` 要在进程收尾时
 * 一眼看全）。条目在 finally 里删掉——**除非**宽限路径上探到了活后代，那种才是
 * 应用退出时还需要补刀的尸体。
 */
interface ObservedChild {
  pid: number;
  spawnedAt: number;
  /** 宽限路径上探到的活后代：Windows 上父进程没了 `taskkill /T` 就找不到它们，退出时逐个补刀 */
  descendants: number[];
}

const observedChildren = new Map<number, ObservedChild>();

/**
 * 杀一棵进程树。Windows 用 `taskkill /F /T`（**同步**：退出路径上要它落地，
 * 否则紧接着的 `process.exit` 会把还没跑起来的 taskkill 一起带走）；
 * POSIX 杀进程组（我们 spawn 时 `detached`，shell 是组长，后代都在组里）。
 * 进程已退出 / 组已空是最常见的情况，吞掉。
 */
function killProcessTree(pid: number): void {
  try {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
        stdio: "ignore",
        windowsHide: true,
      });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // 已经没了
  }
}

/**
 * 进程收尾用：把还挂在我们名下的 shell（以及探到过的后代）全部杀掉，清空登记。
 *
 * 为什么需要它：pi 内建 bash 会 `trackDetachedChildPid`，并在它自己的 RPC / 交互模式里
 * 靠 SIGTERM/SIGHUP 收尾；我们把执行换成自己的实现后这条链路不在，若不补，
 * **应用退出但 bash 子进程还活着**——dev server 占着端口，下次启动神秘失败。
 *
 * 只做全局收尾，不做「按会话收尾」：登记表是整个进程一份，删一条会话时调它会把
 * 别的会话正在跑的命令一起杀掉。
 */
export function killObservedChildren(): void {
  for (const child of observedChildren.values()) {
    killProcessTree(child.pid);
    for (const descendant of child.descendants) killProcessTree(descendant);
  }
  observedChildren.clear();
}

/** 与 pi 逐字一致的超时解析（含错误文案）。 */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
  if (timeout === undefined) return undefined;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("Invalid timeout: must be a finite number of seconds");
  }
  const timeoutMs = timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
  }
  return timeoutMs;
}

/**
 * 列出某个 shell 名下的**全部**活后代。
 *
 * 为什么一次取全表而不是逐层 `ParentProcessId=<pid>` 查询：命令早退时，握着管道的
 * 往往不是直接子进程，而是「直接子进程 fork 出来的孙进程」；而那个直接子进程（中间那层
 * bash）常常在宽限期里就退了——逐层问的时候它已经不在，链条断在中间，真正还活着的
 * 孙进程就查不到（实测：`node … & echo early` 的形态就是这样）。全表快照里中间进程
 * 那一刻还在，父子关系还在，内存里 BFS 就能把整棵子树展开。
 *
 * 代价：powershell / ps 各一次（实测 Windows 上约 1s），所以**只挂在宽限那条稀有路径**上。
 * 用异步 spawn 而不是 `spawnSync`：utility 进程是所有会话共用的，为了给一条命令补一句
 * 提示把它的事件循环卡住一秒（别的会话的流式输出也跟着停）不划算。
 * 失败一律返回空数组：这是「锦上添花」的提示，任何一环出问题都不该让命令本身失败。
 */
async function findLiveDescendants(pid: number): Promise<number[]> {
  const tree = await readProcessTree();
  if (tree === null) return [];
  const descendants: number[] = [];
  const queue = [pid];
  const seen = new Set<number>(queue);
  // 深度上限防环（进程表理论上无环，但 pid 复用会造出假父子关系）
  for (let depth = 0; depth < 8 && queue.length > 0; depth += 1) {
    const next: number[] = [];
    for (const parent of queue) {
      for (const child of tree.get(parent) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        descendants.push(child);
        next.push(child);
      }
    }
    queue.length = 0;
    queue.push(...next);
  }
  return descendants;
}

/** 一次快照拿到「父 pid → 子 pid[]」。拿不到（起不来 / 非零退出 / 超时）返回 null。 */
function readProcessTree(): Promise<Map<number, number[]> | null> {
  const file = process.platform === "win32" ? "powershell" : "ps";
  const args =
    process.platform === "win32"
      ? ["-NoProfile", "-Command", 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }']
      : ["-A", "-o", "pid=", "-o", "ppid="];
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: Map<number, number[]> | null) => {
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
      const tree = new Map<number, number[]>();
      for (const line of stdout.split(/\r?\n/)) {
        const [childRaw, parentRaw] = line.trim().split(/\s+/);
        const childPid = Number(childRaw);
        const parentPid = Number(parentRaw);
        if (!Number.isInteger(childPid) || !Number.isInteger(parentPid)) continue;
        if (childPid <= 0 || parentPid <= 0) continue;
        const bucket = tree.get(parentPid);
        if (bucket === undefined) tree.set(parentPid, [childPid]);
        else bucket.push(childPid);
      }
      finish(tree);
    });
  });
}

/**
 * 收尾原因。**只有 `grace` 才查后代**：
 * - `close`：子进程与管道一起关了，没人握着管道，没有「半份结果」这回事；
 * - `drained`：exit 时 stdout/stderr 都已 end，管道同样干净；
 * - `grace`：exit 之后管道一直没关，宽限到期才强行收尾——这正是「命令早退了、
 *   后代还握着管道」的形态，也是唯一值得花 1s 去查后代的时刻。
 */
type FinalizeReason = "close" | "drained" | "grace";

interface WaitOutcome {
  exitCode: number | null;
  reason: FinalizeReason;
}

/**
 * 等子进程结束 —— 与 pi 的 `waitForChildProcess` 同语义（它没从包根导出，深引
 * `dist/utils/child-process.js` 在 pi 升级时必断，所以自己维护这一小段），多带一个
 * 「谁收尾的」标记。
 *
 * 关键：**不能用 `close` 单独定案，也不能从 exit 起算固定 deadline**。exit 之后可能有
 * 后代仍握着管道在写；固定 deadline 一到就 destroy 会把后面的尾巴截掉。所以 exit 之后
 * 每来一块数据就重新计时，静默满宽限才收尾。
 */
function waitForChildProcessOutcome(child: ChildProcess): Promise<WaitOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let postExitTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = () => {
      if (postExitTimer !== undefined) {
        clearTimeout(postExitTimer);
        postExitTimer = undefined;
      }
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };

    const finalize = (code: number | null, reason: FinalizeReason) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode: code, reason });
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode, "drained");
    };

    const armIdleTimer = () => {
      if (postExitTimer !== undefined) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode, "grace"), EXIT_STDIO_GRACE_MS);
    };

    const onData = () => {
      // exit 之后还在来数据：别急着收尾，把尾巴读完
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = () => {
      stdoutEnded = true;
      maybeFinalizeAfterExit();
    };
    const onStderrEnd = () => {
      stderrEnded = true;
      maybeFinalizeAfterExit();
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null) => {
      exited = true;
      exitCode = code;
      maybeFinalizeAfterExit();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null) => {
      finalize(code, "close");
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

/**
 * 延长记录。走 `onData`，与后代存活提示、停滞提示、超时提示同一套契约：
 * `[orbita] kind=… <key=value…> | <给模型看的一句英文>`——竖线之前给渲染层解析，
 * 竖线之后是散文（整句仍然是模型的自救依据）。
 */
function extensionNotice(
  deadlineSeconds: number,
  nextDeadlineSeconds: number,
  index: number,
  max: number,
): string {
  return (
    `\n[orbita] kind=extended from=${deadlineSeconds}s to=${nextDeadlineSeconds}s count=${index} max=${max} | ` +
    `The command reached its ${deadlineSeconds}s limit while it was still producing output or using CPU, ` +
    `so the deadline was extended to ${nextDeadlineSeconds}s (extension ${index}/${max}). ` +
    "Nothing to do yet; the result will follow when the command finishes or the deadline is reached again.\n"
  );
}

/**
 * 后代存活提示。只追加一次，进工具结果。散文部分保留原来的自救信息：晚到输出不在
 * 本次结果里、服务 / 探针改用 terminal_*。
 */
function descendantsNotice(pid: number): string {
  return (
    `\n[orbita] kind=descendants pid=${pid} | ` +
    `The command already returned, but descendant processes are still running (pid ${pid}). ` +
    "Output they write from now on is not part of this result. If this is a server or a probe, " +
    "use the terminal_* tools instead, or stop it explicitly.\n"
  );
}

/**
 * 到点被杀的提示。与 `permission.ts` 的 `kind=cap seconds=… declared=…` **共存**：
 * 那条讲「上限是谁定的」（默认值 / 被夹紧），这条讲「当时有没有进展」——渲染层
 * 合成一句，模型两条都能看到。
 *
 * `progress` 不是猜出来的：它来自到点决策时看过的证据（最近有输出 / 进程树还在涨 CPU）。
 * 有进展被杀 → 值得换个更长 timeout 或拆片重试；全程没动 → 同样的坑再等多久都一样。
 */
function capNotice(seconds: number, progress: boolean): string {
  return (
    `\n[orbita] kind=cap seconds=${seconds} progress=${progress ? "yes" : "no"} | ` +
    `The command was killed at the ${seconds}s limit. ` +
    (progress
      ? "It was still producing output or using CPU when it was killed, so it was making progress and that work is now lost. " +
        "If the task really needs longer, retry with an explicit timeout (seconds, at most " +
        `${COMMAND_TIMEOUT_HARD_MAX_SECONDS}), split it into smaller steps, or use the terminal_* tools.`
      : "It had been silent with no CPU growth for a while, so a longer timeout would likely wait the same way. " +
        "Split the command into smaller steps, or use the terminal_* tools to watch it.") +
    "\n"
  );
}

/**
 * 造一份与 pi 内建 bash 等价、但多一层后代观察的 `BashOperations`。
 *
 * 语义对照见文件头。`resolveShellConfig` 每次 exec 现调（pi 同款）：用户中途改
 * `shellPath`，下一条命令就生效。
 */
export function createObservedBashOperations(
  resolveShellConfig: () => ShellConfig,
  /** 停滞观察的阈值与采样实现：默认值即线上行为，测试用来把 30s/60s 压到毫秒级 */
  stallOptions: StallWatchOptions = {},
  /** 到点延长的阈值与采样实现：默认值即线上行为，测试把 10 分钟 / 60 分钟压到毫秒级 */
  extensionOptions: ExtensionOptions = {},
): BashOperations {
  const extendByMs = extensionOptions.extendByMs ?? EXTEND_BY_MS;
  const maxExtensions = extensionOptions.maxExtensions ?? MAX_EXTENSIONS;
  const recentOutputMs = extensionOptions.recentOutputMs ?? EXTEND_RECENT_OUTPUT_MS;
  const hardMaxMs = extensionOptions.hardMaxMs ?? COMMAND_TIMEOUT_HARD_MAX_SECONDS * 1000;
  const cpuDeltaMs = extensionOptions.cpuDeltaMs ?? STALL_CPU_DELTA_MS;
  const sampleCpuMs = extensionOptions.sampleCpuMs ?? readTreeCpuMs;

  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const timeoutMs = resolveTimeoutMs(timeout);
      if (signal?.aborted) throw new Error("aborted");

      const shellConfig = resolveShellConfig();
      try {
        await fsAccess(cwd, constants.F_OK);
      } catch {
        // 文案照抄 pi：模型与提示词都按这句话理解「目录没了，别重试」
        throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
      }

      // 「跑了多久」从 spawn 前一刻算起：到点报告的超时秒数必须是真的跑过的时长
      const startedAt = Date.now();
      const commandFromStdin = shellConfig.commandTransport === "stdin";
      const child = spawn(
        shellConfig.shell,
        commandFromStdin ? shellConfig.args : [...shellConfig.args, command],
        {
          cwd,
          // POSIX 上 detached：shell 成为新进程组组长，杀树用 `-pid`；shell 先退、
          // 后代握着管道时进程组还在，收尾照样能把整组杀掉。
          detached: process.platform !== "win32",
          // env 由 pi 的调用处给（它已做过 PI_* 取舍与 PATH 补齐），这里不另造一份
          env,
          stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );

      if (commandFromStdin) {
        child.stdin?.on("error", () => {});
        child.stdin?.end(command);
      }

      const record: ObservedChild | undefined =
        child.pid === undefined
          ? undefined
          : { pid: child.pid, spawnedAt: Date.now(), descendants: [] };
      if (record !== undefined) observedChildren.set(record.pid, record);

      // 停滞观察：**只提示、绝不杀**。定时器由 finally 里的 stop() 收干净——
      // 命令结束还留一个 90 秒的 setTimeout，Node 进程就退不出去。
      const stall =
        record === undefined
          ? null
          : createStallWatcher(record.pid, (notice) => onData(Buffer.from(notice, "utf8")), stallOptions);

      /** 命令真的吐过字才置位：**不要把 spawn 本身算成「有输出」**，否则短超时永远有「输出的证据」。 */
      let lastOutputAt: number | undefined;
      /** 上一次采到的（或 stall watcher 采到的）进程树 CPU，作为「有没有涨」的基线。 */
      let knownCpuMs: number | null = null;
      let extensions = 0;
      let timedOut = false;
      /** 到点杀时报告的真实时长（秒）：不能再用最初声明的 `timeout`，那是一句假话。 */
      let timeoutSeconds = 0;
      /** 当前期限的绝对时刻，延长时只往后推迟，封在 `startedAt + hardMaxMs`。 */
      let deadlineAt = startedAt + (timeoutMs ?? 0);
      let timeoutHandle: NodeJS.Timeout | undefined;
      /** 命令已经收尾（`waitForChildProcessOutcome` 已 resolve）：异步决策不再动手。 */
      let finished = false;

      const forward = (chunk: Buffer) => {
        lastOutputAt = Date.now();
        stall?.noteData();
        onData(chunk);
      };
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);

      const clearDeadline = () => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };

      const armDeadline = () => {
        clearDeadline();
        // 定时器一个就够：延长时重挂到新期限，不做轮询；finally 里统一清掉
        timeoutHandle = setTimeout(() => {
          void onDeadline();
        }, Math.max(0, deadlineAt - Date.now()));
      };

      const killForTimeout = (progress: boolean) => {
        timedOut = true;
        // 报「到点时的累计期限」，而不是最初声明的值：延长过以后，
        // 「timed out after 1800 seconds」就是一句假话。也不用测量延迟后的 elapsed——
        // 我们自己的 CPU 采样（Windows 约 1s）不该算成命令跑过的时间。
        timeoutSeconds = Math.max(1, Math.round((deadlineAt - startedAt) / 1000));
        // 先落这句话再杀：onData 是同步的，它一定在命令结束之前进结果；
        // 模型据此知道「是撞上限死的、死时有没有在干活」
        onData(Buffer.from(capNotice(timeoutSeconds, progress), "utf8"));
        if (child.pid !== undefined) killProcessTree(child.pid);
      };

      /**
       * 这次到点，进程树是不是还在烧 CPU。只看「现在 - 最近一次已知值」，
       * 拿不到基线 / 采不到 / 树变小（pid 复用、中间层退出）一律判「没证据」——
       * 与停滞判据同一条原则：宁可漏报延长，不可凭猜测续命。
       */
      const hasCpuProgress = async (pid: number): Promise<boolean> => {
        // 基线只能来自「此前真采过的一次数值」（停滞观察器在静默 30s/90s 时采的那两次，
        // 或我们上一次到点时的采样）。**没有基线就不采**：单次数值证明不了「在涨」，
        // 而 Windows 一次快照要 1s，花它去猜没有意义。
        const known = knownCpuMs ?? stall?.lastCpuMs() ?? null;
        if (known === null) return false;
        let current: number | null;
        try {
          current = await sampleCpuMs(pid);
        } catch {
          current = null;
        }
        if (current === null) return false;
        knownCpuMs = current;
        if (!(current - known > 0)) return false;
        return current - known >= cpuDeltaMs;
      };

      /**
       * 到点决策（不再「到点即杀」）。顺序按成本：先判不能延长的硬条件，再看输出
       * （零成本），最后才采进程树 CPU（Windows 一次约 1s，utility 进程所有会话共用）。
       *
       * **声明值也延长**（刻意的取舍）：模型自己填 `timeout: 600` 也会在到点时按证据延
       * 长。杀掉一条在干活的命令比多花十分钟更亏，而延长是可见的（模型能看到那条记录），
       * 总时长又封在 `hardMaxMs` 里——所以宁可多给一档，不要扔掉已经跑了一半的活。
       */
      const onDeadline = async () => {
        timeoutHandle = undefined;
        if (finished) return;
        const totalMs = Date.now() - startedAt;
        // 1) 天花板与次数先用完就用完：不再看证据，直接杀（「最近有没有输出」是零成本的，
        //    只看它来回答「当时有没有进展」——不为这句话再花一次进程表快照）
        if (totalMs >= hardMaxMs || extensions >= maxExtensions) {
          const outputFresh = lastOutputAt !== undefined && Date.now() - lastOutputAt <= recentOutputMs;
          killForTimeout(outputFresh);
          return;
        }
        // 2) 证据：最近有输出，或进程树还在涨 CPU
        const outputFresh = lastOutputAt !== undefined && Date.now() - lastOutputAt <= recentOutputMs;
        const pid = child.pid;
        const cpuBusy = !outputFresh && pid !== undefined ? await hasCpuProgress(pid) : false;
        // 采样期间命令自己结束了，或被 abort 了：交给收尾逻辑，不要在这里延长 / 杀
        if (finished || signal?.aborted === true) return;
        if (!outputFresh && !cpuBusy) {
          killForTimeout(false);
          return;
        }
        // 3) 延长：计数 +1，期限取「当前 + 一档」与天花板里更早的那个
        const previousDeadline = deadlineAt;
        const nextDeadline = Math.min(previousDeadline + extendByMs, startedAt + hardMaxMs);
        // 期限已经推不动（定时器比 deadline 早醒几毫秒、天花板已到）→ 不假装延长，直接杀
        if (!(nextDeadline > previousDeadline)) {
          killForTimeout(true);
          return;
        }
        extensions += 1;
        deadlineAt = nextDeadline;
        armDeadline();
        onData(
          Buffer.from(
            extensionNotice(
              Math.round((previousDeadline - startedAt) / 1000),
              Math.round((deadlineAt - startedAt) / 1000),
              extensions,
              maxExtensions,
            ),
            "utf8",
          ),
        );
      };

      const onAbort = () => {
        if (child.pid !== undefined) killProcessTree(child.pid);
      };

      try {
        if (timeoutMs !== undefined) armDeadline();
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const outcome = await waitForChildProcessOutcome(child);
        finished = true;
        if (outcome.reason === "grace" && record !== undefined) {
          const descendants = await findLiveDescendants(record.pid);
          if (descendants.length > 0) {
            record.descendants = descendants;
            onData(Buffer.from(descendantsNotice(descendants[0] ?? record.pid), "utf8"));
          }
        }

        // 顺序与 pi 一致：先看 abort，再看 timeout（两者可能同时成立，文案以 abort 为准）
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeoutSeconds}`);
        return { exitCode: outcome.exitCode };
      } finally {
        finished = true;
        if (stall !== null) stall.stop();
        clearDeadline();
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        // 有活后代的条目留着（应用退出还要补刀）；其余立刻删，登记表不随调用次数增长
        if (record !== undefined && record.descendants.length === 0) {
          observedChildren.delete(record.pid);
        }
      }
    },
  };
}

/** 造 bash 工具定义只需要这两个只读设置项（运行时装的就是 `services.settingsManager`）。 */
export interface BashToolSettings {
  getShellPath(): string | undefined;
  getShellCommandPrefix(): string | undefined;
}

/**
 * 造我们要注册的那个 `bash` 工具定义（名字仍是 `bash`：pi 的 `_refreshToolRegistry`
 * 先建内建表、再 `toolRegistry.set(name, tool)` 合并自定义工具，同名即覆盖，
 * 其余内建工具不受影响）。
 *
 * **`commandPrefix` / `shellPath` 必须显式从设置里读出来传**：内建 bash 的这两个值是在
 * pi 装配会话时（`_buildRuntime`）从 settingsManager 现读的，我们用自己的定义盖掉它，
 * 就绕过了那次读取。漏传 prefix 等于把「非交互前缀」悄悄丢掉——登录 shell 的初始化
 * 不再执行，表现为昨天还能跑的命令今天 `command not found`，**而且没有任何报错**。
 */
export function createObservedBashTool(cwd: string, settings: BashToolSettings): ToolDefinition {
  const definition = createBashToolDefinition(cwd, {
    operations: createObservedBashOperations(() => getShellConfig(settings.getShellPath())),
    commandPrefix: settings.getShellCommandPrefix(),
    shellPath: settings.getShellPath(),
  });
  /*
   * 一次边界处的类型擦除：pi 的工厂把返回类型钉死在 bash 的 schema 上，而 customTools
   * 收的是 `ToolDefinition`（registry 只按 name 收录，参数类型不重要）。两者结构一致，
   * 只因 renderCall 的入参逆变使 TS 拒绝直接赋值——不是运行时差异，不给它加包装层。
   */
  return definition as unknown as ToolDefinition;
}
