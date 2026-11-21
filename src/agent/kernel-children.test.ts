import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KERNEL_CHILD_MARK, KERNEL_RUN_ENV, MSYS_REAP_SCRIPT, kernelChildTag, kernelRunMark, msysReapEnv, reapKernelChildren, reapMsysProcesses, tagShellCommand, taggedProcesses, type ReapRunner } from "./kernel-children.ts";

describe("kernel-children：按环境变量标签认 kernel 拉起的 shell 子进程", () => {
  it("只认挂着这个标签的行，自己除外；不同库目录的标签不同", () => {
    const tag = kernelChildTag("/a/durable");
    assert.notEqual(tag, kernelChildTag("/b/durable"));
    const ps = [`  100   100 /bin/bash -c sleep 30 ${KERNEL_CHILD_MARK}=${tag} PATH=/bin`, `  200   200 /bin/bash ${KERNEL_CHILD_MARK}=${kernelChildTag("/b/durable")}`, `  300   100 sleep 30 ${KERNEL_CHILD_MARK}=${tag}`, `  42   42 node ${KERNEL_CHILD_MARK}=${tag}`].join("\n");
    assert.deepEqual(taggedProcesses(ps, tag, 42), [
      { pid: 100, pgid: 100 },
      { pid: 300, pgid: 100 },
    ]);
  });

  it("打标签不改退出码；macOS：带标签的 shell 连进程组被整组杀掉（孙进程一起），别的进程不动", { skip: process.platform !== "darwin" }, async () => {
    const tag = kernelChildTag(`/tmp/orbita-reap-${process.pid}-${Date.now()}`);
    const exit = await new Promise<number | null>((resolve) => spawn("/bin/bash", ["-c", tagShellCommand("exit 7", tag)]).on("exit", resolve));
    assert.equal(exit, 7);
    // 与 pi 的 bash 工具同形：detached（shell 是进程组长），命令打了标签；最后一条是 sleep（不打 trap 时 bash 会 exec 掉它）
    const child = spawn("/bin/bash", ["-c", tagShellCommand("sleep 30 & sleep 30", tag)], { detached: true, stdio: "ignore" });
    const bystander = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const group = child.pid as number;
    const inGroup = (): string[] =>
      execFileSync("ps", ["-A", "-o", "pid=,pgid="])
        .toString()
        .split("\n")
        .filter((line) => Number(line.trim().split(/\s+/)[1]) === group);
    assert.ok(inGroup().length >= 3, "shell 与两个 sleep 都在组里");
    assert.equal(await reapKernelChildren(tag), 1, "认出带标签的那个 shell");
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(inGroup(), [], "整组（含孙进程 sleep）都没了");
    assert.equal(bystander.exitCode, null, "没挂标签的进程没被碰");
    bystander.kill();
    child.unref();
  });
});

