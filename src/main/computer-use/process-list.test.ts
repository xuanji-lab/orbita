/**
 * tasklist CSV 解析的测试。为什么单独测它：这行解析错了，stop 会按**错的 PID** 去
 * `taskkill /T /F`——打到别人的进程上（仓规：杀进程只按自己记录的 PID）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { isSandboxImage, parseSandboxProcessIds } from "./process-list.ts";

const csv = [
  '"Image Name","PID","Session Name","Session#","Mem Usage"',
  // 实机形态（/NH 不带表头时去掉第一行）
  '"System","4","Services","0","144 K"',
  '"WindowsSandboxServer.exe","6040","Console","1","78,112 K"',
  '"WindowsSandboxRemoteSession.exe","6152","Console","1","52,304 K"',
  '"vmwp.exe","7204","Services","0","2,451,880 K"',
  // tasklist 在部分版本上把 Image Name 截到 25 字符：RemoteSession 会丢尾巴
  '"WindowsSandboxRemoteSessi","8008","Console","1","1,024 K"',
  // 名字相近但不属于沙箱侧
  '"WindowsSandbox.exe","9000","Console","1","18,004 K"',
  '"vmwpctl.exe","9100","Console","1","100 K"',
  "",
].join("\r\n");

describe("parseSandboxProcessIds", () => {
  test("只取沙箱侧三类进程；启动器 WindowsSandbox.exe 与名字相近的不算", () => {
    assert.deepEqual(parseSandboxProcessIds(csv), [6040, 6152, 7204, 8008]);
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
    assert.deepEqual(parseSandboxProcessIds(""), []);
    assert.deepEqual(parseSandboxProcessIds("\n\n"), []);
    assert.deepEqual(parseSandboxProcessIds("INFO: No tasks are running which match the specified criteria."), []);
    assert.deepEqual(parseSandboxProcessIds('"vmwp.exe","not-a-pid"'), [], "PID 不是数字就不认");
    assert.deepEqual(parseSandboxProcessIds('"WindowsSandboxServer.exe","12","Console"'), [12], "列不足时前两列够用");
  });
});
