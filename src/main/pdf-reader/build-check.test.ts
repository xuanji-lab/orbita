import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkReaderBuild, readerDirs, unavailableResult } from "./build-check.ts";
import { PDF_READER_COMMIT } from "../../shared/pdf-reader.ts";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

function fixture(commit = PDF_READER_COMMIT) {
  const root = mkdtempSync(join(tmpdir(), "orbita-reader-check-"));
  const buildDir = join(root, "pdf-reader");
  const hostDir = join(root, "host");
  mkdirSync(join(buildDir, "app"), { recursive: true });
  mkdirSync(hostDir);
  writeFileSync(join(hostDir, "orbita-host.js"), "x");
  writeFileSync(join(buildDir, "app", "reader.js"), "reader");
  writeFileSync(join(buildDir, "manifest.json"), JSON.stringify({ commit, files: { "app/reader.js": sha("reader") } }));
  return { root, buildDir, hostDir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("完好的产物通过", async () => {
  const f = fixture();
  try {
    assert.deepEqual(await checkReaderBuild(f.buildDir, f.hostDir), { ok: true });
  } finally {
    f.done();
  }
});

test("缺产物、缺桥脚本、提交不符、文件被改、多出文件都不通过", async () => {
  const missing = await checkReaderBuild("/nonexistent/pdf-reader", "/nonexistent/host");
  assert.equal(missing.ok === false && missing.reason, "missing");

  const f = fixture();
  try {
    const noHost = await checkReaderBuild(f.buildDir, join(f.root, "nope"));
    assert.equal(noHost.ok === false && noHost.reason, "missing");
    writeFileSync(join(f.buildDir, "app", "reader.js"), "tampered");
    const tampered = await checkReaderBuild(f.buildDir, f.hostDir);
    assert.equal(tampered.ok === false && tampered.reason, "corrupt");
    writeFileSync(join(f.buildDir, "app", "reader.js"), "reader");
    writeFileSync(join(f.buildDir, "app", "extra.js"), "x");
    const extra = await checkReaderBuild(f.buildDir, f.hostDir);
    assert.equal(extra.ok === false && extra.reason, "corrupt");
  } finally {
    f.done();
  }

  const old = fixture("0".repeat(40));
  try {
    const mismatch = await checkReaderBuild(old.buildDir, old.hostDir);
    assert.equal(mismatch.ok === false && mismatch.reason, "mismatch");
  } finally {
    old.done();
  }
});

test("开发时在仓库 build/ 下，打包后在 resources 下；桥脚本总在 out/reader-host", () => {
  assert.deepEqual(readerDirs({ packaged: false, resourcesPath: "/R", appPath: "/A" }), { buildDir: join("/A", "build", "pdf-reader"), hostDir: join("/A", "out", "reader-host") });
  assert.equal(readerDirs({ packaged: true, resourcesPath: "/R", appPath: "/A" }).buildDir, join("/R", "pdf-reader"));
});

test("出错态：打包版不带路径与命令（detail 为 null），开发版带排查细节、命令统一成 bun run reader:fetch", async () => {
  const missing = await checkReaderBuild("/nonexistent/pdf-reader", "/nonexistent/host");
  assert.equal(missing.ok, false);
  if (missing.ok) return;
  assert.deepEqual(unavailableResult(missing, true), { kind: "unavailable", reason: "missing", detail: null });
  const dev = unavailableResult(missing, false);
  assert.match(dev.detail ?? "", /bun run reader:fetch/);
  assert.doesNotMatch(dev.detail ?? "", /node scripts\/fetch-pdf-reader/);
});
