import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { OFFICECLI_PATH_ENV, officecliBinPath, resolveOfficecliPath } from "./officecli-bin.ts";

const base = { packaged: true, resourcesPath: "/R", appPath: "/A", platform: "win32", arch: "x64" };

describe("officecliBinPath", () => {
  test("打包版：resources/bin/officecli（子目录，不在 agent PATH 那一层），Windows 带 .exe", () => {
    assert.equal(officecliBinPath(base), join("/R", "bin", "officecli", "officecli.exe"));
  });

  test("打包版 mac：同名无后缀", () => {
    assert.equal(officecliBinPath({ ...base, platform: "darwin", arch: "arm64" }), join("/R", "bin", "officecli", "officecli"));
  });

  test("开发版：仓库 build/bin/<platform>-<arch>/officecli/（fetch 脚本的落点）", () => {
    assert.equal(
      officecliBinPath({ ...base, packaged: false }),
      join("/A", "build", "bin", "win32-x64", "officecli", "officecli.exe"),
    );
    assert.equal(
      officecliBinPath({ ...base, packaged: false, platform: "darwin", arch: "arm64" }),
      join("/A", "build", "bin", "darwin-arm64", "officecli", "officecli"),
    );
  });

  test("落点不在 PATH 目录本身：路径比 rg / fd 的 bin 目录多一层", () => {
    const binDir = join("/R", "bin");
    const path = officecliBinPath(base);
    // 挂到 agent PATH 上的是 binDir；它里面不能直接有 officecli.exe
    assert.equal(dirname(path), join(binDir, "officecli"));
    assert.notEqual(dirname(path), binDir);
  });
});

describe("resolveOfficecliPath", () => {
  const input = { env: {}, exists: () => true, ...base };

  test("没有覆盖时用安装包里那份", () => {
    assert.equal(resolveOfficecliPath(input), join("/R", "bin", "officecli", "officecli.exe"));
  });

  test("文件不在 → null（报「未就绪」，不退化成 PATH 里随便哪个）", () => {
    assert.equal(resolveOfficecliPath({ ...input, exists: () => false }), null);
  });

  test("环境变量给的绝对路径优先于安装包内那份", () => {
    const path = resolveOfficecliPath({
      ...input,
      env: { [OFFICECLI_PATH_ENV]: "/opt/officecli" },
      exists: (candidate) => candidate === "/opt/officecli" || candidate === join("/R", "bin", "officecli", "officecli.exe"),
    });
    assert.equal(path, "/opt/officecli");
  });

  test("环境变量指向不存在的文件 → 退回安装包内那份，不报错也不返回坏路径", () => {
    const path = resolveOfficecliPath({
      ...input,
      env: { [OFFICECLI_PATH_ENV]: "/nope/officecli" },
      exists: (candidate) => candidate === join("/R", "bin", "officecli", "officecli.exe"),
    });
    assert.equal(path, join("/R", "bin", "officecli", "officecli.exe"));
  });

  test("空白环境变量当没设", () => {
    const path = resolveOfficecliPath({ ...input, env: { [OFFICECLI_PATH_ENV]: "   " } });
    assert.equal(path, join("/R", "bin", "officecli", "officecli.exe"));
  });

  test("开发态 + 没跑过 fetch 脚本 → null", () => {
    assert.equal(resolveOfficecliPath({ ...input, packaged: false, exists: () => false }), null);
  });
});
