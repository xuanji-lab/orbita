import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileRoot } from "../../shared/files.ts";
import { DocWatchers, createDoc, hashText, listDocs, readDoc, resolveDocPath, writeDoc } from "./service.ts";

let dir: string;
let outside: string;
let roots: FileRoot[];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "doc-svc-"));
  outside = await mkdtemp(join(tmpdir(), "doc-out-"));
  roots = [{ kind: "workspace", label: "ws", path: dir, exists: true }];
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const target = (path: string) => ({ sessionId: null, workspaceId: null, path });

describe("白名单", () => {
  it("根外的 .md、软链接跳板、非 .md、不存在的文件都拒", async () => {
    await writeFile(join(outside, "secret.md"), "x");
    await assert.rejects(readDoc(roots, join(outside, "secret.md")), /不在这条会话允许/);
    await symlink(join(outside, "secret.md"), join(dir, "link.md"));
    await assert.rejects(readDoc(roots, join(dir, "link.md")), /不在这条会话允许/);
    await writeFile(join(dir, "a.txt"), "x");
    await assert.rejects(readDoc(roots, join(dir, "a.txt")), /只能打开 .md/);
    await assert.rejects(readDoc(roots, join(dir, "nope.md")), /DOC_GONE|不在这条会话允许/);
    await assert.rejects(resolveDocPath([{ kind: "attachments", label: "a", path: dir, exists: true }], join(dir, "link.md")));
  });
});

describe("读写：比较后交换", () => {
  it("读出内容与摘要；CRLF 读成 LF、摘要按 LF 算", async () => {
    const path = join(dir, "crlf.md");
    await writeFile(path, "一\r\n二\r\n");
    const file = await readDoc(roots, path);
    assert.equal(file.text, "一\n二\n");
    assert.equal(file.hash, hashText("一\n二\n"));
  });

  it("摘要对得上就写（原子写，盘上是新内容），回新摘要", async () => {
    const path = join(dir, "w.md");
    await writeFile(path, "旧");
    const file = await readDoc(roots, path);
    const result = await writeDoc(roots, { ...target(path), text: "新内容", expectedHash: file.hash });
    assert.equal(result.ok, true);
    assert.equal(await readFile(path, "utf8"), "新内容");
    if (result.ok) assert.equal(result.hash, hashText("新内容"));
    // 目录里不留临时文件
    assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
  });

  it("摘要对不上（agent 在这期间改过）：不写，盘上现状原样还回去 —— B2 的底线", async () => {
    const path = join(dir, "race.md");
    await writeFile(path, "第一段\n\n第二段\n");
    const mine = await readDoc(roots, path);
    // agent 在用户保存之前追加了一段
    await writeFile(path, "第一段\n\n第二段\n\n总结\n");
    const result = await writeDoc(roots, { ...target(path), text: "第一段改了\n\n第二段\n", expectedHash: mine.hash });
    assert.equal(result.ok, false);
    if (!result.ok && result.reason === "conflict") assert.equal(result.file.text, "第一段\n\n第二段\n\n总结\n");
    assert.equal(await readFile(path, "utf8"), "第一段\n\n第二段\n\n总结\n");
  });

  it("内容没变不落盘（不动 mtime）", async () => {
    const path = join(dir, "same.md");
    await writeFile(path, "同");
    const old = new Date(2020, 1, 1);
    await utimes(path, old, old);
    const file = await readDoc(roots, path);
    const result = await writeDoc(roots, { ...target(path), text: "同", expectedHash: file.hash });
    assert.equal(result.ok, true);
    assert.equal((await readDoc(roots, path)).modifiedAt, old.getTime());
  });

  it("并发两次写按序执行，后一次拿前一次的结果当「现状」", async () => {
    const path = join(dir, "seq.md");
    await writeFile(path, "0");
    const file = await readDoc(roots, path);
    const [a, b] = await Promise.all([
      writeDoc(roots, { ...target(path), text: "A", expectedHash: file.hash }),
      writeDoc(roots, { ...target(path), text: "B", expectedHash: file.hash }),
    ]);
    // 谁先排上队不定（两边都先要 await 白名单解析），但只能有一个写成，另一个看到的是对方写完的现状
    assert.deepEqual([a.ok, b.ok].sort(), [false, true]);
    assert.equal(await readFile(path, "utf8"), a.ok ? "A" : "B");
  });
});

