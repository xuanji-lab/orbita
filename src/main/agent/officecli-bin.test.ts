import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OFFICECLI_PATH_ENV, officecliBinPath, resolveOfficecliPath } from "./officecli-bin.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * 把绝对路径写成 electron-builder 配置里的样子：相对 `.app` 包根、正斜杠、不带前导斜杠。
 * `mac.binaries` 的条目就是这么解析的（MacTargetHelper：`path.resolve(appPath, d)`）。
 */
function relativeToApp(absolute: string, appDir: string): string {
  return absolute.slice(appDir.length + 1).split(/[\\/]/).join("/");
}

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

/**
 * 打包配置与运行时落点必须说同一件事。
 *
 * 这两条是为 BUG-3 加的：`mac.binaries` 曾写 `Contents/Resources/bin/officecli`，而文件其实在
 * 子目录里——那一条把**目录**交给 osx-sign，codesign 对普通目录报 `bundle format unrecognized,
 * invalid, or unsuitable`，整条 mac 打包在签名阶段挂掉；而没有任何测试看着，改落点就会静默跑偏。
 */
describe("package.json 的打包配置与运行时落点一致", () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    build?: {
      mac?: { binaries?: string[]; extraResources?: { from: string; to: string }[] };
      win?: { extraResources?: { from: string; to: string }[] };
    };
  };
  const macApp = "/App";
  const macContents = join(macApp, "Contents");
  const packagedRelative = relativeToApp(
    officecliBinPath({ packaged: true, resourcesPath: join(macContents, "Resources"), appPath: "/unused", platform: "darwin", arch: "arm64" }),
    macApp,
  );

  test("落点本身就是 Contents/Resources/bin/officecli/officecli（相对形式的基准）", () => {
    assert.equal(packagedRelative, "Contents/Resources/bin/officecli/officecli");
  });

  test("mac.binaries 的每一项要么不存在、要么与运行时落点逐字相同（含子目录）", () => {
    // 现在这一项是故意空着的：osx-sign 的 walkAsync 已经递归签 Contents 下所有 Mach-O，
    // 再列一条只会让同一个文件被第二次 codesign。要重新加，就得先过这条断言。
    for (const entry of pkg.build?.mac?.binaries ?? []) {
      assert.equal(
        entry.split(/[\\/]/).join("/"),
        packagedRelative,
        `mac.binaries 的 ${entry} 与运行时落点 ${packagedRelative} 不一致（写错路径会让 mac 打包在签名阶段挂）`,
      );
    }
  });

  test("两个平台的 extraResources 都把 officecli 目录放到运行时找它的那个位置", () => {
    for (const platform of ["mac", "win"] as const) {
      const packaged = officecliBinPath({
        packaged: true,
        resourcesPath: platform === "mac" ? join(macContents, "Resources") : "C:\\Resources",
        appPath: "/unused",
        platform: platform === "mac" ? "darwin" : "win32",
        arch: platform === "mac" ? "arm64" : "x64",
      });
      const devDir = dirname(
        officecliBinPath({
          packaged: false,
          resourcesPath: "/unused",
          appPath: "/repo",
          platform: platform === "mac" ? "darwin" : "win32",
          arch: platform === "mac" ? "arm64" : "x64",
        }),
      );
      const to = dirname(packaged).split(/[\\/]/).slice(-2).join("/");
      const entry = (pkg.build?.[platform]?.extraResources ?? []).find((item) => item.to === to);
      assert.ok(entry, `package.json 的 build.${platform}.extraResources 缺 ${to}`);
      assert.equal(
        entry.from.split(/[\\/]/).join("/"),
        devDir.split(/[\\/]/).slice(-4).join("/"),
        `${platform} 的 from 与开发态落点不一致`,
      );
    }
  });
});
