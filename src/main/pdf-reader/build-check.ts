/**
 * 阅读器产物在不在、对不对（scripts/fetch-pdf-reader.mjs 写的 manifest.json）。
 *
 * 核对三样：manifest 在、提交与 PDF_READER_COMMIT 一致、每个文件的 sha256 与 manifest 一致（多出来的
 * 文件也算不对——产物目录里不该有 manifest 之外的东西）。约 11 MB，第一次打开阅读器时核一遍（实测几十毫秒），
 * 结果在进程内缓存；不对就让界面给出错态，不把一份被改过的页面加载进来。
 *
 * 桥脚本（out/reader-host/）不在 manifest 里：它是我们自己的代码，随 electron-vite 构建，只核对它在不在。
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { PDF_READER_COMMIT } from "../../shared/pdf-reader.ts";

export type BuildCheck = { ok: true } | { ok: false; reason: "missing" | "mismatch" | "corrupt"; detail: string };

/** 阅读器产物与桥脚本的位置：开发时在仓库里，打包后在 resources 下（桥脚本在 asar 里的 out/ 下） */
export function readerDirs(input: { packaged: boolean; resourcesPath: string; appPath: string }): { buildDir: string; hostDir: string } {
  return {
    buildDir: input.packaged ? join(input.resourcesPath, "pdf-reader") : join(input.appPath, "build", "pdf-reader"),
    hostDir: join(input.appPath, "out", "reader-host"),
  };
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(path)));
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

export async function checkReaderBuild(buildDir: string, hostDir: string): Promise<BuildCheck> {
  let manifestText: string;
  try {
    manifestText = await readFile(join(buildDir, "manifest.json"), "utf8");
  } catch {
    return { ok: false, reason: "missing", detail: `没有找到阅读器文件（${buildDir}）。开发时先运行 node scripts/fetch-pdf-reader.mjs` };
  }
  try {
    await readFile(join(hostDir, "orbita-host.js"));
  } catch {
    return { ok: false, reason: "missing", detail: `没有找到阅读器的桥脚本（${hostDir}）。先运行 bun run build 或 bun run dev` };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    return { ok: false, reason: "corrupt", detail: "manifest.json 不是合法的 JSON" };
  }
  const record = typeof manifest === "object" && manifest !== null ? (manifest as Record<string, unknown>) : {};
  if (record["commit"] !== PDF_READER_COMMIT) {
    return { ok: false, reason: "mismatch", detail: `阅读器文件是 ${String(record["commit"]).slice(0, 7)} 构建的，这一版要 ${PDF_READER_COMMIT.slice(0, 7)}` };
  }
  const files = typeof record["files"] === "object" && record["files"] !== null ? (record["files"] as Record<string, unknown>) : {};
  const seen = new Set<string>();
  for (const path of await listFiles(buildDir)) {
    const rel = relative(buildDir, path).split(sep).join("/");
    if (rel === "manifest.json") continue;
    seen.add(rel);
    const expected = files[rel];
    if (typeof expected !== "string") return { ok: false, reason: "corrupt", detail: `多出了 manifest 里没有的文件：${rel}` };
    const actual = createHash("sha256").update(await readFile(path)).digest("hex");
    if (actual !== expected) return { ok: false, reason: "corrupt", detail: `文件被改过：${rel}` };
  }
  for (const rel of Object.keys(files)) {
    if (!seen.has(rel)) return { ok: false, reason: "corrupt", detail: `缺文件：${rel}` };
  }
  return { ok: true };
}