describe("只读 / 权限位 / 换行风格（M4）", () => {
  it("只读文件不写穿：回 readonly，盘上内容与权限位原样", async () => {
    const path = join(dir, "ro.md");
    await writeFile(path, "原文");
    await chmod(path, 0o444);
    const file = await readDoc(roots, path);
    const result = await writeDoc(roots, { ...target(path), text: "改了", expectedHash: file.hash });
    assert.deepEqual(result, { ok: false, reason: "readonly" });
    assert.equal(await readFile(path, "utf8"), "原文");
    assert.equal((await stat(path)).mode & 0o777, 0o444);
  });

  it("可写文件覆盖后保留原权限位（600 不变 644）", async () => {
    const path = join(dir, "private.md");
    await writeFile(path, "私");
    await chmod(path, 0o600);
    const file = await readDoc(roots, path);
    const result = await writeDoc(roots, { ...target(path), text: "私密", expectedHash: file.hash });
    assert.equal(result.ok, true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  });

  it("CRLF 文件写回仍是 CRLF；LF 文件仍是 LF；摘要按规整后的文字算，不天天冲突", async () => {
    const crlf = join(dir, "win.md");
    await writeFile(crlf, "一\r\n二\r\n");
    const a = await readDoc(roots, crlf);
    const wrote = await writeDoc(roots, { ...target(crlf), text: "一\n二\n三\n", expectedHash: a.hash });
    assert.equal(wrote.ok, true);
    assert.equal(await readFile(crlf, "utf8"), "一\r\n二\r\n三\r\n");
    const again = await readDoc(roots, crlf);
    assert.equal(again.text, "一\n二\n三\n");
    if (wrote.ok) assert.equal(again.hash, wrote.hash);
    const lf = join(dir, "unix.md");
    await writeFile(lf, "甲\n");
    const b = await readDoc(roots, lf);
    await writeDoc(roots, { ...target(lf), text: "甲\n乙\n", expectedHash: b.hash });
    assert.equal(await readFile(lf, "utf8"), "甲\n乙\n");
  });
});

describe("文件被移走 / 删除（S1）", () => {
  it("读、写都抛 DOC_GONE 起头的人话；不在允许目录里则是另一句", async () => {
    const path = join(dir, "moved.md");
    await writeFile(path, "x");
    const file = await readDoc(roots, path);
    await rename(path, join(outside, "moved-away.md"));
    await assert.rejects(readDoc(roots, path), /^Error: DOC_GONE: 文件被移走或删除了/);
    await assert.rejects(writeDoc(roots, { ...target(path), text: "y", expectedHash: file.hash }), /DOC_GONE/);
    await assert.rejects(readDoc(roots, join(outside, "nope.md")), /不在这条会话允许的目录里/);
  });
});

describe("新建", () => {
  it("空白文档 / 演示文稿；重名加序号，不覆盖", async () => {
    const first = await createDoc(roots, { sessionId: null, workspaceId: null, kind: "doc" });
    assert.match(first.path, /未命名文档\.md$/);
    assert.equal(first.text, "");
    await writeFile(first.path, "用户已经写了字");
    const second = await createDoc(roots, { sessionId: null, workspaceId: null, kind: "doc" });
    assert.match(second.path, /未命名文档 2\.md$/);
    assert.equal(await readFile(first.path, "utf8"), "用户已经写了字");
    const deck = await createDoc(roots, { sessionId: null, workspaceId: null, kind: "slides" });
    // v2：演示文稿是 .slides.json（JSON 元素数组），带一页空白、标题取文件名
    assert.match(deck.path, /未命名演示文稿\.slides\.json$/);
    const parsed = JSON.parse(deck.text) as { title: string; slides: unknown[] };
    assert.equal(parsed.title, "未命名演示文稿");
    assert.equal(parsed.slides.length, 1);
    const second2 = await createDoc(roots, { sessionId: null, workspaceId: null, kind: "slides" });
    assert.match(second2.path, /未命名演示文稿 2\.slides\.json$/);
  });

  it("并发新建拿到不同的名字", async () => {
    const made = await Promise.all(
      [0, 1, 2, 3].map(() => createDoc(roots, { sessionId: null, workspaceId: null, kind: "doc" })),
    );
    assert.equal(new Set(made.map((m) => m.path)).size, 4);
  });

  it("工作区目录不存在：报错而不是建到别处", async () => {
    await assert.rejects(
      createDoc([{ kind: "workspace", label: "x", path: join(dir, "gone"), exists: false }], {
        sessionId: null,
        workspaceId: null,
        kind: "doc",
      }),
      /无处新建/,
    );
  });
});

describe("列表", () => {
  it("找出 .md、认出演示文稿、跳过依赖目录与点目录、最近改的在前", async () => {
    const lroot = await mkdtemp(join(tmpdir(), "doc-list-"));
    try {
      await mkdir(join(lroot, "sub"), { recursive: true });
      await mkdir(join(lroot, "node_modules", "x"), { recursive: true });
      await mkdir(join(lroot, ".hidden"), { recursive: true });
      await writeFile(join(lroot, "old.md"), "# 旧");
      await writeFile(join(lroot, "deck.md"), "---\nmarp: true\n---\n# a");
      await writeFile(join(lroot, "sub", "deep.md"), "# 深");
      await writeFile(join(lroot, "node_modules", "x", "readme.md"), "# 依赖");
      await writeFile(join(lroot, ".hidden", "h.md"), "# 隐");
      await writeFile(join(lroot, "note.txt"), "不是");
      await writeFile(join(lroot, "v2.slides.json"), "{}");
      await utimes(join(lroot, "old.md"), new Date(2020, 1, 1), new Date(2020, 1, 1));
      const entries = await listDocs([{ kind: "workspace", label: "l", path: lroot, exists: true }]);
      assert.deepEqual(entries.map((e) => e.relative).sort(), ["deck.md", join("sub", "deep.md"), "old.md", "v2.slides.json"].sort());
      assert.equal(entries[entries.length - 1]?.name, "old.md");
      assert.equal(entries.find((e) => e.name === "deck.md")?.kind, "slides");
      assert.equal(entries.find((e) => e.name === "old.md")?.kind, "doc");
      assert.equal(entries.find((e) => e.name === "v2.slides.json")?.kind, "slides");
    } finally {
      await rm(lroot, { recursive: true, force: true });
    }
  });
});

describe("监听", () => {
  it("原子写（rename 换 inode）之后还收得到下一次变化——监听的是目录不是文件", async () => {
    const path = join(dir, "watch.md");
    await writeFile(path, "0");
    const watchers = new DocWatchers();
    let count = 0;
    await watchers.watch("w:1", path, () => {
      count += 1;
    });
    try {
      const file = await readDoc(roots, path);
      const first = await writeDoc(roots, { ...target(path), text: "1", expectedHash: file.hash });
      assert.equal(first.ok, true);
      await waitFor(() => count >= 1);
      const before = count;
      if (first.ok) await writeDoc(roots, { ...target(path), text: "2", expectedHash: first.hash });
      await waitFor(() => count > before);
      // 别的文件变了不报
      const other = count;
      await writeFile(join(dir, "other.md"), "x");
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.equal(count, other);
    } finally {
      watchers.unwatch("w:1");
    }
    assert.equal(watchers.size, 0);
  });
});

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("等不到");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
