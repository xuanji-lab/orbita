/**
 * latexmk 探测的回归网 —— 用**虚拟文件系统**（exists / list 注入）而不是临时目录：
 * 要测的正是平台相关的安装位置（`D:\texlive\2024\bin\windows` 与
 * `/usr/local/texlive/2024/bin/…`），而宿主只有一个平台。路径算法也随
 * deps.path 注入，所以同一套断言在任何宿主上都成立。
 *
 * 不真起 latexmk：`version` 注入假货，只记录「问了哪些命令」。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import { createLatexProbe, type LatexPathApi, type LatexProbeDeps } from "./probe.ts";

const FAKE_VERSION = "Latexmk, John Collins, 27 Dec. 2024. Version 4.86a";

interface FakeOptions {
  platform: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** 存在的文件（绝对路径，按平台的分隔符写） */
  files?: string[];
  /** 额外存在的空目录（texlive 的年份层靠它） */
  dirs?: string[];
  /** 指定某个命令的 version 输出；null = 跑不起来。缺席时「存在的文件」都回 FAKE_VERSION */
  versions?: Record<string, string | null>;
}

function fakeDeps(options: FakeOptions): { deps: LatexProbeDeps; versionCalls: string[] } {
  const path: LatexPathApi = options.platform === "win32" ? win32 : posix;
  const files = new Set(options.files ?? []);
  const dirs = new Set(options.dirs ?? []);
  // 每个条目的父目录都算存在（texlive 的年份层靠这条链）/ 只往上一层：再往上的
  // 根（如 /usr/local）在断言里不需要存在
  for (const entry of [...files, ...dirs]) {
    const parent = path.dirname(entry);
    if (parent !== entry) dirs.add(parent);
  }

  const versionCalls: string[] = [];
  const deps: LatexProbeDeps = {
    platform: options.platform,
    env: options.env ?? {},
    path,
    exists: (candidate) => files.has(candidate) || dirs.has(candidate),
    list: (dir) => {
      const children = new Set<string>();
      for (const entry of [...files, ...dirs]) {
        if (path.dirname(entry) === dir) {
          const name = entry.slice(dir.length).replace(/^[\\/]+/, "");
          if (name !== "" && !name.includes("/") && !name.includes("\\")) children.add(name);
        }
      }
      return [...children];
    },
    version: (command) => {
      versionCalls.push(command);
      const explicit = options.versions?.[command];
      if (explicit !== undefined) return Promise.resolve(explicit);
      return Promise.resolve(files.has(command) ? FAKE_VERSION : null);
    },
  };
  return { deps, versionCalls };
}

describe("createLatexProbe —— PATH", () => {
  test("PATH 命中：返回绝对路径与版本，可用引擎来自同目录", async () => {
    const bin = "/opt/texlive/bin";
    const { deps } = fakeDeps({
      platform: "linux",
      env: { PATH: `/usr/local/bin:${bin}` },
      files: [`${bin}/latexmk`, `${bin}/xelatex`, `${bin}/lualatex`],
    });
    const result = await createLatexProbe(deps).probe();
    assert.equal(result.ok, true);
    assert.equal(result.source, "path");
    assert.equal(result.latexmk, `${bin}/latexmk`);
    assert.match(result.version ?? "", /4\.86a/);
    assert.deepEqual(result.engines, ["xelatex", "lualatex"]);
  });

  test("PATH 上只有名字、验活不过：继续找，不把它当装好了", async () => {
    const bin = "/opt/broken";
    const { deps, versionCalls } = fakeDeps({
      platform: "linux",
      env: { PATH: bin },
      files: [`${bin}/latexmk`],
      versions: { [`${bin}/latexmk`]: null },
    });
    const result = await createLatexProbe(deps).probe();
    assert.equal(result.ok, false);
    assert.equal(result.source, null);
    assert.ok(versionCalls.includes(`${bin}/latexmk`));
    assert.match(result.message, /latexmk was not found/);
  });
});

