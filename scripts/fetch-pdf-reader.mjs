/**
 * 构建 PDF 阅读器（zotero/reader 的 web 版，AGPL-3.0）到 build/pdf-reader/（不进仓；打包时
 * electron-builder 再放进 resources/pdf-reader）。实验功能「PDF 阅读器」用它。
 *
 * 用法：node scripts/fetch-pdf-reader.mjs        （已构建同一版本就跳过；--force 重来）
 *
 * 钉死的东西（升级 reader 时一并改这张表，并重跑阅读器的回归）：
 * - reader 提交、两个用到的子模块提交（pdf.js、epub.js）——克隆后逐个核对，不符就失败；
 * - 语言文件所在的 Zotero 提交（reader 仓库里 `.zotero-locale-commit` 的值）与四份 ftl 的 sha256；
 * - **不拉** `structured-document-text` 子模块：它没有许可证文件。reader 静态 import 它，构建时由
 *   webpack 换成我们的空桩（pdf-reader/webpack.orbita.cjs、pdf-reader/sdt-stub.mjs），并在产物里
 *   搜 SDT 源码独有的字符串，搜到就失败（`findSdtMarkers`）。
 *
 * 产物：build/pdf-reader/app/（webpack 的 build/web + locales/）、build/pdf-reader/licenses/
 * （reader 的 COPYING、pdf.js 的 LICENSE、epub.js 的 license；第三方声明 *.LICENSE.txt 在 app/ 里随产物走），
 * build/pdf-reader/manifest.json（钉住的提交 + 每个文件的 sha256，主进程打开阅读器前按它核对一遍）。
 *
 * 需要：git、node 18+ 与 npm（reader 用 npm 的 lock，我们按它的 lock 原样 `npm ci`，不改它的依赖解析）、
 * bash（reader 的 pdf.js 构建脚本是 bash；Windows 上要有 Git Bash，未实测）。会联网：GitHub 克隆、
 * npm registry、raw.githubusercontent.com（语言文件）。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const READER = {
  repo: "https://github.com/zotero/reader.git",
  commit: "5581a8daa72013ae7424d41688dfbab5100b47ec",
  /** 只拉这两个子模块；第三个 structured-document-text 故意不拉 */
  submodules: {
    "pdfjs/pdf.js": "5f95f712bc629ac11159cb4859ed8091fdffa87b",
    "epubjs/epub.js": "e68c8b9c868be6ccb5b9684213117e95e52ef880",
  },
  localeCommit: "a6a919234a360f5cc0f8dbf45b84e1fafc546f41",
  /** 语言文件：`<locale>/<file>` → sha256（首次下载实测后钉死） */
  ftl: {
    "en-US/zotero.ftl": "e8a652d7f24627e600c6cc555f1a1ea298d895c95d7356fac7607816361c989e",
    "en-US/reader.ftl": "99fe698130f6b794f72a0140559b90e80138e002b06d80ddfdb9c34a01381d7d",
    "zh-CN/zotero.ftl": "bd03c9eb2c828ff699e47090ac822428b81153a111aea34184015c4c0e013d31",
    "zh-CN/reader.ftl": "65e4e9caf00c294dd399ff0abcf75d55d69892cb2e66eb8c79bb31841e24148f",
  },
};

/**
 * SDT 源码里独有的字符串（报错文案，压缩后原样留在产物里；reader 自己的源码里没有）。产物里出现任何一条
 * = 有 SDT 代码漏进了包。2026-11-16 用未桩的试验构建核对过：后三条都能在它的 reader.js 里搜到。
 */
export const SDT_MARKERS = [
  "splitContentPoint requires content",
  "Invalid SDTPack",
  "Unsupported SDTPack version",
  "SDTPack schemaVersion must be",
];

/** 在目录里找 SDT 标记：返回 `相对路径: 标记` 列表（只看 js / mjs） */
export function findSdtMarkers(dir) {
  const hits = [];
  for (const file of walk(dir)) {
    if (!/\.m?js$/.test(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const marker of SDT_MARKERS) if (text.includes(marker)) hits.push(`${relative(dir, file)}: ${marker}`);
  }
  return hits;
}

/** `git submodule status` 的输出与钉死的提交逐个对：返回不符的说明（空 = 全对）；未初始化的（行首 `-`）算缺 */
export function submoduleMismatches(statusText, pinned) {
  const actual = new Map();
  for (const line of statusText.split("\n")) {
    const match = /^([ +\-U])([0-9a-f]{40}) (\S+)/.exec(line);
    if (match !== null) actual.set(match[3], match[1] === "-" ? null : match[2]);
  }
  const problems = [];
  for (const [path, sha] of Object.entries(pinned)) {
    const got = actual.get(path);
    if (got !== sha) problems.push(`${path}: 期望 ${sha}，实际 ${got ?? "未拉取"}`);
  }
  return problems;
}

/** 目录下全部文件（递归，按路径排序，manifest 要稳定） */
export function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else if (entry.isFile()) out.push(path);
  }
  return out.sort();
}

export function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

/** manifest：钉住的版本 + 每个文件（相对 out 根、正斜杠）的 sha256 */
export function buildManifest(outDir) {
  const files = {};
  for (const file of walk(outDir)) {
    const rel = relative(outDir, file).split(sep).join("/");
    if (rel === "manifest.json") continue;
    files[rel] = sha256(readFileSync(file));
  }
  return { schema: 1, commit: READER.commit, submodules: READER.submodules, localeCommit: READER.localeCommit, files };
}

