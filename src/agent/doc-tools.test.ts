import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { readCommandCard, readOpenPanel } from "../shared/builtin-command.ts";
import { createDocTools, outlineOf } from "./doc-tools.ts";
import { RequestBroker } from "./request-broker.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir = "";
let outside = "";
let mode = "skip";
const sent: Record<string, unknown>[] = [];
let reply: (event: Record<string, unknown>) => unknown = () => ({ ok: false, error: "no reply" });

let tools: Record<string, ToolDefinition> = {};

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "doc-tools-")));
  outside = await realpath(await mkdtemp(join(tmpdir(), "doc-tools-out-")));
  await mkdir(join(dir, "周报"), { recursive: true });
  await writeFile(join(dir, "周报", "w.md"), "---\ntags: [a]\n---\n# 周报\n\n正文\n\n## 小节\n\n```\n# 不是标题\n```\n");
  await writeFile(join(dir, "pic.png"), PNG);
  await writeFile(join(outside, "secret.md"), "x");
  const broker: RequestBroker = new RequestBroker((event) => {
    const e = event as Record<string, unknown>;
    sent.push(e);
    queueMicrotask(() => broker.resolve(e["requestId"] as string, reply(e)));
  });
  const list = createDocTools(broker, "s1", { cwd: dir, writeRoots: [dir], workspaceId: "w1", mode: () => mode });
  tools = Object.fromEntries(list.map((tool) => [tool.name, tool]));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const run = async (name: string, params: Record<string, unknown>) => {
  const tool = tools[name] as ToolDefinition;
  return (await tool.execute("c1", params as never, undefined as never, undefined as never, undefined as never)) as {
    content: { type: string; text: string }[];
    details?: Record<string, unknown>;
  };
};
const textOf = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("");

