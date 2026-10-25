/**
 * bash 执行层的测试：差分等价、签到不杀、poll / stop / list、寿命与并发上限、abort、缓冲。
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
import {
  createBashHandleTools,
  listSessions,
  pollSession,
  stopSession,
  type SessionSnapshot,
} from "./bash-sessions.ts";

const rmTemp = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

/**
 * 临时目录收尾：先杀会话里的子进程再删目录。Windows 上子进程没退干净时目录是锁着的
 * （EBUSY），而那正是「会话还活着」的证据——先杀再删，失败才说明真有问题。
 */
async function cleanupTemp(dir: string): Promise<void> {
  killObservedChildren();
  await rmTemp(dir);
}

/** poll 到满足条件为止。模型自己也是这么用的：有新输出就先看一眼，再继续等 */
async function pollUntil(
  id: string,
  done: (snapshot: SessionSnapshot) => boolean,
  deadlineMs = 5_000,
): Promise<SessionSnapshot> {
  const deadline = Date.now() + deadlineMs;
  let snapshot = await pollSession(id, 300);
  while (!done(snapshot) && Date.now() < deadline) {
    snapshot = await pollSession(id, 200);
  }
  return snapshot;
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
      const { exitCode, output } = await run(observedOps({ checkInMs: 600 }), tickingWithOwnPid(pidFile), {
        cwd: dir,
      });
      assert.equal(exitCode, null, "签到应让本次调用以 exitCode null 返回");
      assert.match(output, /\[orbita\] kind=detached session=b\d+ idle=0s \| /);
      assert.match(output, /The command is still running; it was detached so you can keep going\./);
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

  test("签到后会话继续收输出，poll 有新输出就提前返回", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const { output } = await run(observedOps({ checkInMs: 500 }), tickingWithOwnPid(pidFile), { cwd: dir });
      const id = sessionIdOf(output);
      const startedAt = Date.now();
      const snapshot = await pollSession(id, 5_000);
      const elapsed = Date.now() - startedAt;
      assert.ok(snapshot.newLines > 0, `应看到签到之后的新行（newLines=${snapshot.newLines}）`);
      assert.match(snapshot.tail, /tick \d+/);
      assert.ok(elapsed < 2_500, `有新输出应提前返回（实测 ${elapsed}ms）`);
      assert.equal(snapshot.status, "running");
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("静默命令：poll 等满，idleSeconds 随时间增长", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const { output } = await run(observedOps({ checkInMs: 300 }), longRunningWithOwnPid(pidFile), { cwd: dir });
      const id = sessionIdOf(output);
      const startedAt = Date.now();
      const snapshot = await pollSession(id, 400);
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= 330, `没有新输出应等满 400ms（实测 ${elapsed}ms）`);
      assert.equal(snapshot.status, "running");
      assert.equal(snapshot.newLines, 0);
      assert.ok(snapshot.idleMs >= 600, `idle 应包含签到前的时间（实测 ${snapshot.idleMs}ms）`);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("命令在签到后自然结束 → poll 返回 finished + 退出码", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    try {
      const command = 'node -e "console.log(\'tick 1\');setTimeout(()=>{console.log(\'done\')},600)"';
      const { output } = await run(observedOps({ checkInMs: 200 }), command, { cwd: dir });
      const id = sessionIdOf(output);
      const snapshot = await pollUntil(id, (current) => current.status !== "running");
      assert.equal(snapshot.status, "finished");
      assert.equal(snapshot.exitCode, 0);
      assert.match(snapshot.tail, /done/);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("缓冲截断：输出超过 2000 行后 poll 的 tail 只给最后 40 行", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-detach-"));
    try {
      const command =
        'node -e "for(let i=1;i<=3000;i++)console.log(\'line \'+i);setTimeout(()=>{},60000)"';
      const { output } = await run(observedOps({ checkInMs: 900 }), command, { cwd: dir });
      const id = sessionIdOf(output);
      // 全量测试并行跑时 node 的启动可能慢过签到点：签到后输出仍会继续进同一个缓冲，
      // 所以用「tail 里出现最后一行」作为判据，而不是赌 900ms 足够
      const snapshot = await pollUntil(id, (current) => current.tail.includes("line 3000"), 10_000);
      const lines = snapshot.tail.split("\n");
      assert.equal(lines.length, 40);
      assert.equal(lines[0], "line 2961");
      assert.equal(lines[39], "line 3000");
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
      const { output } = await run(
        observedOps({ checkInMs: 150, lifetimeMs: 600 }),
        tickingWithOwnPid(pidFile),
        { cwd: dir },
      );
      const id = sessionIdOf(output);
      const pid = await waitForPid(pidFile);
      const snapshot = await pollUntil(id, (current) => current.status === "killed");
      assert.equal(snapshot.status, "killed");
      assert.equal(snapshot.endReason, "lifetime");
      assert.match(snapshot.tail, /kind=cap reason=lifetime/);
      assert.match(snapshot.tail, /lifetime limit/);
      assert.ok(await waitForDeath(pid), `寿命上限后 pid ${pid} 仍然活着`);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("并发上限：第二个会话明确失败，命令被杀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-cap-"));
    const firstPid = join(dir, "first.txt");
    const secondPid = join(dir, "second.txt");
    try {
      const options: BashYieldOptions = { checkInMs: 150, maxSessions: 1 };
      const first = await run(observedOps(options), longRunningWithOwnPid(firstPid), { cwd: dir });
      assert.match(first.output, /kind=detached/);

      const message = await captureError(() =>
        observedOps(options).exec(longRunningWithOwnPid(secondPid), dir, { onData: () => {} }),
      );
      assert.match(message, /Too many detached bash sessions/);
      assert.match(message, /max 1/);
      assert.equal(listSessions().filter((session) => session.status === "running").length, 1);

      const second = await waitForPid(secondPid);
      assert.ok(await waitForDeath(second), `被并发上限拒绝的命令应被杀掉（pid ${second}）`);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("签到后 abort 原 signal → 会话被杀（用户按停止不留隐形进程）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-abort-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const controller = new AbortController();
      const { output } = await run(observedOps({ checkInMs: 150 }), tickingWithOwnPid(pidFile), {
        cwd: dir,
        signal: controller.signal,
      });
      const id = sessionIdOf(output);
      const pid = await waitForPid(pidFile);
      controller.abort();
      const snapshot = await pollSession(id, 3_000);
      assert.equal(snapshot.status, "killed");
      assert.equal(snapshot.endReason, "abort");
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
      const id = sessionIdOf(output);
      const pid = await waitForPid(pidFile);
      assert.ok(isAlive(pid), `测试前提不成立：子进程 ${pid} 应该还活着`);
      killObservedChildren();
      assert.ok(await waitForDeath(pid), `退出清理后 pid ${pid} 仍活着`);
      // 退出清理会把整张表清空（进程就要没了，保留 10 分钟没有意义）
      assert.equal(listSessions().length, 0);
      assert.equal((await pollSession(id, 10)).status, "too-old");
    } finally {
      await cleanupTemp(dir);
    }
  });
});

describe("三个句柄工具", () => {
  function toolByName(name: string): ToolDefinition {
    const tool = createBashHandleTools().find((candidate) => candidate.name === name);
    assert.ok(tool, `缺少工具 ${name}`);
    return tool;
  }

  test("bash_list 空态可读；有会话时列出 id / 状态 / 时长", async () => {
    const empty = await runTool(toolByName("bash_list"), {});
    assert.match(empty, /No bash sessions/);

    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-tools-"));
    try {
      const { output } = await run(observedOps({ checkInMs: 150 }), 'node -e "setTimeout(()=>{},60000)"', {
        cwd: dir,
      });
      const id = sessionIdOf(output);
      const text = await runTool(toolByName("bash_list"), {});
      assert.match(text, new RegExp(`${id} running elapsed=`));
      assert.match(text, /idle=/);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("bash_poll：未知 id → too-old 的整句说明", async () => {
    const text = await runTool(toolByName("bash_poll"), { sessionId: "b9999", waitSeconds: 1 });
    assert.match(text, /status: too-old/);
    assert.match(text, /finished more than 10 minutes ago/);
  });

  test("bash_poll：返回 status / exitCode / idleSeconds / +N lines / tail", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-tools-"));
    try {
      const { output } = await run(observedOps({ checkInMs: 150 }), tickingWithOwnPid(join(dir, "pid.txt")), {
        cwd: dir,
      });
      const id = sessionIdOf(output);
      const text = await runTool(toolByName("bash_poll"), { sessionId: id, waitSeconds: 2 });
      assert.match(text, /status: running/);
      assert.match(text, /session: b\d+/);
      assert.match(text, /exitCode: none/);
      assert.match(text, /idleSeconds: \d+/);
      assert.match(text, /\+\d+ lines since last poll/);
      assert.match(text, /tail \(last 40 lines\):/);
    } finally {
      await cleanupTemp(dir);
    }
  });

  test("bash_stop：未知 id → 可读说明；已知 id → killed + endReason", async () => {
    const missing = await runTool(toolByName("bash_stop"), { sessionId: "b9999" });
    assert.match(missing, /no session b9999/);

    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-tools-"));
    try {
      const { output } = await run(observedOps({ checkInMs: 150 }), longRunningWithOwnPid(join(dir, "pid.txt")), {
        cwd: dir,
      });
      const id = sessionIdOf(output);
      const text = await runTool(toolByName("bash_stop"), { sessionId: id });
      assert.match(text, /status: killed/);
      assert.match(text, /endReason: stopped by bash_stop/);
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
});
