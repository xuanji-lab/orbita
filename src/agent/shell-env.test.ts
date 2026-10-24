/**
 * 非交互 shell 前缀。真源与理由见 ./shell-env.ts。
 *
 * 这里钉的是**判错方向的代价不对称**：前缀是 `export`，判成 POSIX 而实际不是
 * （cmd.exe / PowerShell）会让每一条命令都语法错误；判成非 POSIX 只是少一个功能。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { NON_INTERACTIVE_SHELL_PREFIX, nonInteractivePrefixFor } from "./shell-env.ts";

describe("nonInteractivePrefixFor", () => {
  test("POSIX 系给前缀：裸名与绝对路径都认（含 Git Bash 的 .exe）", () => {
    for (const path of [
      "bash",
      "/usr/bin/bash",
      "/bin/sh",
      "/bin/zsh",
      "/usr/bin/dash",
      "/bin/ksh",
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "/usr/bin/bash.exe",
    ]) {
      assert.equal(nonInteractivePrefixFor(path), NON_INTERACTIVE_SHELL_PREFIX, path);
    }
  });

  test("非 POSIX 系给空串：export 那一行会把它们的每条命令弄成语法错误", () => {
    for (const path of [
      "cmd.exe",
      "C:\\Windows\\System32\\cmd.exe",
      "powershell.exe",
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "pwsh",
      "/usr/bin/pwsh",
      "fish",
      "/opt/homebrew/bin/fish",
    ]) {
      assert.equal(nonInteractivePrefixFor(path), "", path);
    }
  });

  test("undefined（默认 shell 是 Git Bash）给前缀", () => {
    assert.equal(nonInteractivePrefixFor(undefined), NON_INTERACTIVE_SHELL_PREFIX);
  });

  test("前缀本身：独立一行、以 export 开头、四个变量齐全", () => {
    assert.match(NON_INTERACTIVE_SHELL_PREFIX, /^export /);
    assert.doesNotMatch(NON_INTERACTIVE_SHELL_PREFIX, /\n/, "pi 会把它当独立一行插进去，内部不许换行");
    for (const assignment of [
      "PAGER=cat",
      "GIT_PAGER=cat",
      "GIT_TERMINAL_PROMPT=0",
      "GCM_INTERACTIVE=never",
    ]) {
      assert.ok(NON_INTERACTIVE_SHELL_PREFIX.includes(assignment), assignment);
    }
  });
});
