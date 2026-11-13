import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileRoot } from "../../shared/files.ts";
import { applySlidesRequest, defaultOutPath } from "./agent-requests.ts";

let dir: string;
let outside: string;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), "orbita-slides-req-"));
  outside = await mkdtemp(join(tmpdir(), "orbita-slides-out-"));
  await writeFile(join(dir, "d.slides.json"), "{}");
  await writeFile(join(outside, "x.slides.json"), "{}");
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const roots = (): FileRoot[] => [{ kind: "workspace", label: "w", path: dir, exists: true }];
const deps = (calls: string[] = []) => ({
  roots: roots(),
  exportDeck: async (path: string, format: string, page?: number) => {
    calls.push(`${path}|${format}|${page ?? ""}`);
    return { bytes: new Uint8Array([1, 2, 3]), pages: 2 };
  },
});

describe("applySlidesRequest", () => {
  it("默认写到演示文稿旁边，回路径 / 字节 / 页数", async () => {
    const calls: string[] = [];
    const out = await applySlidesRequest(deps(calls), { path: join(dir, "d.slides.json"), format: "pdf" });
    assert.equal(out.ok, true);
    if (out.ok) {
      assert.ok(out.path.endsWith("d.pdf"));
      assert.equal(out.bytes, 3);
      assert.equal(out.pages, 2);
      assert.deepEqual([...(await readFile(out.path))], [1, 2, 3]);
    }
    assert.equal(calls.length, 1);
  });

  it("演示文稿不在可写根内 → 拒绝，导出不被调用", async () => {
    const calls: string[] = [];
    const out = await applySlidesRequest(deps(calls), { path: join(outside, "x.slides.json"), format: "html" });
    assert.equal(out.ok, false);
    assert.equal(calls.length, 0);
  });

  it("out 逃出工作区 / 扩展名不对 → 拒绝", async () => {
    const escape = await applySlidesRequest(deps(), { path: join(dir, "d.slides.json"), format: "pdf", out: join(outside, "a.pdf") });
    assert.equal(escape.ok, false);
    const traversal = await applySlidesRequest(deps(), { path: join(dir, "d.slides.json"), format: "pdf", out: "../../x.pdf" });
    assert.equal(traversal.ok, false);
    const wrongExt = await applySlidesRequest(deps(), { path: join(dir, "d.slides.json"), format: "pdf", out: "a.txt" });
    assert.equal(wrongExt.ok, false);
  });

  it("out 可指到工作区内尚不存在的子目录", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    const out = await applySlidesRequest(deps(), { path: join(dir, "d.slides.json"), format: "pptx", out: "sub/new/d.pptx" });
    assert.equal(out.ok, true);
  });

  it("导出失败回 ok:false 带原因", async () => {
    const out = await applySlidesRequest(
      { roots: roots(), exportDeck: async () => { throw new Error("没有第 9 页"); } },
      { path: join(dir, "d.slides.json"), format: "png", page: 9 },
    );
    assert.deepEqual(out, { ok: false, error: "没有第 9 页" });
  });

  it("默认文件名：png 带页号，通用字体 pptx 带 -basic", () => {
    assert.ok(defaultOutPath("/a/花园.slides.json", "png", 3).endsWith("花园-p3.png"));
    assert.ok(defaultOutPath("/a/花园.slides.json", "pptx-basic", undefined).endsWith("花园-basic.pptx"));
  });
});
