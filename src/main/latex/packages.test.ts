/**
 * 缺宏包反查的回归网：**文件名不是包名**这件事只能靠真命令答，所以这里测的是
 * 命令解析与「查不到时不许猜」。
 *
 * 夹具是 TeX Live 2025 在本机实测的输出形状（`ctex:` 顶格、路径缩进一行）；
 * `--global` 的远端输出不在这里，因为代码只用本地 tlpdb（理由见 packages.ts 头注）。
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  createLatexPackageLookup,
  installCommandFor,
  isLookupableFile,
  needsSudo,
  parseMpmFind,
  parseTlmgrSearch,
  pickPackage,
  type PackageDeps,
  type PackageRunResult,
} from "./packages.ts";

const OK = (stdout = ""): PackageRunResult => ({ code: 0, stdout, stderr: "", spawnError: null });
const FAIL: PackageRunResult = { code: null, stdout: "", stderr: "", spawnError: "ENOENT" };

interface FakeOptions {
  /** 存在的文件（绝对路径）。latexmk 也算在内 */
  files?: string[];
  /** 命令 → 输出；键是 `<命令> <参数…>` */
  replies?: Record<string, PackageRunResult | undefined>;
}

interface FakeTooling {
  deps: PackageDeps;
  calls: string[];
}

function fakeDeps(options: FakeOptions = {}): FakeTooling {
  const files = new Set(options.files ?? []);
  const calls: string[] = [];
  const deps: PackageDeps = {
    platform: "linux",
    env: { PATH: "/usr/local/texlive/2025/bin/x86_64-linux" },
    exists: (path) => files.has(path),
    realpath: (path) => path,
    run: (command, argv) => {
      const key = [command, ...argv].join(" ");
      calls.push(key);
      return Promise.resolve(options.replies?.[key] ?? FAIL);
    },
  };
  return { deps, calls };
}

/**
 * 路径用 join 拼：这个模块用宿主的 node:path 拼候选（生产里那是正确的平台语义），
 * 测试夹具跟着宿主的斜杠走，才能在 Windows 与 POSIX 上跑出同一份 exists / run 键。
 */
const TL_DIR = join("/usr/local/texlive/2025/bin/x86_64-linux");
const tl = (name: string): string => join(TL_DIR, name);
const TL_FILES = [tl("latexmk"), tl("tlmgr"), tl("kpsewhich")];

describe("parseTlmgrSearch", () => {
  test("包名是顶格冒号行，缩进的路径不算", () => {
    const stdout = "ctex:\n\ttexmf-dist/tex/latex/ctex/ctexart.cls\n";
    assert.deepEqual(parseTlmgrSearch(stdout), ["ctex"]);
  });

  test("tlmgr 自己的提示行（带空格的长句）不会被当成包名", () => {
    const stdout =
      "tlmgr.pl: Local TeX Live (2025) is older than remote repository (2026).\n" + "booktabs:\n\ttexmf-dist/tex/latex/booktabs/booktabs.sty\n";
    assert.deepEqual(parseTlmgrSearch(stdout), ["booktabs"]);
  });

  test("空输出 = 没查到（发行版里没有这个文件）", () => {
    assert.deepEqual(parseTlmgrSearch(""), []);
  });

  test("多个包各算一个，去重", () => {
    const stdout = "a:\n\tx/a.sty\nb:\n\ty/a.sty\na:\n\tz/a.sty\n";
    assert.deepEqual(parseTlmgrSearch(stdout), ["a", "b"]);
  });
});

describe("parseMpmFind", () => {
  test("裸包名与 Package: 前缀都认", () => {
    assert.deepEqual(parseMpmFind("ctex\n"), ["ctex"]);
    assert.deepEqual(parseMpmFind("Package: booktabs\n"), ["booktabs"]);
  });

  test("长句子不当包名", () => {
    assert.deepEqual(parseMpmFind("The file was not found in any package.\n"), []);
  });
});

describe("pickPackage", () => {
  test("多个包都包含同一文件时，跳过 latex-dev 的镜像包", () => {
    // 真机 tlmgr 的输出顺序：dev 在前
    assert.equal(pickPackage(["latex-tools-dev", "tools"]), "tools");
    assert.equal(pickPackage(["latex", "latex-base-dev"]), "latex");
  });

  test("只有一个就取它；没有就是 null", () => {
    assert.equal(pickPackage(["ctex"]), "ctex");
    assert.equal(pickPackage([]), null);
    // 全带 -dev（罕见）也不至于没有结果
    assert.equal(pickPackage(["only-dev"]), "only-dev");
  });
});

describe("isLookupableFile", () => {
  test("只放行 x.sty / x.cls（名字会进命令行）", () => {
    assert.equal(isLookupableFile("ctexart.cls"), true);
    assert.equal(isLookupableFile("booktabs.sty"), true);
    assert.equal(isLookupableFile("a+b.sty"), true);
    assert.equal(isLookupableFile("../../etc/passwd"), false);
    assert.equal(isLookupableFile("x.sty; rm -rf /"), false);
    assert.equal(isLookupableFile("ctexart.tex"), false);
    assert.equal(isLookupableFile(""), false);
  });
});

