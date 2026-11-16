import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { KERNEL_CHILD_MARK, kernelChildTag, reapKernelChildren, tagShellCommand, taggedProcesses } from "./kernel-children.ts";

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
