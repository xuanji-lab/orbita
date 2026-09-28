import { test } from "node:test";
import assert from "node:assert/strict";
import { looksLikeLocalPath, resolveLocalPage } from "./local-file.ts";

/** 假文件系统：存在的路径 → 真实路径（软链接在这里映射到别处） */
const fs = new Map<string, string>([
  ["/wb", "/wb"],
  ["/wb/page.html", "/wb/page.html"],
  ["/wb/sub/chart.svg", "/wb/sub/chart.svg"],
  ["/wb/notes.txt", "/wb/notes.txt"],
  ["/wb/escape.html", "/etc/evil.html"],
  ["/etc/evil.html", "/etc/evil.html"],
  ["/work", "/work"],
  ["/work/index.htm", "/work/index.htm"],
]);
const realpath = async (path: string): Promise<string> => {
  const hit = fs.get(path);
  if (hit === undefined) throw new Error("ENOENT");
  return hit;
};
const roots = ["/wb", "/work", "/not-created-yet"];

test("looksLikeLocalPath：绝对路径、Windows 盘符、file:// 算；网址与搜索词不算", () => {
  assert.equal(looksLikeLocalPath("/wb/page.html"), true);
  assert.equal(looksLikeLocalPath("C:\\Users\\me\\a.html"), true);
  assert.equal(looksLikeLocalPath("file:///wb/page.html"), true);
  assert.equal(looksLikeLocalPath("scopus.com"), false);
  assert.equal(looksLikeLocalPath("NUS library"), false);
});

test("本会话目录里的网页放行（含子目录、file:// 形式、另一个根）", async () => {
  assert.deepEqual(await resolveLocalPage("/wb/page.html", roots, realpath), { ok: true, path: "/wb/page.html" });
  assert.deepEqual(await resolveLocalPage("/wb/sub/chart.svg", roots, realpath), { ok: true, path: "/wb/sub/chart.svg" });
  assert.deepEqual(await resolveLocalPage("file:///wb/page.html", roots, realpath), { ok: true, path: "/wb/page.html" });
  assert.deepEqual(await resolveLocalPage("/work/index.htm", roots, realpath), { ok: true, path: "/work/index.htm" });
});

test("拒绝：目录外、软链接跳出去、不是网页、不存在", async () => {
  const outside = await resolveLocalPage("/etc/evil.html", roots, realpath);
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.match(outside.error, /outside the directories/);
  const escaped = await resolveLocalPage("/wb/escape.html", roots, realpath);
  assert.equal(escaped.ok, false);
  const text = await resolveLocalPage("/wb/notes.txt", roots, realpath);
  assert.equal(text.ok, false);
  if (!text.ok) assert.match(text.error, /Only web pages/);
  const missing = await resolveLocalPage("/wb/nope.html", roots, realpath);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.match(missing.error, /does not exist/);
});
