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
import { createStallWatcher, type StallWatchOptions } from "./bash-stall.ts";

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

/** 后代存活提示（中文，与仓库其它注释 / 文案一致）。只追加一次，进工具结果。 */
function descendantsNotice(pid: number): string {
  return (
    `\n[orbita] 命令已返回，但仍有后代进程在运行（pid ${pid}）。` +
    "晚到的输出不会出现在本次结果里；若它是服务或探针，请改用 terminal_* 或显式停止。\n"
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
): BashOperations {
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

      const forward = (chunk: Buffer) => {
        stall?.noteData();
        onData(chunk);
      };
      child.stdout?.on("data", forward);
      child.stderr?.on("data", forward);

      let timedOut = false;
      let timeoutHandle: NodeJS.Timeout | undefined;
      const onAbort = () => {
        if (child.pid !== undefined) killProcessTree(child.pid);
      };

      try {
        if (timeoutMs !== undefined) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) killProcessTree(child.pid);
          }, timeoutMs);
        }
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const outcome = await waitForChildProcessOutcome(child);
        if (outcome.reason === "grace" && record !== undefined) {
          const descendants = await findLiveDescendants(record.pid);
          if (descendants.length > 0) {
            record.descendants = descendants;
            onData(Buffer.from(descendantsNotice(descendants[0] ?? record.pid), "utf8"));
          }
        }

        // 顺序与 pi 一致：先看 abort，再看 timeout（两者可能同时成立，文案以 abort 为准）
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: outcome.exitCode };
      } finally {
        if (stall !== null) stall.stop();
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
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
