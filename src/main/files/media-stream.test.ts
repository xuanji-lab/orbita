/** 音视频协议的账：token 签发（白名单 / 符号链接逃逸 / 非媒体扩展名被拒）、token 表（复用 / LRU）、Range 解析、应答规划。 */
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileListRequest, FileRoot } from "../../shared/files.ts";
import { MEDIA_TOKEN_LIMIT, MediaTokens, issueMediaUrl, mediaUrlOf, parseRange, planMediaResponse, tokenOfUrl } from "./media-stream.ts";

let base = "";
let root = "";
let outside = "";

const rootOf = (path: string): FileRoot => ({ kind: "workspace", label: "w", path, exists: true });
const req = (dir: string, rootPath: string = root): FileListRequest => ({
  sessionId: "s",
  workspaceId: null,
  root: rootPath,
  dir,
});

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "orbita-media-")));
  root = join(base, "root");
  outside = join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("issueMediaUrl：签发前的白名单", () => {
  test("根内的 mp3 签发成功，回 kind / mime / size，地址不含路径", async () => {
    const file = join(root, "a.mp3");
    await writeFile(file, Buffer.alloc(100));
    const tokens = new MediaTokens();
    const out = await issueMediaUrl(tokens, [rootOf(root)], req(file));
    assert.equal(out.kind, "audio");
    assert.equal(out.mime, "audio/mpeg");
    assert.equal(out.size, 100);
    assert.ok(out.url.startsWith("orbita-media://stream/"));
    assert.equal(out.url.includes("a.mp3"), false);
    assert.equal(out.url.includes(root), false);
    const token = tokenOfUrl(out.url);
    assert.ok(token !== null);
    assert.equal(tokens.resolve(token), file);
  });

  test("视频扩展名回 video", async () => {
    const file = join(root, "v.MP4");
    await writeFile(file, Buffer.alloc(10));
    const out = await issueMediaUrl(new MediaTokens(), [rootOf(root)], req(file));
    assert.equal(out.kind, "video");
    assert.equal(out.mime, "video/mp4");
  });

  test("不是这条会话的根：拒绝", async () => {
    const file = join(outside, "a.mp3");
    await writeFile(file, Buffer.alloc(10));
    const tokens = new MediaTokens();
    await assert.rejects(issueMediaUrl(tokens, [rootOf(root)], req(file, outside)), /不是这条会话允许的根/);
    assert.equal(tokens.size, 0);
  });

  test("路径在根之外（.. 越出）：拒绝", async () => {
    const file = join(outside, "a.mp3");
    await writeFile(file, Buffer.alloc(10));
    const tokens = new MediaTokens();
    await assert.rejects(issueMediaUrl(tokens, [rootOf(root)], req(join(root, "..", "outside", "a.mp3"))), /不在允许的根之内/);
    assert.equal(tokens.size, 0);
  });

  test("符号链接指向根外的媒体文件：拒绝（realpath 后才判）", async () => {
    const target = join(outside, "secret.mp3");
    await writeFile(target, Buffer.alloc(10));
    const link = join(root, "link.mp3");
    await symlink(target, link);
    const tokens = new MediaTokens();
    await assert.rejects(issueMediaUrl(tokens, [rootOf(root)], req(link)), /不在允许的根之内/);
    assert.equal(tokens.size, 0);
  });

  test("根内的 foo.mp3 符号链接指向根内的非媒体文件：拒绝（扩展名按 realpath 判）", async () => {
    const target = join(root, "notes.txt");
    await writeFile(target, "secret");
    const link = join(root, "foo.mp3");
    await symlink(target, link);
    await assert.rejects(issueMediaUrl(new MediaTokens(), [rootOf(root)], req(link)), /Not a playable media file/);
  });

  test("非媒体扩展名 / 目录：拒绝", async () => {
    const txt = join(root, "a.txt");
    await writeFile(txt, "x");
    await assert.rejects(issueMediaUrl(new MediaTokens(), [rootOf(root)], req(txt)), /Not a playable media file/);
    const dirLike = join(root, "album.mp3");
    await mkdir(dirLike);
    await assert.rejects(issueMediaUrl(new MediaTokens(), [rootOf(root)], req(dirLike)), /Not a file/);
  });
});

