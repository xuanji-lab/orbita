/**
 * bash 执行层的测试：差分等价、签到不杀、结束写回（onEnd）、stop / list、寿命、abort、缓冲。
 *
 * 第一条是**差分测试**：换掉内建执行后端后，短命令的退出码与输出必须与 pi 逐字节一致，
 * 否则模型与 UI 看到的东西会悄悄变化。其余各条对应句柄内核的契约；所有时长都靠
 * `BashYieldOptions` 压到毫秒级，不真等 5 分钟 / 4 小时。
 */
import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalBashOperations,
  getShellConfig,
  type BashOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  createObservedBashOperations,
  createObservedBashTool,
  killObservedChildren,
  type BashYieldOptions,
} from "./bash-observe.ts";
import { markCommandTimeoutDeclared } from "./permission.ts";
import {
  createBashHandleTools,
  listSessions,
  RESULT_TAIL_LINES,
  stopSession,
  type BashSessionEnd,
} from "./bash-sessions.ts";

const rmTemp = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 200 });

/**
 * 临时目录收尾：先杀会话里的子进程再删目录。Windows 上子进程没退干净时目录是锁着的
 * （EBUSY），而那正是「会话还活着」的证据——先杀再删，失败才说明真有问题。
 */
async function cleanupTemp(dir: string): Promise<void> {
  killObservedChildren();
  await rmTemp(dir);
}

/**
 * 收结束回调。**结果写回是这套机制的核心**：每条会话的 onEnd 恰好一次，
 * 这里把「等到那一次」做成一个 promise，并留下全部到达记录供「只调一次」断言。
 */
interface EndCollector {
  results: BashSessionEnd[];
  wait(deadlineMs?: number): Promise<BashSessionEnd>;
  onEnd(result: BashSessionEnd): void;
}

function captureEnd(): EndCollector {
  const results: BashSessionEnd[] = [];
  let resolve: ((result: BashSessionEnd) => void) | undefined;
  const wait = (deadlineMs = 8_000): Promise<BashSessionEnd> =>
    new Promise<BashSessionEnd>((fulfil, reject) => {
      if (results.length > 0) {
        fulfil(results[0] as BashSessionEnd);
        return;
      }
      resolve = fulfil;
      const timer = setTimeout(() => reject(new Error("bash session end callback never fired")), deadlineMs);
      timer.unref();
    });
  const waiter = (result: BashSessionEnd): void => {
    results.push(result);
    resolve?.(result);
    resolve = undefined;
  };
  return { wait, results, onEnd: waiter };
}

interface RunResult {
  exitCode: number | null;
  output: string;
}

