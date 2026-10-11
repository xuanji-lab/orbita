import { deepStrictEqual, strictEqual } from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveTerminalCwd, resolveTerminalEnv } from "./env.ts";
import { homedir } from "node:os";

describe("resolveTerminalEnv —— 交互终端的能力声明", () => {
  it("TERM 恒为 xterm-256color，COLORTERM 缺了补 truecolor，用户已有的保留", () => {
    const filled = resolveTerminalEnv({ platform: "linux", env: {} });
    strictEqual(filled["TERM"], "xterm-256color");
    strictEqual(filled["COLORTERM"], "truecolor");
    const kept = resolveTerminalEnv({ platform: "linux", env: { COLORTERM: "24bit" } });
    strictEqual(kept["COLORTERM"], "24bit");
  });

  it("环境采集用的 CI=1 + TERM=dumb 泄漏组合被摘掉；别的 CI 保留", () => {
    const cleaned = resolveTerminalEnv({ platform: "linux", env: { CI: "1", TERM: "dumb" } });
    strictEqual(cleaned["CI"], undefined);
    const kept = resolveTerminalEnv({ platform: "linux", env: { CI: "1", TERM: "xterm" } });
    strictEqual(kept["CI"], "1");
  });

  it("C / POSIX locale 补 UTF-8 兜底：darwin en_US.UTF-8、其它 C.UTF-8", () => {
    const darwin = resolveTerminalEnv({ platform: "darwin", env: { LANG: "C", LC_CTYPE: "POSIX" } });
    strictEqual(darwin["LANG"], "en_US.UTF-8");
    strictEqual(darwin["LC_CTYPE"], "en_US.UTF-8");
    const linux = resolveTerminalEnv({ platform: "linux", env: {} });
    strictEqual(linux["LANG"], "C.UTF-8");
  });

  it("用户配好的 UTF-8 locale 原样保留；任一处配过 UTF-8 就不再造第二份", () => {
    const kept = resolveTerminalEnv({ platform: "linux", env: { LC_ALL: "zh_CN.UTF-8" } });
    strictEqual(kept["LC_ALL"], "zh_CN.UTF-8");
    strictEqual(kept["LANG"], "zh_CN.UTF-8");
  });

  it("darwin 的 PATH 只在终端 env 里补 Homebrew，用户已有顺序在前", () => {
    const next = resolveTerminalEnv({
      platform: "darwin",
      env: { PATH: "/Users/x/.local/bin:/usr/bin:/bin" },
    });
    deepStrictEqual(next["PATH"]?.split(":"), [
      "/Users/x/.local/bin",
      "/usr/bin",
      "/bin",
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/usr/local/sbin",
    ]);
    // 其它平台不动 PATH
    const untouched = resolveTerminalEnv({ platform: "linux", env: { PATH: "/usr/bin" } });
    strictEqual(untouched["PATH"], "/usr/bin");
  });
});

describe("resolveTerminalCwd —— 失效回退 homedir，不报错", () => {
  it("现存的目录原样返回", () => {
    strictEqual(resolveTerminalCwd(process.cwd()), process.cwd());
  });

  it("不存在的路径回退 homedir", () => {
    strictEqual(resolveTerminalCwd("C:\\definitely\\not\\a\\real\\dir\\xyz"), homedir());
    strictEqual(resolveTerminalCwd(undefined), homedir());
  });

  it("指向文件的路径同样回退（要的是目录）", () => {
    strictEqual(resolveTerminalCwd(process.execPath), homedir());
  });
});
