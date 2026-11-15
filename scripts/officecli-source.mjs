/**
 * OfficeCLI 随包的版本表与取件逻辑（纯逻辑 + 注入 IO / fetch），供 scripts/fetch-officecli.mjs 使用；
 * 测试见 officecli-source.test.mjs。为什么随包（而不是首次运行下载或探测用户自装）见分发调研。
 *
 * 三条硬规则：
 * 1. **版本与 sha256 钉死在这张表里**：校验不过就换下一个源，全都不行就失败——不带一份来路不明的
 *    二进制进安装包。升级时改表（sha256 取上游 release 的 SHA256SUMS / API digest）。
 * 2. **只走版本化不可变路径**（`/releases/download/v<version>/<asset>`）。`/latest/download/` 会随上游
 *    发版漂移，跟我们钉死的 sha256 直接打架。
 * 3. **官方镜像优先、GitHub 兜底**（上游 install.sh / npm 包同一顺序）。实测同网同镜像 292 KB/s、
 *    GitHub assets 2 KB/s，镜像拉完 33 MB 是分钟级，GitHub 是小时级。
 *
 * 许可：OfficeCLI 是 Apache-2.0，随包要带 LICENSE / NOTICE / THIRD-PARTY-NOTICES（resources/licenses/officecli）。
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 上游一天一发；我们按「挑稳定版 + 跑一遍命令面回归」跟版本，不自动跟 latest */
export const OFFICECLI_VERSION = "1.0.158";

const MIRROR_BASE = "https://d.officecli.ai/releases/download";
const GITHUB_BASE = "https://github.com/iOfficeAI/OfficeCLI/releases/download";

/**
 * 每个目标三个字段：
 * - `asset`：上游发布资产名（下载路径用的就是它，带平台后缀）；
 * - `file`：**本地落盘名**（与 rg / fd 同一套约定：就叫 officecli[.exe]），因为
 *   electron-builder 的 extraResources filter 与运行时的 officecli-bin.ts 都按这个名字找它。
 *   两个名字分开是上游资产自带平台后缀的结果，不是我们可以省的。
 * - `sha256`：上游 v1.0.158 的 SHA256SUMS（镜像与 GitHub 两份逐字节一致，2026-11-15 取）。
 *
 * 只有我们在出的两个平台架构在表里——表外平台直接失败，不猜。
 */
export const OFFICECLI_TARGETS = {
  "win32-x64": {
    asset: "officecli-win-x64.exe",
    file: "officecli.exe",
    sha256: "117545f3bc817d7c6d2e78a62e4f73f75b918ccd61558e404c60949a8cb9fd1f",
  },
  "darwin-arm64": {
    asset: "officecli-mac-arm64",
    file: "officecli",
    sha256: "67cf08d95fab556cad9d1e9d0d3b76a7962b5658c716aeaef2e83cbc19af7ff7",
  },
};

/** 下载顺序：镜像在前，GitHub 在后。两个 URL 都是版本化路径。 */
export function releaseUrls(version, asset) {
  return [`${MIRROR_BASE}/v${version}/${asset}`, `${GITHUB_BASE}/v${version}/${asset}`];
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 按顺序尝试每个 URL：网络失败或 sha256 不符都记为这个源不可用，继续下一个；
 * 全都不行才抛错，且把每个源各自的失败原因一起带出来（排障时不用再猜是墙还是哈希）。
 */
export async function fetchVerified({ urls, sha256, fetchBytes }) {
  const failures = [];
  for (const url of urls) {
    let bytes;
    try {
      bytes = await fetchBytes(url);
    } catch (cause) {
      failures.push(`${url}：${cause instanceof Error ? cause.message : String(cause)}`);
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== sha256) {
      failures.push(`${url}：sha256 不符（期望 ${sha256}，实际 ${actual}）`);
      continue;
    }
    return bytes;
  }
  throw new Error(`OfficeCLI 取件失败，没有一个源可用：\n${failures.map((line) => `  - ${line}`).join("\n")}`);
}

const REAL_IO = { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync };

/**
 * 把某个资产落到 `dir`（= build/bin/<platform>-<arch>）。表里的 sha256 由调用方传进来——
 * 这样「按表取件」与「按给定哈希取件」是同一段代码，测试也能拿合成字节走完整路径。
 *
 * 缓存判据与 rg / fd 一致：二进制在 + `<file>.version` 标记内容等于「版本 sha256」→ 跳过重复下载。
 * marker 不匹配（升级了版本）就重下，磁盘上旧的会被覆盖。
 * 非 Windows 补 0755：mac 上 extraResources 保留权限位，不补的话装进包里的二进制不可执行。
 */
export async function ensureAsset({
  target,
  dir,
  version = OFFICECLI_VERSION,
  fetchBytes,
  io = {},
  log = () => {},
}) {
  const { existsSync: exists, readFileSync: readText, writeFileSync: write, mkdirSync: mkdir, chmodSync: chmod } = { ...REAL_IO, ...io };
  const binaryPath = join(dir, target.file);
  const markerPath = `${binaryPath}.version`;
  const stamp = `${version} ${target.sha256}`;

  if (exists(binaryPath) && exists(markerPath) && readText(markerPath, "utf8") === stamp) {
    return { path: binaryPath, action: "cached" };
  }

  const bytes = await fetchVerified({
    urls: releaseUrls(version, target.asset),
    sha256: target.sha256,
    fetchBytes: (url) => {
      log(`↓ ${url}`);
      return fetchBytes(url);
    },
  });
  mkdir(dir, { recursive: true });
  write(binaryPath, bytes);
  if (!target.file.endsWith(".exe")) chmod(binaryPath, 0o755);
  write(markerPath, stamp);
  return { path: binaryPath, action: "downloaded" };
}

/** 按平台架构键取表里那一项；表外平台直接失败，不猜也没有「兜底版本」。 */
export async function ensureOfficecli(options) {
  const target = OFFICECLI_TARGETS[options.targetKey];
  if (target === undefined) {
    throw new Error(`${options.targetKey} 没有钉死的 OfficeCLI 版本——在 scripts/officecli-source.mjs 的表里补上`);
  }
  return ensureAsset({ ...options, target });
}