/** 跑一条命令，把输出按到达顺序拼起来（与 pi 工具里的 OutputAccumulator 同一顺序） */
async function run(
  ops: BashOperations,
  command: string,
  options: { cwd: string; timeout?: number; signal?: AbortSignal },
): Promise<RunResult> {
  const chunks: Buffer[] = [];
  const { exitCode } = await ops.exec(command, options.cwd, {
    onData: (data) => chunks.push(data),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return { exitCode, output: Buffer.concat(chunks).toString("utf8") };
}

async function captureError(action: () => Promise<unknown>): Promise<string> {
  try {
    await action();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the exec to reject");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 轮询到一个「能被 Node 探测到」的真实 pid 落盘为止（命令自己写） */
async function waitForPid(pidFile: string, deadlineMs = 5_000): Promise<number> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (existsSync(pidFile)) {
      const raw = (await readFile(pidFile, "utf8")).trim();
      const pid = Number(raw);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`pid file never appeared: ${pidFile}`);
}

async function waitForDeath(pid: number, deadlineMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

/**
 * 一条「记下自己的原生 pid 然后挂住」的命令。
 *
 * Windows 上 Git Bash 的 `$$` 是 MSYS 内部 pid，与 Node 看到的原生 pid 对不上；
 * 子进程 `node -e` 写的是它自己的原生 pid，被杀树一起带走，探它才作数。
 */
function longRunningWithOwnPid(pidFile: string): string {
  const target = pidFile.replace(/\\/g, "/");
  return (
    `node -e "require('node:fs').writeFileSync(process.argv[1], String(process.pid));` +
    `setTimeout(() => {}, 60000)" "${target}"`
  );
}

/** 记下 pid、每 100ms 吐一行、永不自己结束 */
function tickingWithOwnPid(pidFile: string): string {
  const target = pidFile.replace(/\\/g, "/");
  return (
    `node -e "require('node:fs').writeFileSync(process.argv[1], String(process.pid));` +
    `let i=0;setInterval(()=>{console.log('tick',++i)},100)" "${target}"`
  );
}

function observedOps(options: BashYieldOptions = {}): BashOperations {
  return createObservedBashOperations(() => getShellConfig(), options);
}

function sessionIdOf(output: string): string {
  const match = /kind=detached session=(b\d+)/.exec(output);
  assert.ok(match, `签到结果里应有 sessionId：${output}`);
  return match[1] ?? "";
}

function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => (block.type === "text" ? block.text ?? "" : "")).join("");
}

async function runTool(
  tool: ToolDefinition,
  params: Record<string, unknown>,
): Promise<string> {
  const result = await tool.execute("call-test", params, undefined, undefined, undefined as never);
  return toolText(result as { content: Array<{ type: string; text?: string }> });
}

afterEach(() => {
  killObservedChildren();
});

describe("与 pi 内建执行后端差分（短命令必须一字不变）", () => {
  const commands = ["echo hi", "exit 3", "echo out; echo err >&2", "pwd", "sleep 0.5; echo done"];

  for (const command of commands) {
    test(`命令 ${JSON.stringify(command)} 的退出码与输出一致，且不产生会话`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "orbita-bash-yield-"));
      try {
        const theirs = await run(createLocalBashOperations(), command, { cwd: dir });
        const ours = await run(observedOps({ checkInMs: 60_000 }), command, { cwd: dir });
        assert.equal(ours.exitCode, theirs.exitCode, `退出码：${command}`);
        assert.equal(ours.output, theirs.output, `输出：${command}`);
        assert.equal(listSessions().length, 0, `短命令不该产生会话：${command}`);
      } finally {
        await cleanupTemp(dir);
      }
    });
  }

  test("cwd 不存在：错误文案与 pi 逐字相同", async () => {
    const missing = join(tmpdir(), `orbita-no-such-dir-${process.pid}-${Date.now()}`);
    const piMessage = await captureError(() =>
      createLocalBashOperations().exec("echo hi", missing, { onData: () => {} }),
    );
    const oursMessage = await captureError(() =>
      observedOps().exec("echo hi", missing, { onData: () => {} }),
    );
    assert.equal(oursMessage, piMessage);
    assert.equal(oursMessage, `Working directory does not exist: ${missing}\nCannot execute bash commands.`);
  });

  test("Invalid timeout 文案与 pi 一致", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-yield-"));
    try {
      const message = await captureError(() =>
        observedOps().exec("echo hi", dir, { onData: () => {}, timeout: 0 }),
      );
      assert.equal(message, "Invalid timeout: must be a finite number of seconds");
    } finally {
      await cleanupTemp(dir);
    }
  });
});

describe("超时与中止（签到之前）", () => {
  test("timeout:3 → 抛 timeout:3，且整棵进程树被杀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-yield-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const pending = observedOps({ checkInMs: 60_000 }).exec(longRunningWithOwnPid(pidFile), dir, {
        onData: () => {},
        timeout: 3,
      });
      const rejection = assert.rejects(pending, { message: "timeout:3" });
      const pid = await waitForPid(pidFile, 2_800);
      await rejection;
      assert.ok(await waitForDeath(pid), `超时后 pid ${pid} 仍然活着`);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("外部 abort → 抛 aborted，且整棵进程树被杀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-yield-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const controller = new AbortController();
      const pending = observedOps({ checkInMs: 60_000 }).exec(longRunningWithOwnPid(pidFile), dir, {
        onData: () => {},
        signal: controller.signal,
      });
      const rejection = assert.rejects(pending, { message: "aborted" });
      const pid = await waitForPid(pidFile, 5_000);
      controller.abort();
      await rejection;
      assert.ok(await waitForDeath(pid), `abort 后 pid ${pid} 仍然活着`);
    } finally {
      await cleanupTemp(dir);
    }
  });
});

