/**
 * 打包前取 llama-server 到 build/bin/<platform>-<arch>/llama/（electron-builder 再放进
 * resources/bin/llama）。记忆系统的向量召回用它跑本地嵌入模型。
 *
 * 用法：node scripts/fetch-llama.mjs [platform] [arch]   （默认本机）
 *
 * 版本与 sha256 钉死在下表（sha256 取 GitHub release 资产实测）：校验不过就失败，
 * 不带一份来路不明的二进制进安装包。已取过同版本就跳过。
 * 注意 Windows 包不是单 exe：llama-server.exe 是壳，实现在 llama-server-impl.dll，
 * 还要 ggml 系列 dll（按 CPU 微架构自动选）与 libomp——按白名单整套拷。
 * 许可：llama.cpp MIT（LICENSE 随包分发）＋ LLVM-OpenMP（win 包自带 LICENSE）。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const LLAMA = {
  version: "b11976",
  url: (target) =>
    target === "darwin-arm64"
      ? "https://github.com/ggml-org/llama.cpp/releases/download/b11976/llama-b11976-bin-macos-arm64.tar.gz"
      : "https://github.com/ggml-org/llama.cpp/releases/download/b11976/llama-b11976-bin-win-cpu-x64.zip",
  sha256: {
    "darwin-arm64": "db607e6657f74e7bdbc1f608641a6d2c551141ae226004b7f7d1d2b8ab0d960a",
    "win32-x64": "c7d5d65986917da50bfd4aad0d127648a70b61ec457a2b83ec42570e49fbe25b",
  },
  /**
   * 从解压目录拷进 build/bin 的文件集（win 按「前缀/通配」匹配）。mac 的
   * llama-server 不是自包含的（otool -L 实测）：impl / common / llama / ggml
   * 全家都要；dylib 带版本后缀的三份都拷（链接器按 soname 找）。
   */
  keep: {
    "darwin-arm64": [
      "llama-server",
      "libllama-server-impl.dylib",
      /^libllama-common\..*\.dylib$/,
      /^libmtmd\..*\.dylib$/,
      /^libllama\..*\.dylib$/,
      /^libggml.*\.dylib$/,
      "LICENSE",
    ],
    "win32-x64": [
      "llama-server.exe",
      "llama-server-impl.dll",
      "llama-common.dll",
      "llama.dll",
      "ggml.dll",
      "ggml-base.dll",
      /^ggml-cpu-.*\.dll$/,
      "libomp.dll",
      /^LICENSE/,
    ],
  },
};

const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
const target = `${platform}-${arch}`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build", "bin", target, "llama");

const pinned = LLAMA.sha256[target];
if (pinned === undefined) {
  console.error(`✖ llama-server 没有 ${target} 的钉死版本——本脚本只备 darwin-arm64 与 win32-x64`);
  process.exit(1);
}

const server = join(outDir, platform === "win32" ? "llama-server.exe" : "llama-server");
const marker = join(outDir, ".version");
const stamp = `${LLAMA.version} ${pinned}`;
if (existsSync(server) && existsSync(marker) && readFileSync(marker, "utf8") === stamp) {
  console.log(`✓ llama-server ${LLAMA.version}（${target}）已就绪，跳过`);
  process.exit(0);
}

const url = LLAMA.url(target);
console.log(`↓ ${url}`);
const response = await fetch(url, { signal: AbortSignal.timeout(300_000) });
if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
const archive = Buffer.from(await response.arrayBuffer());
const actual = createHash("sha256").update(archive).digest("hex");
if (actual !== pinned) throw new Error(`llama-server sha256 不符：期望 ${pinned}，实际 ${actual}`);

const work = mkdtempSync(join(tmpdir(), "orbita-llama-"));
try {
  const file = join(work, "a.archive");
  writeFileSync(file, archive);
  // macOS 的 bsdtar 与 Windows 10+ 自带的 tar.exe 都能解 zip 与 tar.gz（fetch-search-bins 同款）
  execFileSync("tar", ["-xf", file, "-C", work]);
  const extracted = readdirSync(work, { withFileTypes: true }).find((entry) => entry.isDirectory());
  const inner = extracted === undefined ? work : join(work, extracted.name);
  const wanted = readdirSync(inner).filter((name) =>
    LLAMA.keep[target].some((pattern) => (pattern instanceof RegExp ? pattern.test(name) : pattern === name)),
  );
  const missing = LLAMA.keep[target].filter((pattern) => !(pattern instanceof RegExp) && !wanted.includes(pattern));
  if (missing.length > 0) throw new Error(`压缩包里缺文件：${missing.join(", ")}`);
  if (wanted.length === 0) throw new Error("压缩包里一个白名单文件都没匹配到");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const name of wanted) {
    copyFileSync(join(inner, name), join(outDir, name));
    if (platform !== "win32" && !name.endsWith(".dylib") && name !== "LICENSE") {
      chmodSync(join(outDir, name), 0o755);
    }
  }
  writeFileSync(marker, stamp);
  console.log(`✓ llama-server ${LLAMA.version} → ${outDir}（${wanted.length} 个文件）`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
