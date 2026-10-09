/**
 * 打包前取 rg / fd 到 build/bin/<platform>-<arch>/（electron-builder 再放进 resources/bin）。
 * 理由见 src/main/agent/search-bins.ts。
 *
 * 用法：node scripts/fetch-search-bins.mjs [platform] [arch]   （默认本机）
 *
 * 版本与 sha256 钉死在下表：校验不过就失败，不带一份来路不明的二进制进安装包。
 * 升级时改表（sha256 取 GitHub release 资产的 digest 字段）。已取过同版本就跳过。
 * 许可：ripgrep MIT / Unlicense，fd MIT / Apache-2.0，均可随包分发。
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ASSETS = {
  rg: {
    version: "15.2.0",
    url: (v, a) => `https://github.com/BurntSushi/ripgrep/releases/download/${v}/ripgrep-${v}-${a}`,
    targets: {
      "darwin-arm64": ["aarch64-apple-darwin.tar.gz", "3750b2e93f37e0c692657da574d7019a101c0084da05a790c83fd335bad973e4"],
      "darwin-x64": ["x86_64-apple-darwin.tar.gz", "af7825fcc69a2afc7a7aea55fc9af90e26421d8f20fe59df32e233c0b8a231c1"],
      "win32-x64": ["x86_64-pc-windows-msvc.zip", "71b2fef860abe467217a538ff31de02f5258807c0129f771846f87bd029aafc5"],
    },
  },
  fd: {
    version: "10.5.0",
    url: (v, a) => `https://github.com/sharkdp/fd/releases/download/v${v}/fd-v${v}-${a}`,
    targets: {
      "darwin-arm64": ["aarch64-apple-darwin.tar.gz", "b67e1836c468e42e411984b56e52fa7abec08c2bd22c867398e7cc134aac5e12"],
      "darwin-x64": ["x86_64-apple-darwin.tar.gz", "7e31028c62c6955877735d0406807aa484c2a5e6f86235a59e26c29c301da590"],
      "win32-x64": ["x86_64-pc-windows-msvc.zip", "a227701b8551c35a9931d9f6da75503cf86d88e182d71fb849a70864c5d57cd7"],
    },
  },
};

const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
const target = `${platform}-${arch}`;
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "build", "bin", target);
const exe = platform === "win32" ? ".exe" : "";

/** 在解压目录里找到那个可执行文件（release 包里套了一层版本目录） */
function findFile(dir, name) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const hit = findFile(full, name);
      if (hit !== null) return hit;
    }
  }
  return null;
}

mkdirSync(outDir, { recursive: true });
for (const [name, asset] of Object.entries(ASSETS)) {
  const pinned = asset.targets[target];
  if (pinned === undefined) {
    console.error(`✖ ${name} 没有 ${target} 的钉死版本——在 scripts/fetch-search-bins.mjs 的表里补上`);
    process.exit(1);
  }
  const [suffix, sha256] = pinned;
  const binary = join(outDir, name + exe);
  const marker = join(outDir, `${name}.version`);
  const stamp = `${asset.version} ${sha256}`;
  if (existsSync(binary) && existsSync(marker) && readFileSync(marker, "utf8") === stamp) {
    console.log(`✓ ${name} ${asset.version}（${target}）已就绪，跳过`);
    continue;
  }

  const url = asset.url(asset.version, suffix);
  console.log(`↓ ${url}`);
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`下载失败 ${response.status}：${url}`);
  const archive = Buffer.from(await response.arrayBuffer());
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== sha256) throw new Error(`${name} sha256 不符：期望 ${sha256}，实际 ${actual}`);

  const work = mkdtempSync(join(tmpdir(), `orbita-${name}-`));
  try {
    const file = join(work, suffix.endsWith(".zip") ? "a.zip" : "a.tar.gz");
    writeFileSync(file, archive);
    // macOS 的 bsdtar 与 Windows 10+ 自带的 tar.exe 都能解 zip 与 tar.gz
    execFileSync("tar", ["-xf", file, "-C", work]);
    const found = findFile(work, name + exe);
    if (found === null) throw new Error(`${name}：压缩包里没有 ${name + exe}`);
    copyFileSync(found, binary);
    if (platform !== "win32") chmodSync(binary, 0o755);
    writeFileSync(marker, stamp);
    console.log(`✓ ${name} ${asset.version} → ${binary}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
