/**
 * bash 执行层 —— 顶掉 pi 内建 bash 的 `BashOperations`，并在签到点把控制权交还模型。
 *
 * **为什么要自建执行层**：pi 的 bash 是一个阻塞调用——模型发出命令后卡在工具调用里，
 * 直到进程退出才拿回控制权，中途它看不到任何东西、也无法决定「还要不要等」。实测
 * 长命令最长跑过 3.7 小时，这段时间模型既不能看进展，也不能停。
 *
 * 这里改的只有「到点怎么办」：到达签到点（默认 5 分钟）命令仍在跑时**不杀**，把它登记成
 * 会话（`b1` / `b2`）、把已有输出留在环形缓冲里、工具调用立刻返回。模型随后用
 * `bash_poll` 看进展、自己决定下一次隔多久再看、看明白了用 `bash_stop` 停。
 * **没有任何路径因为「到点」而杀进程**——唯一的杀是寿命上限、显式 stop、用户 abort。
 *
 * **短命令必须与今天逐字节一致**：签到前退出的命令走的是和 pi 一样的返回/错误路径，
 * 输出、退出码、`timeout:<秒>` 与 `aborted` 文案都不变（差分测试对着
 * `createLocalBashOperations()` 跑）。
 *
 * **提示行的契约**：`[orbita] kind=<名字> <key=value…> | <英文散文>`，独占一行。
 * 竖线之前给渲染层解析（P2 才接），竖线之后是给模型的整句解释。
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
import {
  TailBuffer,
  killAllSessions,
  registerSession,
  type BashSession,
  type RegisterSessionResult,
} from "./bash-sessions.ts";

/**
 * pi 的 `ShellConfig` 没从包根导出（只导出 `getShellConfig`）。用它的返回类型代替：
 * 结构随 pi 变，我们不另抄一份定义。
 */
type ShellConfig = ReturnType<typeof getShellConfig>;

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

/**
 * exit 之后等管道静默的宽限（与 pi 的 `EXIT_STDIO_GRACE_MS` 同值）。
 * 每来一块数据就重新计时：还在写就继续等，静下来了才收尾——否则 `sleep 0.5; echo done`
 * 的尾巴会被截掉。
 */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * 签到点：命令跑满 5 分钟仍未退出，就把控制权交还模型。
 *
 * 为什么是 5 分钟：短于它，正常的长构建（依赖安装 / 全量测试）会被频繁打断成交互；
 * 长于它，模型在「其实卡死了」的探针命令上白等的时间又太长。5 分钟也是实测里
 * 「人开始怀疑它卡住了」的量级。
 */
export const CHECK_IN_MS = 300_000;

