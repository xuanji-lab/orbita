/**
 * tasklist CSV 解析的测试。为什么单独测它：这行解析错了，stop 会按**错的 PID** 去
 * `taskkill /T /F`——打到别人的进程上（仓规：杀进程只按自己记录的 PID）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isRemoteSessionImage, isSandboxImage, isSandboxMemoryImage, parseSandboxProcesses } from "./process-list.ts";

const csv = [
  '"Image Name","PID","Session Name","Session#","Mem Usage"',
  // 实机形态（/NH 不带表头时去掉第一行）
  '"System","4","Services","0","144 K"',
  '"WindowsSandboxServer.exe","6040","Console","1","78,112 K"',
  '"WindowsSandboxRemoteSession.exe","6152","Console","1","52,304 K"',
  '"vmwp.exe","7204","Services","0","2,451,880 K"',
  // VM 内存进程：只用来盯「VM 真的没了」，不算可杀进程
  '"vmmemWindowsSandbox","7300","Services","0","3,482,112 K"',
  // tasklist 在部分版本上把 Image Name 截到 25 字符：RemoteSession 会丢尾巴
  '"WindowsSandboxRemoteSessi","8008","Console","1","1,024 K"',
  // 名字相近但不属于沙箱侧
  '"WindowsSandbox.exe","9000","Console","1","18,004 K"',
  '"vmwpctl.exe","9100","Console","1","100 K"',
  "",
].join("\r\n");

describe("parseSandboxProcesses", () => {
  test("只取沙箱侧三类进程；启动器 WindowsSandbox.exe 与名字相近的不算", () => {
    assert.deepEqual(parseSandboxProcesses(csv), [
      { image: "WindowsSandboxServer.exe", pid: 6040 },
      { image: "WindowsSandboxRemoteSession.exe", pid: 6152 },
      { image: "vmwp.exe", pid: 7204 },
      // VM 内存进程也算沙箱侧（它是「VM 还在」的证据），但只观测不杀，见下一条
      { image: "vmmemWindowsSandbox", pid: 7300 },
      // tasklist 截断到 25 字符的那一行也要认出来（否则挑不到窗口去发 WM_CLOSE）
      { image: "WindowsSandboxRemoteSessi", pid: 8008 },
    ]);
  });

  test("vmmemWindowsSandbox 只观测不杀：认得出它是内存进程，且不肯它进 kill 名单", () => {
    assert.equal(isSandboxMemoryImage("vmmemWindowsSandbox"), true);
    assert.equal(isSandboxMemoryImage("VMMEMWINDOWSSANDBOX.EXE"), true);
    assert.equal(isSandboxMemoryImage("vmwp.exe"), false);
    assert.equal(isSandboxMemoryImage("WindowsSandboxServer.exe"), false);
    assert.equal(isSandboxMemoryImage("vmmem"), false, "WSL 的 vmmem 不是我们这只沙箱");
  });

  test("镜像名要带得住：能挑出 RemoteSession（窗口）而不是 Server / vmwp", () => {
    const processes = parseSandboxProcesses(csv);
    assert.deepEqual(
      processes.filter((process) => isRemoteSessionImage(process.image)).map((process) => process.pid),
      [6152, 8008],
      "截断形态也算窗口",
    );
    assert.equal(isRemoteSessionImage("WindowsSandboxServer.exe"), false);
    assert.equal(isRemoteSessionImage("vmwp.exe"), false);
    assert.equal(isRemoteSessionImage("WindowsSandbox.exe"), false);
  });

  test("列截断（Image Name 少半截）仍认得出 RemoteSession——前缀比不按全名", () => {
    assert.equal(isSandboxImage("WindowsSandboxRemoteSessi"), true);
    assert.equal(isSandboxImage("WindowsSandboxServer.exe"), true);
    assert.equal(isSandboxImage("WINDOWSSANDBOXSERVER.EXE"), true);
    assert.equal(isSandboxImage("vmwp.exe"), true);
    // 反向：启动器与「名字相近」的都不算
    assert.equal(isSandboxImage("WindowsSandbox.exe"), false);
    assert.equal(isSandboxImage("vmwpctl.exe"), false);
  });

  test("坏行 / 空输出 / 非 CSV 一律跳过，不抛错", () => {
    assert.deepEqual(parseSandboxProcesses(""), []);
    assert.deepEqual(parseSandboxProcesses("\n\n"), []);
    assert.deepEqual(parseSandboxProcesses("INFO: No tasks are running which match the specified criteria."), []);
    assert.deepEqual(parseSandboxProcesses('"vmwp.exe","not-a-pid"'), [], "PID 不是数字就不认");
    assert.deepEqual(
      parseSandboxProcesses('"WindowsSandboxServer.exe","12","Console"'),
      [{ image: "WindowsSandboxServer.exe", pid: 12 }],
      "列不足时前两列够用",
    );
  });
});
