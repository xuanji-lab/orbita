import { deepStrictEqual, strictEqual, throws } from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTerminalShell } from "./shell.ts";

const X_OK = (): boolean => true;

describe("resolveTerminalShell —— Windows 回退链 pwsh → powershell → cmd", () => {
  it("ProgramFiles 下的 pwsh 排最前，带 -NoLogo", () => {
    const shell = resolveTerminalShell({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      canExecute: X_OK,
    });
    strictEqual(shell.file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    deepStrictEqual(shell.args, ["-NoLogo"]);
    strictEqual(shell.label, "pwsh");
  });

  it("没有 pwsh 时落到 System32 的 Windows PowerShell（恒在的保底链）", () => {
    const shell = resolveTerminalShell({
      platform: "win32",
      env: { SystemRoot: "C:\\Windows" },
      canExecute: (path) => path.includes("WindowsPowerShell"),
    });
    strictEqual(shell.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    strictEqual(shell.label, "powershell");
  });

  it("PATH 里的 pwsh（scoop / winget 用户态安装）也算数", () => {
    const shell = resolveTerminalShell({
      platform: "win32",
      env: { PATH: "C:\\tools\\scoop\\shims;C:\\Windows\\system32" },
      canExecute: (path) => path.startsWith("C:\\tools"),
    });
    strictEqual(shell.file, "C:\\tools\\scoop\\shims\\pwsh.exe");
    strictEqual(shell.label, "pwsh");
  });

  it("两者都缺时 ComSpec 的 cmd 是终点，探测永不失败", () => {
    const shell = resolveTerminalShell({
      platform: "win32",
      env: { ComSpec: "C:\\Windows\\system32\\cmd.exe" },
      canExecute: () => false,
    });
    strictEqual(shell.file, "C:\\Windows\\system32\\cmd.exe");
    deepStrictEqual(shell.args, []);
    strictEqual(shell.label, "cmd");
  });
});

describe("resolveTerminalShell —— POSIX 回退链 $SHELL → zsh → bash → sh", () => {
  it("$SHELL 可执行就用它（登录模式 -l）", () => {
    const shell = resolveTerminalShell({
      platform: "linux",
      env: { SHELL: "/usr/bin/fish" },
      canExecute: (path) => path === "/usr/bin/fish",
    });
    strictEqual(shell.file, "/usr/bin/fish");
    deepStrictEqual(shell.args, ["-l"]);
    strictEqual(shell.label, "fish");
  });

  it("坏 $SHELL（不可执行）按平台回退：darwin 是 zsh，linux 是 bash", () => {
    const darwin = resolveTerminalShell({
      platform: "darwin",
      env: { SHELL: "/bin/tcsh-that-is-gone" },
      canExecute: (path) => path === "/bin/zsh",
    });
    strictEqual(darwin.file, "/bin/zsh");
    const linux = resolveTerminalShell({
      platform: "linux",
      env: { SHELL: "/bin/tcsh-that-is-gone" },
      canExecute: (path) => path === "/bin/bash",
    });
    strictEqual(linux.file, "/bin/bash");
  });

  it("一条都不剩时如实抛错，不静默给一个跑不起来的 shell", () => {
    throws(() =>
      resolveTerminalShell({ platform: "linux", env: {}, canExecute: () => false }),
    );
  });
});