describe("installCommandFor", () => {
  test("TeX Live / MiKTeX 各自的写法", () => {
    assert.equal(installCommandFor("texlive", "ctex", false), "tlmgr install ctex");
    assert.equal(installCommandFor("texlive", "ctex", true), "sudo tlmgr install ctex");
    assert.equal(installCommandFor("miktex", "ctex", false), "mpm --install=ctex");
  });

  test("认不出发行版就不给命令（不猜 tlmgr）", () => {
    assert.equal(installCommandFor(null, "ctex", false), null);
    assert.equal(installCommandFor("texlive", "", false), null);
  });

  test("包名形状不对就不给命令（纵深防御）", () => {
    assert.equal(installCommandFor("texlive", "ctex;curl$IFS", false), null);
    assert.equal(installCommandFor("miktex", "a b", false), null);
  });
});

describe("needsSudo", () => {
  const identity = (path: string): string => path;

  test("macOS 的 /usr/local/texlive（BasicTeX / MacTeX）要 sudo", () => {
    assert.equal(needsSudo("darwin", "/usr/local/texlive/2024basic/bin/universal-darwin/tlmgr", identity), true);
    assert.equal(needsSudo("darwin", "/usr/local/texlive/2024/bin/universal-darwin/tlmgr", identity), true);
  });

  test("Homebrew 的 texlive 不要 sudo；Windows / Linux 一律不加", () => {
    assert.equal(needsSudo("darwin", "/opt/homebrew/bin/tlmgr", identity), false);
    assert.equal(needsSudo("win32", "C:\\texlive\\2025\\bin\\windows\\tlmgr.bat", identity), false);
    assert.equal(needsSudo("linux", "/usr/local/texlive/2025/bin/x86_64-linux/tlmgr", identity), false);
  });

  test("软链解析后的真路径才算数（/Library/TeX/texbin 看不出是哪一档）", () => {
    const symlinked = (path: string): string =>
      path === "/Library/TeX/texbin/tlmgr" ? "/usr/local/texlive/2024basic/bin/universal-darwin/tlmgr" : path;
    assert.equal(needsSudo("darwin", "/Library/TeX/texbin/tlmgr", symlinked), true);
  });
});

describe("createLatexPackageLookup —— TeX Live", () => {
  const texlive = (replies: Record<string, PackageRunResult | undefined>, files = TL_FILES): FakeTooling =>
    fakeDeps({
      files,
      replies: {
        [`${tl("tlmgr")} --version`]: OK("tlmgr revision 74241"),
        [`${tl("kpsewhich")} --all ctexart.cls`]: OK(""),
        [`${tl("tlmgr")} search --file /ctexart.cls`]: OK("ctex:\n\ttexmf-dist/tex/latex/ctex/ctexart.cls\n"),
        ...replies,
      },
    });

  test("文件名 → tlmgr 包名 → tlmgr install 命令", async () => {
    const tooling = texlive({});
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["ctexart.cls"]);
    assert.deepEqual(resolved, {
      missing: "ctexart.cls",
      packageName: "ctex",
      command: "tlmgr install ctex",
      sudo: false,
      installed: false,
      distro: "texlive",
      reason: null,
    });
    // 查询用的是「路径结尾」形态：/ctexart.cls
    assert.ok(tooling.calls.includes(`${tl("tlmgr")} search --file /ctexart.cls`));
  });

  test("发行版里没有这个文件 → 未知包，不给命令", async () => {
    const tooling = texlive({
      [`${tl("tlmgr")} search --file /doesnotexistxyz.sty`]: OK(""),
      [`${tl("kpsewhich")} --all doesnotexistxyz.sty`]: OK(""),
    });
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["doesnotexistxyz.sty"]);
    assert.equal(resolved?.packageName, null);
    assert.equal(resolved?.command, null);
    assert.equal(resolved?.distro, "texlive");
    // 命令跑成了但没人认领 → not-found；不能说成「没装 tlmgr」
    assert.equal(resolved?.reason, "not-found");
  });

  test("kpsewhich 已经能定位到 → 包名照给，但不给安装命令", async () => {
    const tooling = texlive({
      [`${tl("kpsewhich")} --all ctexart.cls`]: OK("g:/texlive/2025/texmf-dist/tex/latex/ctex/ctexart.cls\n"),
    });
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["ctexart.cls"]);
    assert.equal(resolved?.installed, true);
    assert.equal(resolved?.packageName, "ctex");
    assert.equal(resolved?.command, null);
  });

  test("反查命令起不来 → 不抛、不猜（问题抽屉照常能显示文件名）", async () => {
    const tooling = fakeDeps({ files: [tl("latexmk")] });
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["whatever.sty"]);
    assert.equal(resolved?.distro, null);
    assert.equal(resolved?.packageName, null);
    assert.equal(resolved?.command, null);
    assert.equal(resolved?.reason, "no-tools");
  });

  test("文件名不合法 → reason 是 invalid-name，与「没装工具」分开", async () => {
    const tooling = texlive({});
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["a&b.sty"]);
    assert.equal(resolved?.reason, "invalid-name");
    assert.equal(resolved?.distro, null);
    // 而且根本没起命令
    assert.equal(tooling.calls.some((call) => call.includes("a&b")), false);
  });

  test("tlmgr 在但 search 非零退出 → tool-error（不是 not-found，也不是 no-tools）", async () => {
    const tooling = texlive({
      [`${tl("tlmgr")} search --file /ctexart.cls`]: { code: 3, stdout: "", stderr: "boom", spawnError: null },
    });
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["ctexart.cls"]);
    assert.equal(resolved?.reason, "tool-error");
    assert.equal(resolved?.distro, "texlive");
  });

  test("同一文件只查一次（重编十遍不该起十遍 tlmgr）", async () => {
    const tooling = texlive({});
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    await lookup.resolve(["ctexart.cls"]);
    await lookup.resolve(["ctexart.cls"]);
    const searches = tooling.calls.filter((call) => call.includes("search --file"));
    assert.equal(searches.length, 1);
  });

  test("恶意 / 非 sty-cls 名字不进入命令行", async () => {
    const tooling = texlive({});
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["../../etc/passwd"]);
    assert.equal(resolved?.packageName, null);
    assert.equal(resolved?.command, null);
    assert.equal(
      tooling.calls.some((call) => call.includes("passwd")),
      false,
    );
  });
});

