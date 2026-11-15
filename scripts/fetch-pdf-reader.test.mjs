import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildManifest, findSdtMarkers, READER, submoduleMismatches } from "./fetch-pdf-reader.mjs";

const sandbox = () => mkdtempSync(join(tmpdir(), "orbita-reader-build-"));

test("产物里有 SDT 源码的报错文案就被闸住；只在 js / mjs 里找", () => {
  const dir = sandbox();
  try {
    mkdirSync(join(dir, "pdf", "build"), { recursive: true });
    writeFileSync(join(dir, "reader.js"), "function a(){throw new Error('Invalid SDTPack index length')}");
    writeFileSync(join(dir, "pdf", "build", "pdf.mjs"), "console.log('ok')");
    writeFileSync(join(dir, "notes.txt"), "Invalid SDTPack");
    assert.deepEqual(findSdtMarkers(dir), ["reader.js: Invalid SDTPack"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("干净的产物过闸", () => {
  const dir = sandbox();
  try {
    writeFileSync(join(dir, "reader.js"), "window.createReader = () => {}");
    assert.deepEqual(findSdtMarkers(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("子模块：提交对得上才过；没拉（行首 -）算缺；多出来的不管", () => {
  const ok = [
    " 5f95f712bc629ac11159cb4859ed8091fdffa87b pdfjs/pdf.js (heads/master)",
    " e68c8b9c868be6ccb5b9684213117e95e52ef880 epubjs/epub.js (v0.3.93-38-ge68c8b9)",
    "-7963c11faac4595be3bbe86b7574704a22c67bed structured-document-text",
  ].join("\n");
  assert.deepEqual(submoduleMismatches(ok, READER.submodules), []);
  const moved = ok.replace(" 5f95f712", "+1111111").replace("bc629ac11159cb4859ed8091fdffa87b", "1111111111111111111111111111111a");
  assert.equal(submoduleMismatches(moved, READER.submodules).length, 1);
  const missing = ok.replace(" e68c8b9c", "-e68c8b9c");
  assert.match(submoduleMismatches(missing, READER.submodules)[0] ?? "", /epubjs\/epub\.js.*未拉取/);
});

test("manifest 记每个文件的 sha256（正斜杠相对路径），不记它自己", () => {
  const dir = sandbox();
  try {
    mkdirSync(join(dir, "app", "pdf"), { recursive: true });
    writeFileSync(join(dir, "app", "pdf", "a.js"), "a");
    writeFileSync(join(dir, "manifest.json"), "{}");
    const manifest = buildManifest(dir);
    assert.equal(manifest.commit, READER.commit);
    assert.deepEqual(Object.keys(manifest.files), ["app/pdf/a.js"]);
    assert.equal(manifest.files["app/pdf/a.js"], "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("脚本钉的提交与主进程核对用的同值", () => {
  const shared = readFileSync(new URL("../src/shared/pdf-reader.ts", import.meta.url), "utf8");
  assert.match(shared, new RegExp(`PDF_READER_COMMIT = "${READER.commit}"`));
});

test("桩导出了 reader 会 import 的每个 SDT 名字（构建开着 exportsPresence: error，这里先挡一道）", async () => {
  const stub = await import("./pdf-reader/sdt-stub.mjs");
  for (const name of [
    "getPageBlockSpan",
    "compareRefs",
    "refKey",
    "walkContentRangeLeafBlocks",
    "openStructuredDocumentTextPack",
    "SDT_PACK_VERSION",
    "SDT_SCHEMA_VERSION",
    "nfcToOriginalLocal",
  ]) {
    assert.ok(name in stub, name);
  }
  // 安全失败：不抛错，回空值
  assert.equal(stub.getPageBlockSpan({}, 0), null);
  assert.equal(await stub.openStructuredDocumentTextPack(), null);
});