function run(cmd, args, cwd, env = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}  (${cwd})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit", env: { ...process.env, ...env } });
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function fetchFtl() {
  const out = {};
  for (const [key, pinned] of Object.entries(READER.ftl)) {
    const [locale, file] = key.split("/");
    const url = `https://raw.githubusercontent.com/zotero/zotero/${READER.localeCommit}/chrome/locale/${locale}/zotero/${file}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`语言文件下载失败 ${response.status}：${url}`);
    const body = Buffer.from(await response.arrayBuffer());
    const actual = sha256(body);
    if (actual !== pinned) throw new Error(`${key} sha256 不符：期望 ${pinned}，实际 ${actual}`);
    out[key] = body;
  }
  return out;
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const srcDir = join(root, "build", "pdf-reader-src");
  const outDir = join(root, "build", "pdf-reader");
  const force = process.argv.includes("--force");

  const manifestPath = join(outDir, "manifest.json");
  if (!force && existsSync(manifestPath)) {
    const current = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (current.commit === READER.commit) {
      console.log(`✓ 阅读器 ${READER.commit.slice(0, 7)} 已构建，跳过（--force 重来）`);
      return;
    }
  }

  // 1. 克隆：只取钉住的提交（浅克隆），只初始化两个用到的子模块
  if (!existsSync(join(srcDir, ".git")) || git(["rev-parse", "HEAD"], srcDir).trim() !== READER.commit) {
    rmSync(srcDir, { recursive: true, force: true });
    mkdirSync(srcDir, { recursive: true });
    run("git", ["init", "-q"], srcDir);
    run("git", ["remote", "add", "origin", READER.repo], srcDir);
    run("git", ["fetch", "-q", "--depth", "1", "origin", READER.commit], srcDir);
    run("git", ["checkout", "-q", "--detach", "FETCH_HEAD"], srcDir);
  }
  run("git", ["submodule", "update", "--init", "--depth", "1", ...Object.keys(READER.submodules)], srcDir);
  const problems = submoduleMismatches(git(["submodule", "status"], srcDir), READER.submodules);
  if (problems.length > 0) throw new Error(`子模块与钉住的提交不符：\n${problems.join("\n")}`);
  if (existsSync(join(srcDir, "structured-document-text", "src"))) {
    throw new Error("structured-document-text 子模块被拉下来了——它没有许可证，构建里不该有它");
  }
  const localeCommit = readFileSync(join(srcDir, ".zotero-locale-commit"), "utf8").trim();
  if (localeCommit !== READER.localeCommit) throw new Error(`.zotero-locale-commit 是 ${localeCommit}，与钉住的 ${READER.localeCommit} 不符`);

  // 2. 依赖与 pdf.js（reader 自己的构建脚本，按它的 lock 装）
  run("npm", ["ci", "--no-audit", "--no-fund"], srcDir);
  run("bash", ["pdfjs/build"], srcDir, { PDFJS_CONFIG: "web" });

  // 3. webpack：reader 的 web 配置 + 我们的外包（SDT 换桩）
  copyFileSync(join(root, "scripts", "pdf-reader", "webpack.orbita.cjs"), join(srcDir, "webpack.orbita.cjs"));
  copyFileSync(join(root, "scripts", "pdf-reader", "sdt-stub.mjs"), join(srcDir, "orbita-sdt-stub.mjs"));
  run("npx", ["webpack", "--config", "webpack.orbita.cjs"], srcDir);

  const built = join(srcDir, "build", "web");
  const hits = findSdtMarkers(built);
  if (hits.length > 0) throw new Error(`产物里有 structured-document-text 的代码：\n${hits.join("\n")}`);

  // 4. 组装：先写到临时目录，全部成功再换上去（中途失败不留半份产物）
  const ftl = await fetchFtl();
  const staging = `${outDir}.tmp`;
  rmSync(staging, { recursive: true, force: true });
  cpSync(built, join(staging, "app"), { recursive: true });
  for (const [key, body] of Object.entries(ftl)) {
    mkdirSync(join(staging, "app", "locales", dirname(key)), { recursive: true });
    writeFileSync(join(staging, "app", "locales", key), body);
  }
  mkdirSync(join(staging, "licenses"), { recursive: true });
  copyFileSync(join(srcDir, "COPYING"), join(staging, "licenses", "reader-COPYING.txt"));
  copyFileSync(join(srcDir, "pdfjs", "pdf.js", "LICENSE"), join(staging, "licenses", "pdf.js-LICENSE.txt"));
  copyFileSync(join(srcDir, "epubjs", "epub.js", "license"), join(staging, "licenses", "epub.js-license.txt"));
  writeFileSync(
    join(staging, "licenses", "SOURCE.txt"),
    [
      "PDF 阅读器来自 zotero/reader（AGPL-3.0），未改源码，构建方式见 Orbita 仓库 scripts/fetch-pdf-reader.mjs。",
      `源码：${READER.repo} 提交 ${READER.commit}`,
      ...Object.entries(READER.submodules).map(([path, sha]) => `子模块 ${path}：${sha}`),
      "子模块 structured-document-text 未包含（构建时以空桩替换，见 scripts/pdf-reader/sdt-stub.mjs）。",
      `语言文件：https://github.com/zotero/zotero 提交 ${READER.localeCommit}`,
      "“Zotero” 是 Corporation for Digital Scholarship 的商标；Orbita 不以它作为自己的品牌。",
      "",
    ].join("\n"),
  );
  writeFileSync(join(staging, "manifest.json"), `${JSON.stringify(buildManifest(staging), null, 2)}\n`);
  rmSync(outDir, { recursive: true, force: true });
  renameSync(staging, outDir);
  const size = walk(outDir).reduce((sum, file) => sum + statSync(file).size, 0);
  console.log(`✓ 阅读器 ${READER.commit.slice(0, 7)} → ${outDir}（${(size / 1024 / 1024).toFixed(1)} MB）`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((cause) => {
    console.error(`✖ ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  });
}