describe("doc_open", () => {
  it("返回大纲（跳过 frontmatter 与围栏里的 #），details 带 openPanel(files) 与卡", async () => {
    const result = await run("doc_open", { path: "周报/w.md" });
    const text = textOf(result);
    assert.match(text, /L4 # 周报/);
    assert.match(text, / {2}L8 ## 小节/);
    assert.equal(text.includes("不是标题"), false);
    const open = readOpenPanel(result.details);
    assert.deepEqual(open, { kind: "files", path: join(dir, "周报", "w.md") });
    const card = readCommandCard(result.details);
    assert.equal(card?.kind, "doc");
    assert.equal(card?.title, "w");
    assert.match(card?.subtitle ?? "", /周报\/w\.md · 12 行/);
  });

  it("create:true 新建空文档（force 打开）；已存在不覆盖；plan 档拒绝新建", async () => {
    const created = await run("doc_open", { path: "新笔记.md", create: true });
    assert.match(textOf(created), /Created and opened/);
    assert.equal(readOpenPanel(created.details)?.force, true);
    assert.equal(await readFile(join(dir, "新笔记.md"), "utf8"), "");
    await writeFile(join(dir, "新笔记.md"), "# 已有内容\n");
    const again = await run("doc_open", { path: "新笔记.md", create: true });
    assert.match(textOf(again), /^Opened/);
    assert.equal(await readFile(join(dir, "新笔记.md"), "utf8"), "# 已有内容\n");
    mode = "plan";
    await assert.rejects(run("doc_open", { path: "plan.md", create: true }), /Plan mode/);
    mode = "skip";
  });

  it("拒绝：根外、非文档扩展名、不存在（没给 create）、越界相对路径", async () => {
    await assert.rejects(run("doc_open", { path: join(outside, "secret.md") }), /inside the workspace/);
    await assert.rejects(run("doc_open", { path: "../x.md" }), /inside the workspace/);
    await assert.rejects(run("doc_open", { path: "a.png" }), /must end with/);
    await assert.rejects(run("doc_open", { path: "没有.md" }), /not found/i);
    await assert.rejects(run("doc_open", {}), /required/);
  });

  it("工作区在 symlink 下：openPanel 与卡带的是面板认得的路径（用户挂的根下的原样路径），不是解析后的真实路径", async () => {
    // 实测：~/x/Home → Home-real，agent 返回真实路径，文件面板找不到所在的根，报「超出能看到的目录」、不开文档
    const base = await realpath(await mkdtemp(join(tmpdir(), "doc-tools-link-")));
    try {
      await mkdir(join(base, "real", "周报"), { recursive: true });
      await writeFile(join(base, "real", "周报", "w.md"), "# 周报\n");
      await symlink(join(base, "real"), join(base, "Home"));
      const broker = new RequestBroker(() => undefined);
      const list = createDocTools(broker, "s2", { cwd: join(base, "Home"), writeRoots: [join(base, "Home")], workspaceId: "w2", mode: () => "skip" });
      const open = list.find((tool) => tool.name === "doc_open") as ToolDefinition;
      const result = (await open.execute("c2", { path: "周报/w.md" } as never, undefined as never, undefined as never, undefined as never)) as { details?: Record<string, unknown> };
      assert.equal(readOpenPanel(result.details)?.path, join(base, "Home", "周报", "w.md"));
      assert.equal(readCommandCard(result.details)?.path, join(base, "Home", "周报", "w.md"));
      // 卡片副标题的相对路径也以用户看到的工作区为准（曾显示成 ../real/周报/w.md）
      assert.match(readCommandCard(result.details)?.subtitle ?? "", /^文档 · 周报\/w\.md/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  it("大纲函数的边界", () => {
    assert.deepEqual(outlineOf(""), []);
    assert.deepEqual(outlineOf("# a\n```\n# b\n```\n## c"), [
      { line: 1, level: 1, title: "a" },
      { line: 5, level: 2, title: "c" },
    ]);
  });
});

describe("doc_insert_image", () => {
  it("复制进 attachments/，图片自成一段，frontmatter 之后；之后的文字不被吞", async () => {
    await writeFile(join(dir, "周报", "i.md"), "---\ntitle: x\n---\n# 标题\n\n正文一\n正文二\n");
    const result = await run("doc_insert_image", { path: "周报/i.md", image_path: "pic.png", after_line: 6 });
    assert.match(textOf(result), /Inserted !\[\]\(\.\.\/attachments\/pic\.png\)/);
    assert.equal(readOpenPanel(result.details)?.kind, "files");
    const next = await readFile(join(dir, "周报", "i.md"), "utf8");
    assert.equal(next, "---\ntitle: x\n---\n# 标题\n\n正文一\n\n![](../attachments/pic.png)\n\n正文二\n");
    assert.deepEqual(await readFile(join(dir, "attachments", "pic.png")), PNG);
  });

  it("after_line 落在 frontmatter 里 / 越界 / 非图片 / 找不到图：报错且不改文档", async () => {
    const before = await readFile(join(dir, "周报", "w.md"), "utf8");
    await assert.rejects(run("doc_insert_image", { path: "周报/w.md", image_path: "pic.png", after_line: 2 }), /inside the frontmatter/);
    await assert.rejects(run("doc_insert_image", { path: "周报/w.md", image_path: "pic.png", after_line: 999 }), /between 0 and/);
    await assert.rejects(run("doc_insert_image", { path: "周报/w.md", image_path: "w.md" }), /Not an image/);
    await assert.rejects(run("doc_insert_image", { path: "周报/w.md", image_path: "nope.png" }), /not found/i);
    assert.equal(await readFile(join(dir, "周报", "w.md"), "utf8"), before);
  });

  it("图片来源闸：../ 越界、工作区外绝对路径、symlink 指到外面都拒，且不拷进 attachments", async () => {
    await writeFile(join(outside, "secret.png"), PNG);
    await writeFile(join(dir, "周报", "g.md"), "# g\n");
    const before = await readFile(join(dir, "周报", "g.md"), "utf8");
    // 相对路径按工作区根解析，outside 是 dir 在 tmpdir 下的兄弟
    const rel = `../${basename(outside)}/secret.png`;
    await assert.rejects(run("doc_insert_image", { path: "周报/g.md", image_path: rel }), /outside the workspace/);
    await assert.rejects(run("doc_insert_image", { path: "周报/g.md", image_path: join(outside, "secret.png") }), /outside the workspace/);
    await symlink(join(outside, "secret.png"), join(dir, "sneaky.png"));
    await assert.rejects(run("doc_insert_image", { path: "周报/g.md", image_path: "sneaky.png" }), /outside the workspace/);
    assert.equal(await readFile(join(dir, "周报", "g.md"), "utf8"), before);
    await assert.rejects(readFile(join(dir, "attachments", "secret.png")));
  });

  it("图片来源闸：附加目录与额外读根（工作台 / 附件副本）里的图照常放行", async () => {
    const attachedDir = await realpath(await mkdtemp(join(tmpdir(), "doc-tools-att-")));
    const extra = await realpath(await mkdtemp(join(tmpdir(), "doc-tools-extra-")));
    try {
      await writeFile(join(attachedDir, "a.png"), PNG);
      await writeFile(join(extra, "wb.png"), PNG);
      await writeFile(join(dir, "周报", "h.md"), "# h\n");
      const broker = new RequestBroker(() => undefined);
      const wide = Object.fromEntries(
        createDocTools(broker, "s2", { cwd: dir, writeRoots: [dir, attachedDir], imageReadRoots: [extra], workspaceId: "w1", mode: () => "skip" }).map((tool) => [tool.name, tool]),
      );
      const call = (image: string) => (wide["doc_insert_image"] as ToolDefinition).execute("c", { path: "周报/h.md", image_path: image } as never, undefined as never, undefined as never, undefined as never);
      assert.match(JSON.stringify(await call(join(attachedDir, "a.png"))), /Inserted/);
      assert.match(JSON.stringify(await call(join(extra, "wb.png"))), /Inserted/);
      await assert.rejects(run("doc_insert_image", { path: "周报/h.md", image_path: join(extra, "wb.png") }), /outside the workspace/);
    } finally {
      await rm(attachedDir, { recursive: true, force: true });
      await rm(extra, { recursive: true, force: true });
    }
  });

  it("默认插在文末；Obsidian 库写 ![[名]]", async () => {
    await mkdir(join(dir, "库", ".obsidian"), { recursive: true });
    await writeFile(join(dir, "库", "n.md"), "# 库\n");
    const result = await run("doc_insert_image", { path: "库/n.md", image_path: "pic.png" });
    assert.match(textOf(result), /!\[\[pic\.png\]\]/);
    assert.equal(await readFile(join(dir, "库", "n.md"), "utf8"), "# 库\n\n![[pic.png]]\n");
  });
});

describe("doc_export", () => {
  it("经 broker 发 docRequest（带路径与格式），成功回导出卡；失败原样报错", async () => {
    sent.length = 0;
    reply = () => ({ ok: true, path: join(dir, "周报", "w.docx"), bytes: 4096 });
    const result = await run("doc_export", { path: "周报/w.md", format: "docx" });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.["type"], "docRequest");
    assert.equal(sent[0]?.["workspaceId"], "w1");
    assert.deepEqual(sent[0]?.["request"], { path: join(dir, "周报", "w.md"), format: "docx" });
    assert.match(textOf(result), /Exported .* \(4\.0 KB, \.docx\)/);
    const card = readCommandCard(result.details);
    assert.equal(card?.kind, "export");
    assert.equal(card?.subtitle, "Word · 4.0 KB");
    reply = () => ({ ok: false, error: "输出路径不在工作区内" });
    await assert.rejects(run("doc_export", { path: "周报/w.md", format: "pdf", out: "/tmp/x.pdf" }), /输出路径不在工作区内/);
    assert.deepEqual((sent[1]?.["request"] as Record<string, unknown>)["out"], "/tmp/x.pdf");
    await assert.rejects(run("doc_export", { path: "周报/w.md", format: "rtf" }), /format/);
    await assert.rejects(run("doc_export", { path: join(outside, "secret.md"), format: "md" }), /inside the workspace/);
  });
});
