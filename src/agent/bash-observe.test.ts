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

/**
 * 一条「记下自己的 pid、每 100ms 吐一行、永不自己结束」的命令。
 * 到点延长的测试要同时满足两个条件：有稳定输出（证据一成立），以及被杀后能被探测到死亡。
 */
function tickingWithOwnPid(pidFile: string): string {
  const target = pidFile.replace(/\\/g, "/");
  return (
    `node -e "require('node:fs').writeFileSync(process.argv[1], String(process.pid));` +
    `let i=0;setInterval(()=>{console.log('tick',++i)},100)" "${target}"`
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

describe("停滞提示（只提示、绝不杀）", () => {
  /** 阈值压到毫秒级：线上是 30s 静默 + 60s 确认窗口，测试等不起，判据本身由纯函数测试覆盖 */
  const fastStall = { quietMs: 200, confirmMs: 400, cpuDeltaMs: 100 };

  test("合法静默也会提示，这是可接受代价：sleep 不吐字、CPU 也不涨", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-stall-"));
    try {
      const chunks: Buffer[] = [];
      const ops = createObservedBashOperations(() => getShellConfig(), fastStall);
      // 真正在跑、只是不吐字（sleep 的形态；用 node 是为了跨平台且与 shell 种类无关）
      const command = 'node -e "setTimeout(() => {}, 6000)"';
      const startedAt = Date.now();
      const { exitCode } = await ops.exec(command, dir, { onData: (chunk) => chunks.push(chunk) });
      const elapsed = Date.now() - startedAt;
      const output = Buffer.concat(chunks).toString("utf8");
      assert.equal(exitCode, 0, "提示不得改变退出码——本 PR 不杀任何进程");
      assert.match(output, /\[orbita\] 本命令有 \d+ 秒无输出/);
      assert.match(output, /CPU 增长 < 100ms/);
      assert.ok(elapsed >= 5_000, `命令必须真的跑完（实测 ${elapsed}ms）`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("一直在吐字的命令不提示（静默计时随每块输出复位）", async () => {    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-stall-"));
    try {
      const ops = createObservedBashOperations(() => getShellConfig(), fastStall);
      const command =
        'node -e "let i=0;const t=setInterval(()=>{console.log(\'tick\',++i);if(i>=10){clearInterval(t)}},150)"';
      const { output, exitCode } = await run(ops, command, { cwd: dir });
      assert.equal(exitCode, 0);
      assert.match(output, /tick 10/);
      assert.doesNotMatch(output, /\[orbita\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("CPU 在跑的静默命令（死循环式忙等）不提示——这就是两个信号必须联合的原因", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-stall-"));
    try {
      const ops = createObservedBashOperations(() => getShellConfig(), fastStall);
      // 不吐字、但一直在烧 CPU：只看「无输出」会误报，加上 CPU 增量才不会
      const command = 'node -e "const t=Date.now();while(Date.now()-t<8000){}"';
      const startedAt = Date.now();
      const { output, exitCode } = await run(ops, command, { cwd: dir });
      assert.equal(exitCode, 0);
      assert.ok(Date.now() - startedAt >= 7_000, "命令真的跑满了 8 秒");
      assert.doesNotMatch(output, /\[orbita\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("到点决策：有进展就延长，没进展照旧杀", () => {
  /**
   * 线上是 10 分钟一档 / 最多两次 / 60 分钟天花板，测试等不起，全部压到毫秒级。
   * 写法与 `fastStall` 同一个模式：只动阈值，不动判据。
   */
  const fastExtend = { extendByMs: 1_000, maxExtensions: 5, recentOutputMs: 5_000 };

  test("有进展：一直吐字 → 不抛 timeout、退出码 0，输出里有延长记录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-extend-"));
    try {
      // 32 拍 ≈ 3.2 秒：初始超时 1 秒，靠不断延长活到自然结束
      const command =
        'node -e "let i=0;const t=setInterval(()=>{console.log(\'tick\',++i);if(i>=32){clearInterval(t)}},100)"';
      const ops = createObservedBashOperations(() => getShellConfig(), {}, {
        ...fastExtend,
        hardMaxMs: 10_000,
        // 输出证据已经成立，不应再花一次进程表快照；真采样就返回「判不了」
        sampleCpuMs: async () => null,
      });
      const startedAt = Date.now();
      const { exitCode, output } = await run(ops, command, { cwd: dir, timeout: 1 });
      const elapsed = Date.now() - startedAt;
      assert.equal(exitCode, 0, `延长不是失败：命令自己跑完了（实测 ${elapsed}ms）`);
      assert.ok(elapsed >= 3_000, `必须真的活过初始的 1 秒（实测 ${elapsed}ms）`);
      assert.match(output, /tick 32/);
      assert.match(
        output,
        /\[orbita\] 已到 1 秒上限，但命令仍在输出\/消耗 CPU，延长至 2 秒（第 1\/5 次）/,
      );
    } finally {
      await rmTemp(dir);
    }
  });

  test("没进展：不吐字、CPU 也不涨 → 照旧杀，秒数是实际跑过的时长", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-extend-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const chunks: Buffer[] = [];
      const ops = createObservedBashOperations(() => getShellConfig(), {}, {
        ...fastExtend,
        // 恒定值 = 没有增长：这正是「真卡死」在 CPU 上的样子
        sampleCpuMs: async () => 0,
      });
      const pending = ops.exec(longRunningWithOwnPid(pidFile), dir, {
        onData: (chunk) => chunks.push(chunk),
        timeout: 1,
      });
      // 先挂断言再等 pid：不挂的话 1 秒后的拒绝会变成 unhandled rejection
      const rejection = assert.rejects(pending, { message: "timeout:1" });
      const pid = await waitForPid(pidFile, 2_800);
      await rejection;
      assert.ok(await waitForDeath(pid), `超时后 pid ${pid} 仍然活着`);
      assert.doesNotMatch(Buffer.concat(chunks).toString("utf8"), /\[orbita\] 已到/);
    } finally {
      await rmTemp(dir);
    }
  });

  test("次数上限：maxExtensions=1，延长一次后到点仍被杀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-extend-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const ops = createObservedBashOperations(() => getShellConfig(), {}, {
        extendByMs: 1_000,
        maxExtensions: 1,
        recentOutputMs: 5_000,
        hardMaxMs: 60_000,
        sampleCpuMs: async () => null,
      });
      const chunks: Buffer[] = [];
      const pending = ops.exec(tickingWithOwnPid(pidFile), dir, {
        onData: (chunk) => chunks.push(chunk),
        timeout: 1,
      });
      // 1s 到点延长到 2s，2s 到点次数已用完 → 杀，报实际时长 2 秒
      const rejection = assert.rejects(pending, { message: "timeout:2" });
      const pid = await waitForPid(pidFile, 2_800);
      await rejection;
      assert.ok(await waitForDeath(pid), `次数用完后 pid ${pid} 仍然活着`);
      const output = Buffer.concat(chunks).toString("utf8");
      assert.match(output, /延长至 2 秒（第 1\/1 次）/);
      assert.doesNotMatch(output, /第 2\/1 次/);
    } finally {
      await rmTemp(dir);
    }
  });

  test("天花板：HARD_MAX 封顶，一直有输出也照样到点被杀", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-extend-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const ops = createObservedBashOperations(() => getShellConfig(), {}, {
        // 一档 60 秒、次数几乎无限：只有天花板能拦住它
        extendByMs: 60_000,
        maxExtensions: 100,
        recentOutputMs: 5_000,
        hardMaxMs: 2_400,
        sampleCpuMs: async () => null,
      });
      const chunks: Buffer[] = [];
      const startedAt = Date.now();
      const pending = ops.exec(tickingWithOwnPid(pidFile), dir, {
        onData: (chunk) => chunks.push(chunk),
        timeout: 1,
      });
      // 1s 到点被延长到天花板（2.4s）为止，此后下一次到点直接杀
      const rejection = assert.rejects(pending, { message: "timeout:2" });
      const pid = await waitForPid(pidFile, 2_000);
      await rejection;
      const elapsed = Date.now() - startedAt;
      assert.ok(elapsed >= 2_300, `必须跑到天花板才被杀（实测 ${elapsed}ms）`);
      assert.ok(await waitForDeath(pid), `到达天花板后 pid ${pid} 仍然活着`);
      // 延长目标被天花板截住：报的是 2 秒，而不是「当前 + 60 秒」
      assert.match(Buffer.concat(chunks).toString("utf8"), /延长至 2 秒（第 1\/100 次）/);
    } finally {
      await rmTemp(dir);
    }
  });

  test("abort 与到点同时发生 → aborted 优先，不看证据", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-extend-"));
    const pidFile = join(dir, "pid.txt");
    try {
      const controller = new AbortController();
      const ops = createObservedBashOperations(() => getShellConfig(), {}, {
        ...fastExtend,
        hardMaxMs: 10_000,
        sampleCpuMs: async () => null,
      });
      const pending = ops.exec(tickingWithOwnPid(pidFile), dir, {
        onData: () => {},
        timeout: 1,
        signal: controller.signal,
      });
      const rejection = assert.rejects(pending, { message: "aborted" });
      const pid = await waitForPid(pidFile, 2_000);
      // 掐在到点那一刻：无论谁先跑，文案都必须是 aborted
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      controller.abort();
      await rejection;
      assert.ok(await waitForDeath(pid), `abort 后 pid ${pid} 仍然活着`);
    } finally {
      await rmTemp(dir);
    }
  });

  test("没有新输出、但进程树还在涨 CPU → 仍延长（证据二）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orbita-bash-extend-"));
    try {
      let sampled = 0;
      const sampleCpuMs = async (): Promise<number | null> => {
        sampled += 400;
        return sampled;
      };
      const ops = createObservedBashOperations(
        () => getShellConfig(),
        // 快速停滞观察：它在静默 100ms/300ms 时先采两次，正好给延长决策留下基线
        { quietMs: 100, confirmMs: 200, sampleCpuMs },
        { extendByMs: 1_500, maxExtensions: 5, recentOutputMs: 200, hardMaxMs: 10_000, sampleCpuMs },
      );
      // 完全静默地跑 2.5 秒：输出证据不成立，只有 CPU 在涨
      const { exitCode, output } = await run(ops, 'node -e "setTimeout(() => {}, 2500)"', {
        cwd: dir,
        timeout: 1,
      });
      assert.equal(exitCode, 0, "靠 CPU 证据延长，命令自己跑完后退出码仍是 0");
      assert.match(output, /\[orbita\] 已到 1 秒上限/);
      // CPU 一直在涨 → 停滞判据不成立，不该出现「本命令有 N 秒无输出」的提示
      assert.doesNotMatch(output, /本命令有 \d+ 秒无输出/);
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