describe("MediaTokens", () => {
  test("同一路径复用 token；不同路径不同 token", () => {
    const tokens = new MediaTokens();
    const a = tokens.issue("/x/a.mp3");
    assert.equal(tokens.issue("/x/a.mp3"), a);
    assert.notEqual(tokens.issue("/x/b.mp3"), a);
    assert.equal(tokens.size, 2);
  });

  test("超过上限淘汰最久没用的；用过的被顶到最新", () => {
    const tokens = new MediaTokens(3);
    const t1 = tokens.issue("/1.mp3");
    const t2 = tokens.issue("/2.mp3");
    const t3 = tokens.issue("/3.mp3");
    assert.equal(tokens.resolve(t1), "/1.mp3"); // 顶到最新，现在最旧的是 t2
    const t4 = tokens.issue("/4.mp3");
    assert.equal(tokens.size, 3);
    assert.equal(tokens.resolve(t2), null);
    assert.equal(tokens.resolve(t1), "/1.mp3");
    assert.equal(tokens.resolve(t3), "/3.mp3");
    assert.equal(tokens.resolve(t4), "/4.mp3");
    // 被淘汰的路径再签发是新 token
    assert.notEqual(tokens.issue("/2.mp3"), t2);
  });

  test("默认上限有界", () => {
    const tokens = new MediaTokens();
    for (let i = 0; i < MEDIA_TOKEN_LIMIT + 50; i++) tokens.issue(`/m/${i}.mp3`);
    assert.equal(tokens.size, MEDIA_TOKEN_LIMIT);
  });

  test("tokenOfUrl：只认固定协议 / 主机 / 单段 token；URL 里塞路径取不到", () => {
    const token = "A".repeat(32);
    assert.equal(tokenOfUrl(mediaUrlOf(token)), token);
    assert.equal(tokenOfUrl(`${mediaUrlOf(token)}?x=1#t=3`), token);
    assert.equal(tokenOfUrl(`orbita-media://stream/${token}/extra`), null);
    assert.equal(tokenOfUrl(`orbita-media://other/${token}`), null);
    assert.equal(tokenOfUrl(`https://stream/${token}`), null);
    assert.equal(tokenOfUrl("orbita-media://stream/%2Fetc%2Fpasswd"), null);
    assert.equal(tokenOfUrl("orbita-media://stream/../../etc/passwd"), null);
    assert.equal(tokenOfUrl("orbita-media://stream/short"), null);
    assert.equal(tokenOfUrl("not a url"), null);
  });
});

