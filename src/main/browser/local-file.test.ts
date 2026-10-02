import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { looksLikeLocalPath, resolveLocalPage } from "./local-file.ts";

// 假文件系统的 key 与 roots 一律用原生路径（resolve/join 拼），与产品代码同一套规则
// （约定见 data-dirs.test.ts:6-7）。两个原因：一是 file:// 输入走 fileURLToPath，Windows 上
// 产出的是带盘符的原生路径，POSIX 字面量 key 永远命中不了；二是写死 "file:///wb/..." 这种
// 无盘符地址在 Windows 上连 fileURLToPath 都会直接抛（ERR_INVALID_FILE_URL_PATH）。
// 安全边界（逃逸必须被拒）用真实判据保留：期望值只来自 fixture，不来自实现。
const wb = resolve("/wb"); // Windows：C:\wb；POSIX：/wb
const work = resolve("/work");
const etc = resolve("/etc");

/** 假文件系统：存在的路径 → 真实路径（软链接在这里映射到别处） */
const fs = new Map<string, string>([
  [wb, wb],
  [join(wb, "page.html"), join(wb, "page.html")],
  [join(wb, "sub", "chart.svg"), join(wb, "sub", "chart.svg")],
  [join(wb, "notes.txt"), join(wb, "notes.txt")],
  [join(wb, "escape.html"), join(etc, "evil.html")],
  [join(etc, "evil.html"), join(etc, "evil.html")],
  [work, work],
  [join(work, "index.htm"), join(work, "index.htm")],
]);
const realpath = async (path: string): Promise<string> => {
  const hit = fs.get(path);
  if (hit === undefined) throw new Error("ENOENT");
  return hit;
};
const roots = [wb, work, resolve("/not-created-yet")];

test("looksLikeLocalPath：绝对路径、Windows 盘符、file:// 算；网址与搜索词不算", () => {
  assert.equal(looksLikeLocalPath("/wb/page.html"), true);
  assert.equal(looksLikeLocalPath("C:\\Users\\me\\a.html"), true);
  assert.equal(looksLikeLocalPath("file:///wb/page.html"), true);
  assert.equal(looksLikeLocalPath("scopus.com"), false);
  assert.equal(looksLikeLocalPath("NUS library"), false);
});

test("本会话目录里的网页放行（含子目录、file:// 形式、另一个根）", async () => {
  assert.deepEqual(await resolveLocalPage(join(wb, "page.html"), roots, realpath), { ok: true, path: join(wb, "page.html") });
  assert.deepEqual(await resolveLocalPage(join(wb, "sub", "chart.svg"), roots, realpath), { ok: true, path: join(wb, "sub", "chart.svg") });
  // file:// 地址用 pathToFileURL 生成：写死的无盘符地址在 Windows 上非法
  assert.deepEqual(await resolveLocalPage(pathToFileURL(join(wb, "page.html")).href, roots, realpath), {
    ok: true,
    path: join(wb, "page.html"),
  });
  assert.deepEqual(await resolveLocalPage(join(work, "index.htm"), roots, realpath), { ok: true, path: join(work, "index.htm") });
});

test("拒绝：目录外、软链接跳出去、不是网页、不存在", async () => {
  const outside = await resolveLocalPage(join(etc, "evil.html"), roots, realpath);
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.error, /outside the directories/);
  // 软链接跳出白名单：escape.html 的 realpath 落在 etc 下，必须被拒（安全边界，独立判据）
  const escaped = await resolveLocalPage(join(wb, "escape.html"), roots, realpath);
  assert.equal(escaped.ok, false);
  if (!escaped.ok) assert.match(escaped.error, /outside the directories/);
  const text = await resolveLocalPage(join(wb, "notes.txt"), roots, realpath);
  assert.equal(text.ok, false);
  if (!text.ok) assert.match(text.error, /Only web pages/);
  const missing = await resolveLocalPage(join(wb, "nope.html"), roots, realpath);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /does not exist/);
});
