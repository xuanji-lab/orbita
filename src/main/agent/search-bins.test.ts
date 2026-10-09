import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { agentEnv, bundledBinDir } from "./search-bins.ts";

describe("bundledBinDir", () => {
  test("打包版：resources/bin", () => {
    assert.equal(
      bundledBinDir({ packaged: true, resourcesPath: "/R", appPath: "/A", platform: "darwin", arch: "arm64" }),
      join("/R", "bin"),
    );
  });

  test("开发版：仓库 build/bin/<platform>-<arch>", () => {
    assert.equal(
      bundledBinDir({ packaged: false, resourcesPath: "/R", appPath: "/A", platform: "win32", arch: "x64" }),
      join("/A", "build", "bin", "win32-x64"),
    );
  });
});

describe("agentEnv", () => {
  test("挂到 PATH 最前面，原值保留", () => {
    assert.equal(agentEnv({ PATH: "/usr/bin:/bin" }, "/R/bin", "darwin")["PATH"], "/R/bin:/usr/bin:/bin");
  });

  test("Windows 沿用原来的键名 Path，不多出第二个 PATH", () => {
    const env = agentEnv({ Path: "C:\\Windows" }, "C:\\R\\bin", "win32");
    assert.equal(env["Path"], "C:\\R\\bin;C:\\Windows");
    assert.equal("PATH" in env, false);
  });

  test("PATH 缺席或为空：就只有 binDir", () => {
    assert.equal(agentEnv({}, "/R/bin", "linux")["PATH"], "/R/bin");
    assert.equal(agentEnv({ PATH: "" }, "/R/bin", "linux")["PATH"], "/R/bin");
  });

  test("其它变量原样带过去，不改入参", () => {
    const base = { PATH: "/bin", HOME: "/h" };
    const env = agentEnv(base, "/R/bin", "darwin");
    assert.equal(env["HOME"], "/h");
    assert.equal(base.PATH, "/bin");
  });
});
