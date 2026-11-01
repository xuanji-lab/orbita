/**
 * bash/powershell 工具超时后必须杀光整棵进程树（Windows 回归测试）。
 *
 * 根因（2026-11-01 复现，证据在验收仓 evidence/pr380/red-bash-before.txt）：
 * Git Bash（MSYS2）fork 出的孙进程 Win32 父进程指向已退出的中间进程，
 * `taskkill /F /T` 按父子链走永远到不了它们——`sleep 100 & sleep 100` 超时后
 * 两个 sleep.exe 常驻。修复是 pi 补丁里的 Kill Job（Job Object）：spawn 即挂
 * job，超时 TerminateJobObject 一刀切全部成员，不依赖父子链。
 *
 * 测试直接驱动 pi 的本地 shell 操作（与 pi 同一条执行路径），绕过权限闸门——
 * 闸门会把模型自填的小 timeout 抬到 600 秒（shared/permission.ts），这里必须
 * 用 3 秒触发真实超时。非 Windows 平台 MSYS2 父链不断，跳过。
 *
 * 断言口径：命令启动后新建、且在本测试时间窗内仍存活的 sleep.exe 必须为零。
 * 启动前已存在的 sleep（用户自己的）不在断言范围。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

const isWindows = process.platform === "win32";

function youngSleeps(since: Date): string {
  const sinceStr = since.toISOString();
  try {
    return execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "Name='sleep.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CreationDate -gt '${sinceStr}' } | Select-Object -ExpandProperty ProcessId) -join ','`,
      ],
      { encoding: "utf-8" },
    ).trim();
  } catch {
    return "查询失败";
  }
}

describe("shell 工具超时后杀整棵进程树（Kill Job 补丁）", { skip: !isWindows, timeout: 60_000 }, () => {
  test("Git Bash `sleep 60 & sleep 60` 超时 3 秒后无 sleep 残留", async () => {
    const ops = createLocalBashOperations();
    const since = new Date(Date.now() - 5_000); // 余量：窗口起点略早于命令启动
    let thrown: unknown;
    try {
      await ops.exec("sleep 60 & sleep 60", process.cwd(), { timeout: 3, onData: () => {} });
    } catch (e) {
      thrown = e;
    }
    assert.ok(thrown instanceof Error, "命令必须因超时抛错");
    assert.match(thrown.message, /timed out|timeout:/); // 底层抛 timeout:N，工具层包「Command timed out after N seconds」

    // TerminateJobObject 是毫秒级同步杀；留 2 秒观察期，放宽调度抖动
    await new Promise((r) => setTimeout(r, 2_000));
    const leftover = youngSleeps(since);
    // 失败时也把残留清掉，别给后续测试/用户机器留垃圾（只杀窗口内新建的）
    if (leftover && leftover !== "查询失败") {
      for (const pid of leftover.split(",").filter(Boolean)) {
        try {
          execFileSync("taskkill", ["/F", "/PID", pid], { stdio: "ignore" });
        } catch {
          // 已死或权限不足：断言会如实报出来
        }
      }
    }
    assert.equal(leftover, "", `超时后仍有 sleep 残留: ${leftover}`);
  });
});