/** 本进程 spawn 出去的 shell 登记表。应用退出时靠它收尾，见 `killObservedChildren` */
interface ObservedChild {
  pid: number;
  spawnedAt: number;
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
 * 应用退出时把还挂在我们名下的 shell 与会话一起收掉。
 *
 * 为什么需要它：pi 内建 bash 会 `trackDetachedChildPid`，并在它自己的 RPC / 交互模式里
 * 靠 SIGTERM/SIGHUP 收尾；我们把执行换成自己的实现后这条链路不在，若不补，
 * **应用退出但 bash 子进程还活着**——dev server 占着端口，下次启动神秘失败。
 *
 * 只做全局收尾，不做「按会话收尾」：登记表是整个 utility 进程一份，删一条 agent 会话时
 * 调它会把别的会话正在跑的命令一起杀掉。
 */
export function killObservedChildren(): void {
  for (const record of observedChildren.values()) killProcessTree(record.pid);
  observedChildren.clear();
  // 签到之后的 child 已从 observedChildren 移交会话表，这里补上那半边
  killAllSessions();
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

interface WaitOutcome {
  exitCode: number | null;
}

/**
 * 等子进程结束 —— 与 pi 的 `waitForChildProcess` 同语义（它没从包根导出，深引
 * `dist/utils/child-process.js` 在 pi 升级时必断，所以自己维护这一小段）。
 *
 * 关键：**不能用 `close` 单独定案，也不能从 exit 起算固定 deadline**。exit 之后可能有
 * 后代仍握着管道在写；固定 deadline 一到就 destroy 会把后面的尾巴截掉。所以 exit 之后
 * 每来一块数据就重新计时，静默满宽限才收尾。
 */
function waitForChildProcess(child: ChildProcess): Promise<WaitOutcome> {
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

    const finalize = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ exitCode: code });
    };

    const maybeFinalizeAfterExit = () => {
      if (!exited || settled) return;
      if (stdoutEnded && stderrEnded) finalize(exitCode);
    };

    const armIdleTimer = () => {
      if (postExitTimer !== undefined) clearTimeout(postExitTimer);
      postExitTimer = setTimeout(() => finalize(exitCode), EXIT_STDIO_GRACE_MS);
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
      finalize(code);
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

/** 签到提示。sessionId 让模型知道下一步该用哪个句柄；逗号后的两句说明怎么继续 */
function detachNotice(sessionId: string): string {
  return (
    `\n[orbita] kind=detached session=${sessionId} idle=0s | ` +
    "The command is still running; it was detached so you can keep going. " +
    "Read it with bash_poll (bash_stop to end it).\n"
  );
}

/** 可注入的时长/上限（照 `StallWatchOptions` 的模式：线上默认，测试压到毫秒级） */
export interface BashYieldOptions {
  /**
   * 归属（Orbita 会话 id）。同一个 utility 进程跑着多条会话：
   * `bash_list` / `bash_stop` 只该看见、只该停掉自己这条的命令。
   */
  owner?: string;
  /** 签到点毫秒数，默认 `CHECK_IN_MS`(5 分钟)。测试压到几百毫秒 */
  checkInMs?: number;
  /** 会话寿命上限毫秒数，默认 `SESSION_LIFETIME_MS`(4 小时) */
  lifetimeMs?: number;
  /** 同时存活的会话上限，默认 `MAX_SESSIONS`(8) */
  maxSessions?: number;
  /** 命令结束后会话保留多久可查，默认 10 分钟 */
  retentionMs?: number;
}

/**
 * 造一份与 pi 内建 bash 等价、但在签到点交还控制权的 `BashOperations`。
 *
 * `resolveShellConfig` 每次 exec 现调（pi 同款）：用户中途改 `shellPath`，
 * 下一条命令就生效。
 */
export function createObservedBashOperations(
  resolveShellConfig: () => ShellConfig,
  options: BashYieldOptions = {},
): BashOperations {
  const checkInMs = options.checkInMs ?? CHECK_IN_MS;

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

      // 「跑了多久」从 spawn 前一刻算起：签到与寿命都按这个点计
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
        child.pid === undefined ? undefined : { pid: child.pid, spawnedAt: Date.now() };
      if (record !== undefined) observedChildren.set(record.pid, record);

      // 从 spawn 起就写缓冲：签到前的输出也要进会话，第一次 poll 的 tail 才是完整的一段
      const buffer = new TailBuffer();
      let session: BashSession | undefined;
      /** 签到之后不再往 pi 的输出管道写：工具调用已经返回，再写也没人收 */
      let forwardToTool = true;
      let lastDataAt = startedAt;
      let finished = false;
      /** wait 已经观察到结束（含微任务），签到定时器据此不抢在自然结束前 detach */
      let outcomeSeen = false;
      let timedOut = false;
      /** 并发上限拒绝时的文案。杀完命令后当工具错误抛出，模型才知道是「表满了」 */
      let capError: string | undefined;
      let detachResolve: (() => void) | undefined;
      const detached = new Promise<void>((resolve) => {
        detachResolve = resolve;
      });

      const deliver = (chunk: Buffer) => {
        lastDataAt = Date.now();
        if (session === undefined) buffer.append(chunk);
        else session.append(chunk);
        if (forwardToTool) onData(chunk);
      };
      child.stdout?.on("data", deliver);
      child.stderr?.on("data", deliver);

      const waitPromise = waitForChildProcess(child).then((outcome) => {
        outcomeSeen = true;
        return outcome;
      });

      const killTree = () => {
        if (child.pid !== undefined) killProcessTree(child.pid);
      };

      let timeoutHandle: NodeJS.Timeout | undefined;
      const clearDeadline = () => {
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          timeoutHandle = undefined;
        }
      };

      let checkInHandle: NodeJS.Timeout | undefined;
      const clearCheckIn = () => {
        if (checkInHandle !== undefined) {
          clearTimeout(checkInHandle);
          checkInHandle = undefined;
        }
      };

      const onAbort = () => {
        killTree();
      };

      if (timeoutMs !== undefined) {
        timeoutHandle = setTimeout(() => {
          timeoutHandle = undefined;
          // 签到之后超时不再适用：会话的寿命由寿命上限管，不归这次调用
          if (finished || session !== undefined) return;
          timedOut = true;
          killTree();
        }, timeoutMs);
      }

      if (checkInMs > 0 && Number.isFinite(checkInMs)) {
        checkInHandle = setTimeout(() => {
          checkInHandle = undefined;
          // 已经结束 / 已经 abort / 已经超时 / 子进程已退出：都走普通收尾，不制造空会话
          if (finished || outcomeSeen || timedOut || capError !== undefined) return;
          if (signal?.aborted === true) return;
          if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;

          const registered: RegisterSessionResult = registerSession({
            ...(options.owner === undefined ? {} : { owner: options.owner }),
            child,
            buffer,
            startedAt,
            lastDataAt,
            ...(signal === undefined ? {} : { signal }),
            killTree,
            ...(options.lifetimeMs === undefined ? {} : { lifetimeMs: options.lifetimeMs }),
            ...(options.maxSessions === undefined ? {} : { maxSessions: options.maxSessions }),
            ...(options.retentionMs === undefined ? {} : { retentionMs: options.retentionMs }),
          });
          if (!registered.ok) {
            capError = registered.message;
            killTree();
            return;
          }
          session = registered.session;
          // 契约：到期时停掉本次调用的所有定时器。超时不再杀它，寿命交给会话表
          clearDeadline();
          clearCheckIn();
          onData(Buffer.from(detachNotice(session.id), "utf8"));
          forwardToTool = false;
          detachResolve?.();
          // 后台接力：命令自己结束后把退出码记到会话上，之后 poll 才能报 finished
          void waitPromise
            .then((outcome) => session?.end(outcome.exitCode))
            .catch(() => session?.end(null));
        }, checkInMs);
      }

      try {
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }

        const raced = await Promise.race([
          waitPromise.then((outcome) => ({ kind: "end" as const, outcome })),
          detached.then(() => ({ kind: "detached" as const })),
        ]);

        // 签到：工具调用到此为止，进程与会话留在后台。exitCode null 让 pi 按「正常结束」收下
        // 已经累积的输出（其中包含 kind=detached 那一行），而不是报成失败
        if (raced.kind === "detached") return { exitCode: null };

        finished = true;
        // 顺序与 pi 一致：先看 abort，再看 timeout（两者可能同时成立，文案以 abort 为准）
        if (signal?.aborted) throw new Error("aborted");
        if (capError !== undefined) throw new Error(capError);
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode: raced.outcome.exitCode };
      } finally {
        finished = true;
        clearCheckIn();
        clearDeadline();
        if (signal !== undefined) signal.removeEventListener("abort", onAbort);
        // 签到后 child 已移交会话表，由 killAllSessions 收；还在这张表里的只有未签到的
        if (record !== undefined) observedChildren.delete(record.pid);
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
 * 造我们要注册的那个 `bash` 工具定义（名字仍是 `bash`：pi 的 registry 先建内建表、
 * 再按名字合并自定义工具，同名即覆盖，其余内建工具不受影响）。
 *
 * **`commandPrefix` / `shellPath` 必须显式从设置里读出来传**：内建 bash 的这两个值是在
 * pi 装配会话时从 settingsManager 现读的，我们用自己的定义盖掉它，就绕过了那次读取。
 * 漏传 prefix 等于把「非交互前缀」悄悄丢掉（本分支 `shell-env.ts` 专门注入
 * `PAGER=cat` / `GIT_TERMINAL_PROMPT=0` 那串）——登录 shell 的初始化不再执行，
 * 表现为昨天还能跑的命令今天 `command not found`，**而且没有任何报错**。
 */
export function createObservedBashTool(
  cwd: string,
  settings: BashToolSettings,
  options: BashYieldOptions = {},
): ToolDefinition {
  const definition = createBashToolDefinition(cwd, {
    operations: createObservedBashOperations(() => getShellConfig(settings.getShellPath()), options),
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
