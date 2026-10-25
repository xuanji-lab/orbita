/**
 * bash 观察层（./bash-observe.ts）的测试。
 *
 * 这个 PR 唯一有真实回归风险的地方是「换掉了内建执行后端」：超时文案、abort 文案、
 * 退出码、输出内容任何一处漂移，模型或 UI 看到的东西就变了，而且不会报错。
 * 所以第一条是**差分测试**——同一批命令分别喂 pi 的 `createLocalBashOperations()`
 * 与我们这份，比退出码与累计输出。第二条是「唯一新增行为」：后代存活提示。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalBashOperations,
  getShellConfig,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import { createObservedBashOperations, createObservedBashTool, killObservedChildren } from "./bash-observe.ts";

/**
 * 清理临时目录。Windows 上子进程可能还握着目录句柄，直接 `rm` 会偶发 EBUSY
 * （全量测试里撞过一次，单跑复现不出来）。重试几次即可——它不掩盖真实失败，
 * 只是把「句柄还没释放」和「目录真删不掉」区分开。
 */
const rmTemp = (dir: string) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

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
 * 一条「会记下自己的原生 pid 然后挂住」的命令。
 *
 * 为什么要借 node 报 pid：Windows 上 Git Bash 的 `$$` 是 MSYS 内部 pid，与 Node 看到的
 * 原生 pid 对不上（实测 spawn pid 102448 / `$$` 180066），拿它探测死亡永远判「死」。
 * 子进程 `node -e` 写的是它自己的原生 pid，被杀树一起带走，探它才作数。
 */
function longRunningWithOwnPid(pidFile: string): string {
  const target = pidFile.replace(/\\/g, "/");
  return (
    `node -e "require('node:fs').writeFileSync(process.argv[1], String(process.pid));` +
    `setTimeout(() => {}, 60000)" "${target}"`
  );
}

const observedOps = (): BashOperations => createObservedBashOperations(() => getShellConfig());

describe("与 pi 内建执行后端差分", () => {
  // 覆盖：正常退出、非零退出、stderr 混流、路径、慢命令（跨过 100ms 宽限）
  const commands = ["echo hi", "exit 3", "echo out; echo err >&2", "pwd", "sleep 0.5; echo done"];

  for (const command of commands) {
    test(`命令 ${JSON.stringify(command)} 的退出码与输出一致`, async () => {
      const cwd = process.cwd();
      const theirs = await run(createLocalBashOperations(), command, { cwd });
      const ours = await run(observedOps(), command, { cwd });
      assert.equal(ours.exitCode, theirs.exitCode, `退出码：${command}`);
      assert.equal(ours.output, theirs.output, `输出：${command}`);
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
});

describe("超时与中止", () => {
  test("timeout:3 → 抛 timeout:3，且整棵进程树被杀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-observe-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const pending = observedOps().exec(longRunningWithOwnPid(pidFile), dir, {
        onData: () => {},
        timeout: 3,
      });
      // 先挂上断言再等 pid：不挂的话 1 秒后的拒绝会变成 unhandled rejection
      const rejection = assert.rejects(pending, { message: "timeout:3" });
      // 2.8s 等 pid、3s 才被杀：原先是 900ms 等 pid / 1s 被杀，机器一忙就必挂（真机上撞过两次）
      const pid = await waitForPid(pidFile, 2_800);
      await rejection;
      assert.ok(await waitForDeath(pid), `超时后 pid ${pid} 仍然活着`);
    } finally {
      await rmTemp(dir);
    }
  });

  test("外部 abort → 抛 aborted，且整棵进程树被杀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-observe-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const controller = new AbortController();
      const pending = observedOps().exec(longRunningWithOwnPid(pidFile), dir, {
        onData: () => {},
        signal: controller.signal,
      });
      const rejection = assert.rejects(pending, { message: "aborted" });
      // 等 pid 落地（~150ms）再 abort，与「200ms 后 abort」同一量级；先拿到 pid 才断言得了死亡
      const pid = await waitForPid(pidFile, 5_000);
      controller.abort();
      await rejection;
      assert.ok(await waitForDeath(pid), `abort 后 pid ${pid} 仍然活着`);
    } finally {
      await rmTemp(dir);
    }
  });

  test("Invalid timeout 文案与 pi 一致", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-observe-"));
    try {
      const message = await captureError(() =>
        observedOps().exec("echo hi", dir, { onData: () => {}, timeout: 0 }),
      );
      assert.equal(message, "Invalid timeout: must be a finite number of seconds");
    } finally {
      await rmTemp(dir);
    }
  });
});

describe("后代存活提示（本 PR 唯一新增行为）", () => {
  test("命令早退、后台后代握着管道 → 输出带提示，且晚到输出不在结果里", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-observe-"));
    try {
      const { output } = await run(observedOps(), "bash -c '(sleep 2; echo LATE_OUTPUT) & echo early'", {
        cwd: dir,
      });
      assert.match(output, /early/);
      assert.match(output, /\[orbita\] 命令已返回，但仍有后代进程在运行/);
      // 如实记录现状：这一版**不修**晚到输出丢失，只是告诉模型「还有东西在跑」
      assert.doesNotMatch(output, /LATE_OUTPUT/);
    } finally {
      await rmTemp(dir);
    }
  });

  test("正常命令不带提示", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-observe-"));
    try {
      const { output } = await run(observedOps(), "echo hi", { cwd: dir });
      assert.equal(output, "hi\n");
      assert.doesNotMatch(output, /\[orbita\]/);
    } finally {
      await rmTemp(dir);
    }
  });

  test("killObservedChildren 收得掉还在跑的命令（应用退出不留占端口的进程）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-observe-"));
    const pidFile = join(dir, "child.pid");
    try {
      // 前台长命令：它就是「应用退出时还挂着的那个 bash」的形态
      const pending = observedOps().exec(longRunningWithOwnPid(pidFile), dir, { onData: () => {} });
      const pid = await waitForPid(pidFile);
      assert.ok(isAlive(pid), `测试前提不成立：子进程 ${pid} 应该还活着`);
      killObservedChildren();
      const { exitCode } = await pending;
      assert.notEqual(exitCode, 0);
      assert.ok(await waitForDeath(pid), `killObservedChildren 之后子进程 ${pid} 仍活着`);
    } finally {
      await rmTemp(dir);
    }
  });
});

describe("接线：自定义 bash 定义不丢设置里的 prefix", () => {
  /**
   * pi 内建 bash 的 `commandPrefix` 是会话装配时从 settingsManager 现读的；
   * 我们用自己的定义按名字覆盖它，就绕过了那次读取。漏传不会有任何报错，
   * 只会表现为登录 shell 的初始化突然不执行（命令找不到）——这条测试守的就是它。
   */
  test("commandPrefix 真的进到命令里执行了", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-observe-"));
    try {
      const tool = createObservedBashTool(dir, {
        getShellPath: () => undefined,
        getShellCommandPrefix: () => "export ORBITA_BASH_PREFIX_PROBE=prefix-ok",
      });
      assert.equal(tool.name, "bash");
      const result = await tool.execute(
        "call-prefix",
        { command: "echo $ORBITA_BASH_PREFIX_PROBE" },
        undefined,
        undefined,
        undefined as never,
      );
      const text = result.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("");
      assert.match(text, /prefix-ok/);
    } finally {
      await rmTemp(dir);
    }
  });
});