describe("签到：交还控制权，不杀进程", () => {
  test("到点仍在跑 → exitCode null + kind=detached，进程还活着；bash_stop 能杀掉", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const { exitCode, output } = await run(observedOps({ checkInMs: 600, runId: "runabc12" }), tickingWithOwnPid(pidFile), {
        cwd: dir,
      });
      assert.equal(exitCode, null, "签到应让本次调用以 exitCode null 返回");
      assert.match(output, /\[orbita\] kind=detached session=b\d+ elapsed=\d+s lifetime=\d+s run=runabc12 \| /);
      // 上限跟着交还提示一起来（界面活行的「· 上限」读它）
      assert.match(output, /lifetime=14400s/);
      assert.match(output, /The command is still running; it was detached so you can keep going\./);
      assert.match(output, /written back to the conversation automatically/);
      const id = sessionIdOf(output);
      const pid = await waitForPid(pidFile);
      assert.ok(isAlive(pid), `签到不得杀进程：pid ${pid} 应还活着`);
      assert.equal(listSessions().find((session) => session.id === id)?.status, "running");

      const stopped = await stopSession(id);
      assert.equal(stopped?.status, "killed");
      assert.ok(await waitForDeath(pid), `bash_stop 后 pid ${pid} 仍然活着`);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("签到后会话继续收输出；结束时结果带尾部输出（不需要 poll）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const end = captureEnd();
      const { output } = await run(observedOps({ checkInMs: 500, onSessionEnd: end.onEnd }), tickingWithOwnPid(pidFile), {
        cwd: dir,
      });
      const id = sessionIdOf(output);
      // 签到之后它还在吐字：先等子进程真的起来（负载高时 node 启动可能慢过签到点），
      // 再等至少一个 tick，然后停——结果里的尾部输出要包含签到后的那些行
      await waitForPid(pidFile, 20_000);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const summary = await stopSession(id);
      assert.equal(summary?.status, "killed");
      const result = await end.wait();
      assert.equal(result.id, id);
      assert.equal(result.status, "killed");
      assert.equal(result.cancelled, true);
      assert.ok(result.elapsedMs >= 500, `elapsed 应含签到前那段（实测 ${result.elapsedMs}ms）`);
      assert.match(result.output, /tick \d+/);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("静默命令：签到后不吐字，结果里也没有编造的输出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const end = captureEnd();
      const { output } = await run(
        observedOps({ checkInMs: 300, onSessionEnd: end.onEnd }),
        longRunningWithOwnPid(pidFile),
        { cwd: dir },
      );
      const id = sessionIdOf(output);
      // 用户按停止（与运行时的 bashStop 同一条路）
      const summary = await stopSession(id);
      assert.equal(summary?.status, "killed");
      assert.equal(summary?.endReason, "stop");
      const result = await end.wait();
      assert.equal(result.status, "killed");
      assert.equal(result.endReason, "stop");
      assert.equal(result.output, "");
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("命令在签到后自然结束 → 结果 finished + 退出码 + 输出", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    try {
      const end = captureEnd();
      const command = "node -e \"console.log('tick 1');setTimeout(()=>{console.log('done')},600)\"";
      const { output } = await run(observedOps({ checkInMs: 200, onSessionEnd: end.onEnd }), command, { cwd: dir });
      sessionIdOf(output);
      const result = await end.wait();
      assert.equal(result.status, "finished");
      assert.equal(result.exitCode, 0);
      assert.match(result.output, /tick 1/);
      assert.match(result.output, /done/);
      // 结束回调只该来一次
      await new Promise((resolve) => setTimeout(resolve, 150));
      assert.equal(end.results.length, 1);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("缓冲截断：输出超过 2000 行时结果只留尾部 RESULT_TAIL_LINES 行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    try {
      const end = captureEnd();
      const command =
        "node -e \"for(let i=1;i<=3000;i++)console.log('line '+i);setTimeout(()=>{},3000)\"";
      const { output } = await run(observedOps({ checkInMs: 300, onSessionEnd: end.onEnd }), command, { cwd: dir });
      sessionIdOf(output);
      const result = await end.wait(15_000);
      const lines = result.output.split("\n");
      assert.equal(lines.length, RESULT_TAIL_LINES);
      assert.equal(lines[lines.length - 1], "line 3000");
    } finally {
      await cleanupTemp(dir);
    }
  });
});

describe("会话生命周期", () => {
  test("寿命上限：到点杀树，结果写明 lifetime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-life-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const end = captureEnd();
      const { output } = await run(
        observedOps({ checkInMs: 150, lifetimeMs: 600, onSessionEnd: end.onEnd }),
        tickingWithOwnPid(pidFile),
        { cwd: dir },
      );
      const id = sessionIdOf(output);
      // 全量并行跑时 node 启动可能慢过 5 秒（既有噪声）；这里只放宽「等子进程起来」
      const pid = await waitForPid(pidFile, 20_000);
      const result = await end.wait();
      assert.equal(result.id, id);
      assert.equal(result.status, "killed");
      assert.equal(result.endReason, "lifetime");
      assert.equal(result.cancelled, true);
      assert.match(result.output, /lifetime limit/);
      // 文案写明**实际上限**，不再写死 4 小时（这里是 600ms → 1s）
      assert.match(result.output, /reached its 1s session lifetime limit/);
      assert.ok(await waitForDeath(pid), `寿命上限后 pid ${pid} 仍然活着`);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("会话寿命：模型没声明 timeout → 用设置里的默认寿命（4h）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-life-default-"));
    try {
      const { output } = await run(
        observedOps({ checkInMs: 150, lifetimeMs: 4 * 60 * 60 * 1000, timeoutDeclared: false }),
        tickingWithOwnPid(join(dir, "pid.txt")),
        { cwd: dir },
      );
      const id = sessionIdOf(output);
      const summary = listSessions().find((session) => session.id === id);
      assert.equal(summary?.lifetimeSeconds, 14_400);
      // 交还提示带上同一个上限（界面活行读它）
      assert.match(output, new RegExp(`session=${id} elapsed=\\d+s lifetime=14400s`));
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("会话寿命：显式声明 timeout=7200 → 2h（它自己的上界，不反跑 4h）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-life-2h-"));
    try {
      const { output } = await run(
        observedOps({ checkInMs: 150, lifetimeMs: 4 * 60 * 60 * 1000, timeoutDeclared: true }),
        tickingWithOwnPid(join(dir, "pid.txt")),
        { cwd: dir, timeout: 7_200 },
      );
      const id = sessionIdOf(output);
      assert.equal(listSessions().find((session) => session.id === id)?.lifetimeSeconds, 7_200);
      assert.match(output, new RegExp(`session=${id} elapsed=\\d+s lifetime=7200s`));
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("会话寿命：显式声明 timeout=21600 → 6h", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-life-6h-"));
    try {
      const { output } = await run(
        observedOps({ checkInMs: 150, lifetimeMs: 4 * 60 * 60 * 1000, timeoutDeclared: true }),
        tickingWithOwnPid(join(dir, "pid.txt")),
        { cwd: dir, timeout: 21_600 },
      );
      const id = sessionIdOf(output);
      assert.equal(listSessions().find((session) => session.id === id)?.lifetimeSeconds, 21_600);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("工具路径：闸门补的 3600 不算显式声明，模型自己写的 7200 算", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-life-tool-"));
    const command = tickingWithOwnPid(join(dir, "pid.txt"));
    const tool = createObservedBashTool(
      dir,
      { getShellPath: () => undefined, getShellCommandPrefix: () => undefined },
      { checkInMs: 150, lifetimeMs: 4 * 60 * 60 * 1000 },
    );
    try {
      // ① 闸门补出来的 3600（没有标记）→ 寿命仍是默认 4h
      const injected = { command, timeout: 3_600 };
      const injectedText = await runTool(tool, injected);
      const injectedId = sessionIdOf(injectedText);
      assert.equal(listSessions().find((session) => session.id === injectedId)?.lifetimeSeconds, 14_400);

      // ② 模型显式写 7200（闸门打了「显式声明」标记）→ 寿命 2h
      const declared = { command, timeout: 7_200 };
      markCommandTimeoutDeclared(declared);
      const declaredText = await runTool(tool, declared);
      const declaredId = sessionIdOf(declaredText);
      assert.equal(listSessions().find((session) => session.id === declaredId)?.lifetimeSeconds, 7_200);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("不限并发：同时开 12 个会话全部成功，没有「Too many」", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-many-"));
    try {
      const outputs: string[] = [];
      for (let index = 0; index < 12; index += 1) {
        const { output } = await run(observedOps({ checkInMs: 150 }), "sleep 60", { cwd: dir });
        outputs.push(output);
      }
      const ids = outputs.map((output) => sessionIdOf(output));
      assert.equal(new Set(ids).size, 12);
      assert.equal(listSessions().filter((session) => session.status === "running").length, 12);
      assert.doesNotMatch(outputs.join("\n"), /Too many detached bash sessions/);
    } finally {
      // 整批收掉（12 个 sleep 进程）
      await cleanupTemp(dir);
    }
  });

  test("签到后 abort 原 signal → 会话被杀（用户按停止不留隐形进程）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-abort-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const controller = new AbortController();
      const end = captureEnd();
      const { output } = await run(
        observedOps({ checkInMs: 150, onSessionEnd: end.onEnd }),
        tickingWithOwnPid(pidFile),
        { cwd: dir, signal: controller.signal },
      );
      sessionIdOf(output);
      const pid = await waitForPid(pidFile);
      controller.abort();
      const result = await end.wait();
      assert.equal(result.status, "killed");
      assert.equal(result.endReason, "abort");
      assert.ok(await waitForDeath(pid), `abort 后 pid ${pid} 仍然活着`);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("killObservedChildren 也收得掉签到之后的会话（应用退出不留进程）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-exit-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const { output } = await run(observedOps({ checkInMs: 150 }), longRunningWithOwnPid(pidFile), {
        cwd: dir,
      });
      sessionIdOf(output);
      const pid = await waitForPid(pidFile);
      assert.ok(isAlive(pid), `测试前提不成立：子进程 ${pid} 应该还活着`);
      killObservedChildren();
      assert.ok(await waitForDeath(pid), `退出清理后 pid ${pid} 仍活着`);
      // 退出清理会把整张表清空（进程就要没了，保留 10 分钟没有意义）
      assert.equal(listSessions().length, 0);
    } finally {
      await cleanupTemp(dir);
    }
  });
});

describe("两个句柄工具（poll 已删）", () => {
  function toolByName(name: string): ToolDefinition {
    const tool = createBashHandleTools().find((candidate) => candidate.name === name);
    assert.ok(tool, `缺少工具 ${name}`);
    return tool;
  }

  test("只剩 stop / list：判断权收回，没有 bash_poll", () => {
    assert.deepEqual(
      createBashHandleTools().map((tool) => tool.name),
      ["bash_stop", "bash_list"],
    );
  });

  test("bash_list 空态可读；有会话时列出 id / 状态 / 时长 / 命令", async () => {
    const empty = await runTool(toolByName("bash_list"), {});
    assert.match(empty, /No bash sessions/);

    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-tools-"));
    try {
      const { output } = await run(observedOps({ checkInMs: 150 }), "sleep 60", { cwd: dir });
      const id = sessionIdOf(output);
      const text = await runTool(toolByName("bash_list"), {});
      assert.match(text, new RegExp(`${id} running elapsed=`));
      assert.match(text, /idle=/);
      assert.match(text, /:: sleep 60/);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("bash_stop：未知 id → 可读说明；已知 id → killed + endReason，结果照样写回", async () => {
    const missing = await runTool(toolByName("bash_stop"), { sessionId: "b9999" });
    assert.match(missing, /no session b9999/);

    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-tools-"));
    try {
      const end = captureEnd();
      const { output } = await run(
        observedOps({ checkInMs: 150, onSessionEnd: end.onEnd }),
        longRunningWithOwnPid(join(dir, "pid.txt")),
        { cwd: dir },
      );
      const id = sessionIdOf(output);
      const text = await runTool(toolByName("bash_stop"), { sessionId: id });
      assert.match(text, /status: killed/);
      assert.match(text, /endReason: stopped by bash_stop/);
      const result = await end.wait();
      assert.equal(result.status, "killed");
      assert.equal(result.endReason, "stop");
    } finally {
      await cleanupTemp(dir);
    }
  });
});

describe("接线：自定义 bash 定义与设置", () => {
  test("名字是 bash，且 commandPrefix 真的进到命令里执行了", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-prefix-"));
    try {
      const tool = createObservedBashTool(
        dir,
        {
          getShellPath: () => undefined,
          getShellCommandPrefix: () => "export ORBITA_BASH_PREFIX_PROBE=prefix-ok",
        },
        { checkInMs: 60_000 },
      );
      assert.equal(tool.name, "bash");
      const text = await runTool(tool, { command: "echo $ORBITA_BASH_PREFIX_PROBE" });
      assert.match(text, /prefix-ok/);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("工具包装把 toolCallId 绑到交还的会话上（结果才能挂回同一行）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-bind-"));
    try {
      const tool = createObservedBashTool(
        dir,
        { getShellPath: () => undefined, getShellCommandPrefix: () => undefined },
        { checkInMs: 150 },
      );
      const result = await tool.execute(
        "call-bind-1",
        { command: "sleep 60" },
        undefined,
        undefined,
        undefined as never,
      );
      const id = sessionIdOf(toolText(result as { content: Array<{ type: string; text?: string }> }));
      const session = listSessions().find((candidate) => candidate.id === id);
      assert.equal(session?.command, "sleep 60");
      assert.equal(session?.status, "running");
      assert.equal(session?.toolCallId, "call-bind-1");
    } finally {
      await cleanupTemp(dir);
    }
  });
});