describe("parseRange", () => {
  test("无 Range → full", () => assert.deepEqual(parseRange(null, 100), { kind: "full" }));
  test("a-b", () => assert.deepEqual(parseRange("bytes=0-9", 100), { kind: "range", start: 0, end: 9 }));
  test("开放区间 a-", () => assert.deepEqual(parseRange("bytes=90-", 100), { kind: "range", start: 90, end: 99 }));
  test("后缀 -n", () => {
    assert.deepEqual(parseRange("bytes=-10", 100), { kind: "range", start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-500", 100), { kind: "range", start: 0, end: 99 });
  });
  test("end 越界夹到末尾", () => assert.deepEqual(parseRange("bytes=50-9999", 100), { kind: "range", start: 50, end: 99 }));
  test("起点越界 / 后缀 0 / 空文件 → 416", () => {
    assert.deepEqual(parseRange("bytes=100-", 100), { kind: "unsatisfiable" });
    assert.deepEqual(parseRange("bytes=500-600", 100), { kind: "unsatisfiable" });
    assert.deepEqual(parseRange("bytes=-0", 100), { kind: "unsatisfiable" });
    assert.deepEqual(parseRange("bytes=0-", 0), { kind: "unsatisfiable" });
  });
  test("语法不对 / 非 bytes / 多段 / end<start → 忽略，回完整", () => {
    for (const header of ["bytes=abc", "items=0-9", "bytes=0-9,20-29", "bytes=9-0", "bytes=-", "", "bytes=1.5-3"]) {
      assert.deepEqual(parseRange(header, 100), { kind: "full" }, header);
    }
  });
});

describe("planMediaResponse", () => {
  const setup = async (size = 1000): Promise<{ tokens: MediaTokens; url: string; file: string }> => {
    const file = join(root, "clip.mp4");
    await writeFile(file, Buffer.alloc(size, 7));
    const tokens = new MediaTokens();
    const out = await issueMediaUrl(tokens, [rootOf(root)], req(file));
    return { tokens, url: out.url, file };
  };

  test("无 Range：200 + 全长 + Accept-Ranges", async () => {
    const { tokens, url, file } = await setup();
    const plan = await planMediaResponse(tokens, { url, method: "GET", range: null });
    assert.equal(plan.status, 200);
    assert.equal(plan.headers["Content-Type"], "video/mp4");
    assert.equal(plan.headers["Accept-Ranges"], "bytes");
    assert.equal(plan.headers["Content-Length"], "1000");
    assert.deepEqual(plan.body, { path: file, start: 0, end: 999 });
  });

  test("Range：206 + Content-Range + 区间长度", async () => {
    const { tokens, url } = await setup();
    const plan = await planMediaResponse(tokens, { url, method: "GET", range: "bytes=500-" });
    assert.equal(plan.status, 206);
    assert.equal(plan.headers["Content-Range"], "bytes 500-999/1000");
    assert.equal(plan.headers["Content-Length"], "500");
    assert.deepEqual(plan.body && [plan.body.start, plan.body.end], [500, 999]);
  });

  test("越界：416 + Content-Range: bytes */size，无正文", async () => {
    const { tokens, url } = await setup();
    const plan = await planMediaResponse(tokens, { url, method: "GET", range: "bytes=1000-" });
    assert.equal(plan.status, 416);
    assert.equal(plan.headers["Content-Range"], "bytes */1000");
    assert.equal(plan.body, null);
  });

  test("HEAD：头同 GET、无正文", async () => {
    const { tokens, url } = await setup();
    const plan = await planMediaResponse(tokens, { url, method: "HEAD", range: "bytes=0-9" });
    assert.equal(plan.status, 206);
    assert.equal(plan.body, null);
  });

  test("空文件：200 无正文", async () => {
    const { tokens, url } = await setup(0);
    const plan = await planMediaResponse(tokens, { url, method: "GET", range: null });
    assert.equal(plan.status, 200);
    assert.equal(plan.headers["Content-Length"], "0");
    assert.equal(plan.body, null);
  });

  test("POST 405；URL 不合法 400；不认识的 token 404", async () => {
    const { tokens, url } = await setup();
    assert.equal((await planMediaResponse(tokens, { url, method: "POST", range: null })).status, 405);
    assert.equal((await planMediaResponse(tokens, { url: "orbita-media://stream/../etc/passwd", method: "GET", range: null })).status, 400);
    assert.equal((await planMediaResponse(tokens, { url: mediaUrlOf("B".repeat(32)), method: "GET", range: null })).status, 404);
  });

  test("文件签发后被删：404", async () => {
    const { tokens, url, file } = await setup();
    await rm(file);
    assert.equal((await planMediaResponse(tokens, { url, method: "GET", range: null })).status, 404);
  });

  test("签发后路径被换成指向根外的符号链接：404（应答时复核 realpath）", async () => {
    const { tokens, url, file } = await setup();
    const target = join(outside, "secret.mp4");
    await writeFile(target, Buffer.alloc(10));
    await rename(file, `${file}.bak`);
    await symlink(target, file);
    assert.equal((await planMediaResponse(tokens, { url, method: "GET", range: null })).status, 404);
  });
});
