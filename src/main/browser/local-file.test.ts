import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { localRequestAllowed, looksLikeLocalPath, resolveLocalPage } from "./local-file.ts";

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
  // 改名成 .html 的软链接，指向根内的非网页文件
  [join(wb, "notes.html"), join(wb, "notes.txt")],
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

test("looksLikeLocalPath：绝对路径、Windows 盘符、UNC、file:// 算；网址与搜索词不算", () => {
  assert.equal(looksLikeLocalPath("/wb/page.html"), true);
  assert.equal(looksLikeLocalPath("C:\\Users\\me\\a.html"), true);
  assert.equal(looksLikeLocalPath("file:///wb/page.html"), true);
  // Windows 的 UNC 与设备路径也算本地路径：不认的话会被当成网址 / 搜索词送出去
  assert.equal(looksLikeLocalPath("\\\\server\\share\\a.html"), true);
  assert.equal(looksLikeLocalPath("\\\\?\\C:\\a.html"), true);
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

test("类型判定用 realpath 之后的路径：改名成 .html 的软链接指向 .txt 也拒（与 fs:open-in-browser 同口径）", async () => {
  const disguised = await resolveLocalPage(join(wb, "notes.html"), roots, realpath);
  assert.equal(disguised.ok, false);
  if (!disguised.ok) assert.match(disguised.error, /Only web pages/);
});

test("UNC 输入在碰盘之前就拒（原因码 outside）：realpath 它会让 Windows 先对那台主机发起 SMB 连接", async () => {
  const touched: string[] = [];
  const spy = async (path: string): Promise<string> => {
    touched.push(path);
    return path;
  };
  const cases = [
    "\\\\attacker.example\\share\\x.html", // 裸 UNC（Windows 绝对路径）
    "file://attacker.example/share/x.html", // 带主机名的 file://（Windows 上 fileURLToPath 转成上一行）
    "//attacker.example/share/x.html", // 正斜杠写法（Windows 与上一行等价）
    "\\\\?\\UNC\\attacker.example\\share\\x.html", // 设备命名空间的同一网络路径
  ];
  for (const input of cases) {
    touched.length = 0;
    const result = await resolveLocalPage(input, roots, spy);
    assert.equal(result.ok, false, input);
    if (!result.ok) {
      assert.equal(result.reason, "outside", input);
      assert.match(result.error, /outside the directories/, input);
    }
    assert.deepEqual(touched, [], `${input}：拒绝必须发生在任何 fs 调用之前`);
  }
});

test("放行根本身在那台主机的共享上（工作区在 NAS）：照常往下判，而不是一刀切", async () => {
  const uncRoot = "\\\\nas\\proj";
  const nasFs = new Map(fs);
  nasFs.set(uncRoot, uncRoot);
  nasFs.set(`${uncRoot}\\page.html`, `${uncRoot}\\page.html`);
  const nasRealpath = async (path: string): Promise<string> => {
    const hit = nasFs.get(path);
    if (hit === undefined) throw new Error("ENOENT");
    return hit;
  };
  // 裸 UNC 与 file://host 两种写法都指向同一台主机的放行根
  const bare = await resolveLocalPage(`${uncRoot}\\page.html`, [uncRoot], nasRealpath);
  const viaUrl = await resolveLocalPage("file://NAS/proj/page.html", [uncRoot], nasRealpath);
  if (process.platform === "win32") {
    assert.deepEqual(bare, { ok: true, path: `${uncRoot}\\page.html` });
    assert.deepEqual(viaUrl, { ok: true, path: `${uncRoot}\\page.html` });
  } else {
    // POSIX：裸 UNC 非绝对路径、file://host 被 fileURLToPath 拒——都回 invalid，与页面闸同口径
    assert.equal(bare.ok, false);
    assert.equal(viaUrl.ok, false);
  }
});

test("file://localhost 不算 UNC 主机：照常按本地路径判", async () => {
  // pathToFileURL 不产主机名，这里手工拼一个 localhost 主机（POSIX 与 Windows 的 fileURLToPath 都认）
  const local = pathToFileURL(join(wb, "page.html")).href.replace(/^file:\/\//, "");
  assert.deepEqual(await resolveLocalPage(`file://localhost${local}`, roots, realpath), {
    ok: true,
    path: join(wb, "page.html"),
  });
});

/**
 * 页面打开之后的 file:// 闸（#365）：入口闸只管第一个地址，页面自己还能 fetch / iframe /
 * 跳转到任意 file://。真文件系统 + #365 的夹具：根内 linkout/ 是指向根外的 junction。
 * Chromium 里真的拦不拦得住，归 local-file-guard.test.ts（起一个隐藏的 Electron）。
 */
describe("localRequestAllowed（页面打开之后的 file:// 闸）", () => {
  let base = "";
  let root = "";
  let outside = "";

  before(async () => {
    base = await mkdtemp(join(tmpdir(), "orbita-local-guard-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(join(root, "assets"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(root, "page.html"), "<p>page</p>", "utf8");
    await writeFile(join(root, "assets", "app.css"), "p{}", "utf8");
    await writeFile(join(outside, "secret.txt"), "OUTSIDE-SECRET", "utf8");
    await symlink(outside, join(root, "linkout"), "junction");
  });

  after(async () => {
    await rm(base, { recursive: true, force: true });
  });

  const url = (path: string): string => pathToFileURL(path).href;

  test("根内的页面与子资源放行（子目录、带 query / hash、目录本身）", async () => {
    assert.equal(await localRequestAllowed(url(join(root, "page.html")), [root]), true);
    assert.equal(await localRequestAllowed(url(join(root, "assets", "app.css")), [root]), true);
    assert.equal(await localRequestAllowed(`${url(join(root, "page.html"))}?v=1#top`, [root]), true);
    assert.equal(await localRequestAllowed(url(join(root, "assets")), [root]), true);
  });

  test("穿过 junction 到根外、根外绝对路径、上跳 ..：一律不放（#365）", async () => {
    assert.equal(await localRequestAllowed(url(join(root, "linkout", "secret.txt")), [root]), false);
    assert.equal(await localRequestAllowed(url(join(outside, "secret.txt")), [root]), false);
    assert.equal(await localRequestAllowed(`${url(root)}/../outside/secret.txt`, [root]), false);
    // 根外的目录本身（Chromium 会给目录列表）
    assert.equal(await localRequestAllowed(url(outside), [root]), false);
  });

  test("没有放行根 / 不是 file:// / 不存在 / 坏地址：不放", async () => {
    assert.equal(await localRequestAllowed(url(join(root, "page.html")), []), false);
    assert.equal(await localRequestAllowed("https://example.com/page.html", [root]), false);
    assert.equal(await localRequestAllowed(url(join(root, "nope.html")), [root]), false);
    assert.equal(await localRequestAllowed("file://", [root]), false);
    assert.equal(await localRequestAllowed("not a url", [root]), false);
  });

  test("放行根不存在（工作台还没建）就跳过它，不连累别的根", async () => {
    assert.equal(await localRequestAllowed(url(join(root, "page.html")), [join(base, "not-yet"), root]), true);
  });

  test("带主机名的 file://（UNC）：不在任何放行根的主机上 → 不碰盘直接拒（不给 SMB 外连的机会）", async () => {
    const touched: string[] = [];
    const spy = async (path: string): Promise<string> => {
      touched.push(path);
      return path;
    };
    assert.equal(await localRequestAllowed("file://attacker.example/share/x.png", [root], spy), false);
    assert.deepEqual(touched, []);
    // 放行根本身就在这台主机的共享上（工作区在 NAS）：照常往下判，而不是一刀切。
    // 只有 Windows 的 fileURLToPath 认主机名（POSIX 上它当场抛，等于拒）
    const uncRoot = "\\\\nas\\proj";
    const allowed = await localRequestAllowed("file://NAS/proj/page.html", [uncRoot], spy);
    if (process.platform === "win32") {
      assert.equal(allowed, true);
      assert.ok(touched.length > 0, "放行根在同一台主机上时应继续判定");
    } else {
      assert.equal(allowed, false);
    }
  });
});