describe("kernel-children：Windows 经 MSYS 的 /proc 收割（平台注入）", () => {
  it("运行标记：给运行 id 是这一次，不给是这个库目录的全部", () => {
    assert.equal(kernelRunMark("orbita-ab"), `${KERNEL_RUN_ENV}=orbita-ab.`);
    assert.equal(kernelRunMark("orbita-ab", "r1"), `${KERNEL_RUN_ENV}=orbita-ab.r1`);
  });

  it("孤儿善后：用给定的 bash 跑收割脚本，按「标签.」前缀与 EXIT trap 标签找；继承来的运行标记不带进脚本的环境", async () => {
    const calls: { program: string; args: readonly string[]; env: Record<string, string> }[] = [];
    const run: ReapRunner = (program, args, env, done) => {
      calls.push({ program, args, env });
      done(null, "3\n");
    };
    const saved = process.env[KERNEL_RUN_ENV];
    process.env[KERNEL_RUN_ENV] = "orbita-other.r9";
    try {
      const count = await reapKernelChildren("orbita-ab", { platform: "win32", shell: "C:\\Program Files\\Git\\bin\\bash.exe", run });
      assert.equal(count, 3);
    } finally {
      if (saved === undefined) delete process.env[KERNEL_RUN_ENV];
      else process.env[KERNEL_RUN_ENV] = saved;
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.program, "C:\\Program Files\\Git\\bin\\bash.exe");
    assert.deepEqual(calls[0]?.args, ["-c", MSYS_REAP_SCRIPT]);
    assert.equal(calls[0]?.env["ORBITA_REAP_ENV"], `${KERNEL_RUN_ENV}=orbita-ab.`);
    assert.equal(calls[0]?.env["ORBITA_REAP_CMD"], `${KERNEL_CHILD_MARK}=orbita-ab`);
    assert.equal(calls[0]?.env[KERNEL_RUN_ENV], undefined);
  });

  it("停一次运行：只按这一次的运行标记找，不带命令行标签", () => {
    const env = msysReapEnv({ PATH: "/usr/bin" }, { env: kernelRunMark("orbita-ab", "r1") });
    assert.equal(env["ORBITA_REAP_ENV"], `${KERNEL_RUN_ENV}=orbita-ab.r1`);
    assert.equal(env["ORBITA_REAP_CMD"], undefined);
    assert.equal(env["PATH"], "/usr/bin");
  });

  it("收割脚本起不来 / 输出不是数字：当 0，不抛", async () => {
    assert.equal(await reapMsysProcesses("bash", { env: "x" }, (_p, _a, _e, done) => done(new Error("ENOENT"), "")), 0);
    assert.equal(await reapMsysProcesses("bash", { env: "x" }, (_p, _a, _e, done) => done(null, "oops")), 0);
  });

  it("Windows 上找不到 bash：返回 0；Linux：返回 0（不做）", { skip: process.platform === "win32" }, async () => {
    // 非 Windows 机器上 findBash("win32") 找不到 Git Bash（没有 ProgramFiles，PATH 里也没有 bash.exe）
    assert.equal(await reapKernelChildren("orbita-ab", { platform: "win32", run: () => assert.fail("不该起脚本") }), 0);
    assert.equal(await reapKernelChildren("orbita-ab", { platform: "linux", run: () => assert.fail("不该起脚本") }), 0);
  });

  it(
    "收割脚本本身（在本机 bash 里真跑，假 /proc 指向真进程）：environ 前缀命中、cmdline 片段命中的杀掉，别的运行与无关进程不动",
    { skip: process.platform === "win32" },
    async () => {
      const proc = mkdtempSync(join(tmpdir(), "orbita-fake-proc-"));
      const spawnSleep = () => spawn("/bin/sleep", ["30"], { stdio: "ignore" });
      const target = spawnSleep(); // 这一次运行的子孙（environ 里有标记，像 exec 出来的 sleep.exe）
      const top = spawnSleep(); // 顶层 shell（environ 读不到，命令行里有 EXIT trap 标签）
      const otherRun = spawnSleep(); // 同一库目录、别的运行
      const bystander = spawnSleep(); // 无关进程
      const entry = (pid: number | undefined, files: Record<string, string>): void => {
        const dir = join(proc, String(pid));
        mkdirSync(dir);
        for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
      };
      const mark = kernelRunMark("orbita-ab", "r1");
      entry(target.pid, { environ: `PATH=/usr/bin\0${KERNEL_RUN_ENV}=orbita-ab.r1\0HOME=/home/u\0`, cmdline: "sleep\0" + "30\0" });
      entry(top.pid, { cmdline: `bash\0-c\0trap ': ${KERNEL_CHILD_MARK}=orbita-ab' EXIT\nsleep 30\0` });
      entry(otherRun.pid, { environ: `${KERNEL_RUN_ENV}=orbita-ab.r2\0`, cmdline: "sleep\0" });
      entry(bystander.pid, { environ: `PATH=/usr/bin\0NOTE=${KERNEL_RUN_ENV}=orbita-ab.r1\0`, cmdline: "sleep\0" });
      entry(999_999, { environ: `${KERNEL_RUN_ENV}=orbita-ab.r1` }); // 已经不在的进程（最后一条没有 NUL 结尾）：kill 失败不计数
      mkdirSync(join(proc, "self"));
      const exited = (child: ReturnType<typeof spawnSleep>) => new Promise<boolean>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve(true);
        else {
          child.once("exit", () => resolve(true));
          setTimeout(() => resolve(false), 1000);
        }
      });
      const saved = process.env["ORBITA_REAP_PROC"];
      process.env["ORBITA_REAP_PROC"] = proc;
      try {
        // 停一次运行：只认环境变量里的这一次
        assert.equal(await reapMsysProcesses("/bin/bash", { env: mark }), 1);
        assert.equal(await exited(target), true, "这一次运行的子孙被杀");
        // 孤儿善后：按「标签.」前缀 + 命令行标签
        assert.equal(await reapMsysProcesses("/bin/bash", { env: kernelRunMark("orbita-ab"), cmd: `${KERNEL_CHILD_MARK}=orbita-ab` }), 2);
        assert.equal(await exited(top), true, "命令行带标签的顶层 shell 被杀");
        assert.equal(await exited(otherRun), true, "同一库目录别的运行在孤儿善后里一起杀");
        assert.equal(bystander.exitCode, null, "标记只出现在别的变量的值里：不算");
        assert.equal(bystander.signalCode, null);
      } finally {
        if (saved === undefined) delete process.env["ORBITA_REAP_PROC"];
        else process.env["ORBITA_REAP_PROC"] = saved;
        for (const child of [target, top, otherRun, bystander]) child.kill("SIGKILL");
        rmSync(proc, { recursive: true, force: true });
      }
    },
  );
});
