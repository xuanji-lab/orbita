/**
 * agent 终端的策略测试：cwd 授权（含符号链接逃逸）与所有权校验。
 * **纯模块**，假 fs + 假 path，不碰真磁盘也不碰 electron。
 */
import { deepStrictEqual, ok, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { posix, win32 } from "node:path";
import type { TerminalInfo } from "../../shared/terminal.ts";
import { ownedTerminal, resolveAgentTerminalCwd, type AgentCwdDeps } from "./agent-policy.ts";

/** 假文件系统：真实目录 + 符号链接表。realpath 跟随链接，不存在的路径抛 */
function fakeFs(dirs: readonly string[], links: Record<string, string> = {}): AgentCwdDeps {
  const existing = new Set(dirs);
  const realpath = (target: string): string => {
    const seen = new Set<string>();
    let current = target;
    while (links[current] !== undefined) {
      if (seen.has(current)) throw new Error("symlink loop");
      seen.add(current);
      current = links[current]!;
    }
    if (!existing.has(current)) throw new Error(`ENOENT: ${current}`);
    return current;
  };
  return {
    realpath,
    isDirectory: (target: string) => {
      try {
        realpath(target);
        return true;
      } catch {
        return false;
      }
    },
    path: posix,
    platform: "linux",
  };
}

const terminal = (over: Partial<TerminalInfo> & Pick<TerminalInfo, "terminalId">): TerminalInfo => ({
  title: "repo",
  shell: "pwsh",
  cwd: "/repo",
  pid: 1,
  exited: null,
  owner: { kind: "agent", sessionId: "s1" },
  ...over,
});

describe("resolveAgentTerminalCwd —— cwd 授权", () => {
  const context = { roots: ["/repo", "/data/attached"], defaultCwd: "/repo" };

  it("缺席 / 空串 = 会话 cwd（它本身就是授权目录）", () => {
    const deps = fakeFs(["/repo", "/data/attached"]);
    deepStrictEqual(resolveAgentTerminalCwd(undefined, context, deps), { ok: true, cwd: "/repo" });
    deepStrictEqual(resolveAgentTerminalCwd("   ", context, deps), { ok: true, cwd: "/repo" });
  });

  it("授权目录内的绝对路径与相对路径都放行（相对按会话 cwd 解析）", () => {
    const deps = fakeFs(["/repo", "/repo/apps/electron", "/data/attached"]);
    deepStrictEqual(resolveAgentTerminalCwd("/repo/apps/electron", context, deps), {
      ok: true,
      cwd: "/repo/apps/electron",
    });
    deepStrictEqual(resolveAgentTerminalCwd("apps/electron", context, deps), {
      ok: true,
      cwd: "/repo/apps/electron",
    });
    deepStrictEqual(resolveAgentTerminalCwd("/data/attached", context, deps), { ok: true, cwd: "/data/attached" });
  });

  it("授权目录本身放行（边界相等不算越界）", () => {
    deepStrictEqual(resolveAgentTerminalCwd("/repo", context, fakeFs(["/repo", "/data/attached"])), {
      ok: true,
      cwd: "/repo",
    });
  });

  it("相邻前缀不是包含：/repo-extra 拒绝", () => {
    const deps = fakeFs(["/repo", "/repo-extra", "/data/attached"]);
    const result = resolveAgentTerminalCwd("/repo-extra", context, deps);
    strictEqual(result.ok, false);
    ok(!result.ok && /outside this session's authorized directories/.test(result.error), result.ok ? "" : result.error);
  });

  it("符号链接逃逸：授权目录里的链接指向外面 → 拒绝", () => {
    const deps = fakeFs(["/repo", "/outside"], { "/repo/escape": "/outside" });
    const result = resolveAgentTerminalCwd("/repo/escape", context, deps);
    strictEqual(result.ok, false);
    ok(!result.ok && /outside this session's authorized directories/.test(result.error));
  });

  it("符号链接指回授权目录内：放行，且返回真实路径（PTY 开在真身上）", () => {
    const deps = fakeFs(["/repo", "/repo/apps", "/data/attached"], { "/repo/link": "/repo/apps" });
    deepStrictEqual(resolveAgentTerminalCwd("/repo/link", context, deps), { ok: true, cwd: "/repo/apps" });
  });

  it("授权目录里的链接指向另一个授权目录：放行", () => {
    const deps = fakeFs(["/repo", "/data/attached"], { "/repo/att": "/data/attached" });
    deepStrictEqual(resolveAgentTerminalCwd("/repo/att", context, deps), { ok: true, cwd: "/data/attached" });
  });

  it("不存在 / 不是目录：分别说清楚", () => {
    const deps = fakeFs(["/repo", "/data/attached", "/repo/file.txt"]);
    const missing = resolveAgentTerminalCwd("/repo/nope", context, deps);
    strictEqual(missing.ok, false);
    ok(!missing.ok && /does not exist/.test(missing.error));
    // fakeFs 的 isDirectory 对存在的都回 true，所以「不是目录」用 isDirectory 恒假的依赖测
    const notDir = resolveAgentTerminalCwd("/repo/file.txt", context, { ...deps, isDirectory: () => false });
    strictEqual(notDir.ok, false);
    ok(!notDir.ok && /is not a directory/.test(notDir.error));
  });

  it("授权目录全失效（被挪走）：明确报错，不悄悄回退 homedir", () => {
    const result = resolveAgentTerminalCwd(undefined, context, fakeFs([]));
    strictEqual(result.ok, false);
    ok(!result.ok && /no authorized directory/.test(result.error));
  });

  it("Windows 口径：大小写不敏感、反斜杠当分隔符", () => {
    // 根与候选大小写不同也认包含（Windows 文件系统大小写不敏感）；路径算法注入 win32，
    // 这条测试因此在任何平台上都跑同一套语义
    const deps = fakeFs(["C:\\Repo", "C:\\repo\\apps", "C:\\Repo\\apps"]);
    deps.path = win32;
    deps.platform = "win32";
    const context2 = { roots: ["C:\\Repo"], defaultCwd: "C:\\Repo" };
    deepStrictEqual(resolveAgentTerminalCwd("C:\\repo\\apps", context2, deps), { ok: true, cwd: "C:\\repo\\apps" });
    // 相对路径按会话 cwd 解析（win32 的 resolve 用反斜杠拼，大小写随 cwd）
    deepStrictEqual(resolveAgentTerminalCwd("apps", context2, deps), { ok: true, cwd: "C:\\Repo\\apps" });
    // 大小写不同导致 realpath 找不到时，报的是「不存在」而不是越界——两件事分开说
    const missing = resolveAgentTerminalCwd("C:\\REPO\\apps", context2, deps);
    strictEqual(missing.ok, false);
    ok(!missing.ok && /does not exist/.test(missing.error));
  });
});

describe("ownedTerminal —— 代码层的所有权", () => {
  const mine = terminal({ terminalId: "t1" });
  const others = terminal({ terminalId: "t2", owner: { kind: "agent", sessionId: "s2" } });
  const humans = terminal({ terminalId: "t3", owner: { kind: "human" } });
  const dead = terminal({ terminalId: "t4", exited: 7 });
  const all = [mine, others, humans, dead];

  it("本会话 running：放行", () => {
    const found = ownedTerminal(all, "s1", "t1", { requireRunning: true });
    ok(found.ok);
    strictEqual(found.ok && found.terminal.terminalId, "t1");
  });

  it("不存在的 id：说清「被关了」并指向 terminal_list", () => {
    const found = ownedTerminal(all, "s1", "ghost", { requireRunning: true });
    strictEqual(found.ok, false);
    ok(!found.ok && /it was closed/.test(found.error) && /terminal_list/.test(found.error));
  });

  it("别人的会话 / 人工开的：拒绝，并说明只有本会话开的能驱动", () => {
    for (const id of ["t2", "t3"]) {
      const found = ownedTerminal(all, "s1", id, { requireRunning: true });
      strictEqual(found.ok, false, id);
      ok(!found.ok && /not owned by this session/.test(found.error), id);
    }
  });

  it("已退出：execute / interrupt 拒（没有 shell 可写），read 放行", () => {
    const write = ownedTerminal(all, "s1", "t4", { requireRunning: true });
    strictEqual(write.ok, false);
    ok(!write.ok && /has already exited \(exit code 7\)/.test(write.error) && /terminal_read/.test(write.error));
    const read = ownedTerminal(all, "s1", "t4", { requireRunning: false });
    ok(read.ok);
  });
});
