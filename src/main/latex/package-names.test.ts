/**
 * 宏包名表的账：kpsewhich 路径解析、扫目录（去重 / 排序 / 上限）、缓存与降级。
 *
 * 全部走注入的假 deps（不读真盘、不起进程）：真机上扫一次 TeX Live 要碰几万个文件，
 * 单测不该依赖装了 TeX。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  collectPackageNames,
  createLatexPackageNameIndex,
  parseTexSearchPath,
  type PackageNameDeps,
  type PackageNameEntry,
  type PackageNameRunResult,
} from "./package-names.ts";

const ROOT = join("C:", "tex", "texmf-dist", "tex", "latex");

describe("parseTexSearchPath", () => {
  test("认 `!!` 前缀、结尾 `//`、引号与空段；去重", () => {
    const stdout = [
      "!!C:\\tex\\texmf-dist\\tex\\latex//",
      "C:\\tex\\texmf\\tex\\latex//",
      "",
      "\"C:\\tex\\texmf-dist\\tex\\latex\"",
    ].join(";");
    assert.deepEqual(parseTexSearchPath(stdout, ";"), [
      "C:\\tex\\texmf-dist\\tex\\latex",
      "C:\\tex\\texmf\\tex\\latex",
    ]);
  });

  test("POSIX 的 `:` 分隔符", () => {
    assert.deepEqual(parseTexSearchPath("/usr/tex/latex//:/usr/share/tex/latex//", ":"), [
      "/usr/tex/latex",
      "/usr/share/tex/latex",
    ]);
  });

  test("空输出 = 空数组", () => {
    assert.deepEqual(parseTexSearchPath("", ";"), []);
  });
});

describe("collectPackageNames", () => {
  const tree = new Map<string, readonly PackageNameEntry[]>([
    [ROOT, [{ name: "amsmath", directory: true }, { name: "booktabs.sty", directory: false }, { name: "notes.txt", directory: false }]],
    [join(ROOT, "amsmath"), [{ name: "amsmath.sty", directory: false }]],
  ]);
  const deps = (): PackageNameDeps => ({
    run: async (): Promise<PackageNameRunResult> => ({ code: 1, stdout: "", spawnError: null }),
    readdir: async (dir) => tree.get(dir) ?? null,
    exists: () => true,
    pathDelimiter: ";",
  });

  test("递归扫 .sty，去重后按名字排序；非 .sty 忽略", async () => {
    const result = await collectPackageNames([ROOT], deps());
    assert.deepEqual(result.names, ["amsmath", "booktabs"]);
    assert.equal(result.truncated, false);
  });

  test("撞到名字上限：停下并标 truncated", async () => {
    // 广度优先：同层的 booktabs.sty 先于 amsmath/ 子目录被看到
    const result = await collectPackageNames([ROOT], deps(), { names: 1, files: 100 });
    assert.deepEqual(result.names, ["booktabs"]);
    assert.equal(result.truncated, true);
  });

  test("撞到文件数上限：同样标 truncated", async () => {
    const result = await collectPackageNames([ROOT], deps(), { names: 100, files: 1 });
    assert.equal(result.truncated, true);
  });

  test("目录读不了 / 不存在：跳过，不抛", async () => {
    const result = await collectPackageNames([join("C:", "nowhere"), ROOT], deps());
    assert.deepEqual(result.names, ["amsmath", "booktabs"]);
  });
});

describe("createLatexPackageNameIndex", () => {
  const styDeps = (options: {
    kpsewhich: (() => PackageNameRunResult) | null;
    dirs?: string[];
  }): { deps: PackageNameDeps; runs: () => number } => {
    let runs = 0;
    const latexDir = "/usr/share/texmf-dist/tex/latex";
    const deps: PackageNameDeps = {
      run: async (command) => {
        runs += 1;
        if (options.kpsewhich === null || !command.includes("kpsewhich")) {
          return { code: null, stdout: "", spawnError: "ENOENT" };
        }
        return options.kpsewhich();
      },
      readdir: async (dir) =>
        dir === latexDir
          ? [
              { name: "hyperref.sty", directory: false },
              { name: "geometry.sty", directory: false },
            ]
          : null,
      exists: (path) => path === latexDir || (options.dirs ?? []).includes(path),
      pathDelimiter: ":",
    };
    return { deps, runs: () => runs };
  };

  test("kpsewhich 给目录 → 扫出名字；第二次调用走缓存（不再起进程）", async () => {
    const { deps, runs } = styDeps({ kpsewhich: () => ({ code: 0, stdout: "/usr/share/texmf-dist/tex/latex//", spawnError: null }) });
    const index = createLatexPackageNameIndex(deps);
    const first = await index.list("/usr/bin/latexmk");
    const second = await index.list("/usr/bin/latexmk");
    assert.deepEqual(first, { available: true, names: ["geometry", "hyperref"], truncated: false });
    assert.equal(second, first);
    assert.equal(runs(), 1);
  });

  test("没有 kpsewhich、也没有兜底目录 → available:false 空名单（界面退回只补已加载的）", async () => {
    const { deps } = styDeps({ kpsewhich: null });
    const outcome = await createLatexPackageNameIndex(deps).list("/usr/bin/latexmk");
    assert.deepEqual(outcome, { available: false, names: [], truncated: false });
  });

  test("kpsewhich 起不来但 latexmk 在 → 用兜底目录猜 tex/latex", async () => {
    const latexmk = join("/opt/texlive/2025", "bin", "x86_64-linux", "latexmk");
    const guess = join("/opt/texlive/2025", "texmf-dist", "tex", "latex");
    const { deps } = styDeps({ kpsewhich: null, dirs: [guess] });
    // 兜底目录里也要有 .sty：把 readdir 指向它
    const withGuess: PackageNameDeps = {
      ...deps,
      readdir: async (dir) =>
        dir === guess ? [{ name: "ctex.sty", directory: false }] : null,
    };
    const outcome = await createLatexPackageNameIndex(withGuess).list(latexmk);
    assert.deepEqual(outcome, { available: true, names: ["ctex"], truncated: false });
  });
});
