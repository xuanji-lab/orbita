/**
 * 打包前取 OfficeCLI 到 build/bin/<platform>-<arch>/（electron-builder 再放进 resources/bin）。
 * 版本表、下载顺序、sha256 校验都在 officecli-source.mjs（有测试）。
 *
 * 用法：node scripts/fetch-officecli.mjs [platform] [arch]   （默认本机）
 *
 * 二进制不进 git（.gitignore 的 /build/bin/）。已取过同版本 + 同 sha256 就跳过。
 * 许可：Apache-2.0；LICENSE / NOTICE / THIRD-PARTY-NOTICES 在 resources/licenses/officecli，随包发。
 */
import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICECLI_VERSION, ensureOfficecli } from "./officecli-source.mjs";

/**
 * 卡住多久算断线。**不是总超时**：33 MB 在慢网实测只有 ~35 KB/s，总时长本来就该是分钟级，
 * 用总超时掐会在正常慢网上下错杀人。这里按「多久没收到一个字节」判，断了立刻失败换下一个源。
 */
const STALL_TIMEOUT_MS = 120_000;
/** 进度行节流：慢网下载十几分钟，没输出会让人以为卡死 */
const PROGRESS_EVERY_MS = 15_000;

function formatBytes(bytes) {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

async function fetchBytes(url) {
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  const touch = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), STALL_TIMEOUT_MS);
  };
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get("content-length") ?? 0);
    const chunks = [];
    let received = 0;
    let lastReport = Date.now();
    for await (const chunk of response.body) {
      touch();
      chunks.push(chunk);
      received += chunk.length;
      if (Date.now() - lastReport >= PROGRESS_EVERY_MS) {
        lastReport = Date.now();
        console.log(`  … ${formatBytes(received)}${total > 0 ? ` / ${formatBytes(total)}` : ""}`);
      }
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

const platform = process.argv[2] ?? process.platform;
const arch = process.argv[3] ?? process.arch;
const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "build", "bin", `${platform}-${arch}`);

try {
  const result = await ensureOfficecli({
    targetKey: `${platform}-${arch}`,
    dir,
    version: OFFICECLI_VERSION,
    fetchBytes,
    log: (line) => console.log(line),
  });
  if (result.action === "cached") {
    console.log(`✓ officecli ${OFFICECLI_VERSION}（${platform}-${arch}）已就绪，跳过`);
  } else {
    console.log(`✓ officecli ${OFFICECLI_VERSION}（${statSync(result.path).size} B）→ ${result.path}`);
  }
} catch (cause) {
  console.error(`✖ ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(1);
}