describe("createLatexProbe —— 常见安装位置", () => {
  test("macOS：/Library/TeX/texbin（MacTeX 的固定落点）", async () => {
    const bin = "/Library/TeX/texbin";
    const { deps } = fakeDeps({
      platform: "darwin",
      env: { PATH: "/usr/bin:/bin" },
      files: [`${bin}/latexmk`, `${bin}/pdflatex`],
    });
    const result = await createLatexProbe(deps).probe();
    assert.equal(result.source, "common");
    assert.equal(result.latexmk, `${bin}/latexmk`);
    assert.deepEqual(result.engines, ["pdf"]);
  });

  test("Linux：texlive 年份目录取新的那一份", async () => {
    const base = "/usr/local/texlive";
    const oldBin = `${base}/2023/bin/x86_64-linux`;
    const newBin = `${base}/2024/bin/x86_64-linux`;
    const { deps } = fakeDeps({
      platform: "linux",
      env: { PATH: "/usr/bin:/bin" },
      files: [`${oldBin}/latexmk`, `${newBin}/latexmk`, `${newBin}/xelatex`],
      dirs: [`${base}/2023`, `${base}/2024`],
    });
    const result = await createLatexProbe(deps).probe();
    assert.equal(result.source, "common");
    assert.equal(result.latexmk, `${newBin}/latexmk`);
  });

  test("Windows：各盘的 texlive\\<年>\\bin\\windows 与 MiKTeX", async () => {
    const texlive = win32.join("D:\\texlive", "2024", "bin", "windows");
    const miktex = win32.join("C:\\Users\\me\\AppData\\Local", "Programs", "MiKTeX", "miktex", "bin", "x64");
    const { deps } = fakeDeps({
      platform: "win32",
      env: { Path: "C:\\Windows\\system32", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
      files: [win32.join(texlive, "latexmk.exe"), win32.join(texlive, "xelatex.exe"), win32.join(miktex, "latexmk.exe")],
      dirs: ["D:\\texlive", win32.join("D:\\texlive", "2024")],
    });
    const result = await createLatexProbe(deps).probe();
    assert.equal(result.source, "common");
    assert.equal(result.latexmk, win32.join(texlive, "latexmk.exe"));
    assert.deepEqual(result.engines, ["xelatex"]);
  });
});

describe("createLatexProbe —— 设置里的显式路径", () => {
  test("显式路径优先于 PATH", async () => {
    const custom = "/opt/custom/latexmk";
    const { deps } = fakeDeps({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      files: [custom, "/usr/bin/latexmk"],
      versions: { [custom]: "Latexmk ... Version 9.99" },
    });
    const result = await createLatexProbe(deps).probe(custom);
    assert.equal(result.source, "setting");
    assert.equal(result.latexmk, custom);
    assert.match(result.version ?? "", /9\.99/);
  });

  test("显式路径坏掉时退回 PATH（不把用户的一次手误变成编译不了）", async () => {
    const { deps } = fakeDeps({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      files: ["/usr/bin/latexmk"],
      versions: { "/opt/gone/latexmk": null },
    });
    const result = await createLatexProbe(deps).probe("/opt/gone/latexmk");
    assert.equal(result.source, "path");
    assert.equal(result.latexmk, "/usr/bin/latexmk");
  });
});

describe("createLatexProbe —— 缓存", () => {
  test("同一进程只验活一次，refresh 之后重新探", async () => {
    const bin = "/opt/texlive/bin";
    const { deps, versionCalls } = fakeDeps({
      platform: "linux",
      env: { PATH: bin },
      files: [`${bin}/latexmk`],
    });
    const probe = createLatexProbe(deps);
    const first = await probe.probe();
    const second = await probe.probe();
    assert.equal(first, second, "缓存应复用同一个对象");
    assert.equal(versionCalls.length, 1);
    probe.refresh();
    await probe.probe();
    assert.equal(versionCalls.length, 2);
  });
});

describe("createLatexProbe —— 找过的位置（引导卡要回答「找过哪里」）", () => {
  test("没装时列出 PATH 各段与常见根，不只是「没找到」", async () => {
    const { deps } = fakeDeps({
      platform: "linux",
      env: { PATH: "/usr/bin:/opt/bin" },
      dirs: [
        "/usr/local/texlive",
        "/usr/local/texlive/2024",
        "/usr/local/texlive/2024/bin/x86_64-linux",
      ],
    });
    const result = await createLatexProbe(deps).probe();
    assert.equal(result.ok, false);
    assert.ok(result.searched.includes("/usr/bin"));
    assert.ok(result.searched.includes("/opt/bin"));
    assert.ok(result.searched.includes("/usr/local/texlive/2024/bin/x86_64-linux"));
    assert.ok(result.searched.length >= 3);
  });

  test("显式路径命中时它也记进找过的位置（排最前）", async () => {
    const custom = "/opt/custom/latexmk";
    const { deps } = fakeDeps({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      files: [custom],
      versions: { [custom]: "Latexmk ... Version 9.99" },
    });
    const result = await createLatexProbe(deps).probe(custom);
    assert.equal(result.searched[0], "/opt/custom");
  });

  test("缓存按显式路径分键：换一个路径会现验一次，切回来不再验", async () => {
    const a = "/opt/a/latexmk";
    const b = "/opt/b/latexmk";
    const { deps, versionCalls } = fakeDeps({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      files: [a, b],
      versions: { [a]: "Latexmk ... Version 1", [b]: "Latexmk ... Version 2" },
    });
    const probe = createLatexProbe(deps);
    await probe.probe(a);
    await probe.probe(b);
    assert.deepEqual(versionCalls, [a, b]);
    await probe.probe(a);
    assert.deepEqual(versionCalls, [a, b], "同一路径的结论复用，不再起一次 Perl");
  });
});