describe("createLatexPackageLookup —— MiKTeX", () => {
  test("tlmgr 不在、mpm 在 → mpm --install", async () => {
    const dir = join("/Users/me/AppData/Local/Programs/MiKTeX/miktex/bin/x64");
    const bin = (name: string): string => join(dir, name);
    const tooling = fakeDeps({
      files: [bin("latexmk"), bin("mpm"), bin("kpsewhich")],
      replies: {
        [`${bin("mpm")} --version`]: OK("MiKTeX 24.1"),
        [`${bin("kpsewhich")} --all booktabs.sty`]: OK(""),
        [`${bin("mpm")} --find-file=booktabs.sty`]: OK("booktabs\n"),
      },
    });
    const lookup = createLatexPackageLookup(async () => bin("latexmk"), tooling.deps);
    const [resolved] = await lookup.resolve(["booktabs.sty"]);
    assert.equal(resolved?.distro, "miktex");
    assert.equal(resolved?.packageName, "booktabs");
    assert.equal(resolved?.command, "mpm --install=booktabs");
    assert.equal(resolved?.sudo, false);
  });
});

describe("createLatexPackageLookup —— 批量", () => {
  test("7 个缺包全部有结果（并发反查，不留「正在反查」的死角）", async () => {
    const replies: Record<string, PackageRunResult | undefined> = { [`${tl("tlmgr")} --version`]: OK("") };
    for (let index = 0; index < 7; index += 1) {
      replies[`${tl("tlmgr")} search --file /p${index}.sty`] = OK(`pkg-${index}:
	x/p${index}.sty
`);
    }
    const tooling = fakeDeps({ files: TL_FILES, replies });
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const names = Array.from({ length: 7 }, (_, index) => `p${index}.sty`);
    const out = await lookup.resolve(names);
    assert.equal(out.length, 7);
    assert.deepEqual(out.map((entry) => entry.packageName), names.map((_, index) => `pkg-${index}`));
  });

  test("超过上限的名字明确标 not-looked-up（界面不许一直转圈）", async () => {
    const tooling = fakeDeps({ files: TL_FILES, replies: { [`${tl("tlmgr")} --version`]: OK("") } });
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const names = Array.from({ length: 22 }, (_, index) => `p${index}.sty`);
    const out = await lookup.resolve(names);
    assert.equal(out.length, 22);
    const skipped = out.filter((entry) => entry.reason === "not-looked-up");
    assert.equal(skipped.length, 2);
  });

  test("顺序与请求一致、重复名字只算一条", async () => {
    const tooling = fakeDeps({
      files: TL_FILES,
      replies: {
        [`${tl("tlmgr")} --version`]: OK(""),
        [`${tl("tlmgr")} search --file /a.sty`]: OK("pkg-a:\n\tx/a.sty\n"),
        [`${tl("tlmgr")} search --file /b.cls`]: OK("pkg-b:\n\tx/b.cls\n"),
      },
    });
    const lookup = createLatexPackageLookup(async () => tl("latexmk"), tooling.deps);
    const out = await lookup.resolve(["a.sty", "b.cls", "a.sty"]);
    assert.deepEqual(out.map((entry) => entry.packageName), ["pkg-a", "pkg-b"]);
  });
});
