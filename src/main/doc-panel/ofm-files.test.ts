import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileRoot } from "../../shared/files.ts";
import { attachmentDir, safeAttachmentName, uniqueAttachmentName } from "../../shared/ofm/attach.ts";
import { buildDocExport } from "./doc-export.ts";
import { dropIndex, indexRoot, resolveTargets, saveAttachment } from "./ofm-files.ts";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir = "";
let outside = "";
let roots: FileRoot[] = [];
const doc = () => join(dir, "周报", "2026-W45.md");

before(async () => {
  dir = await mkdtemp(join(tmpdir(), "ofm-ws-"));
  outside = await mkdtemp(join(tmpdir(), "ofm-out-"));
  roots = [{ kind: "workspace", label: "ws", path: dir, exists: true }];
  await mkdir(join(dir, "周报"), { recursive: true });
  await mkdir(join(dir, "node_modules", "x"), { recursive: true });
  await mkdir(join(dir, ".hidden"), { recursive: true });
  await writeFile(doc(), "# 周报");
  await writeFile(join(dir, "周报", "pipeline.png"), PNG);
  await writeFile(join(dir, "设计系统迭代记录.md"), "x");
  await writeFile(join(dir, "node_modules", "x", "a.md"), "x");
  await writeFile(join(dir, ".hidden", "b.md"), "x");
  await writeFile(join(outside, "secret.png"), PNG);
  await symlink(join(outside, "secret.png"), join(dir, "link.png"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("工作区索引与目标解析", () => {
  it("索引跳过点目录与依赖目录；解析按同目录优先、找不到是 null、结果带根", async () => {
    dropIndex(dir);
    const files = await indexRoot(dir);
    assert.ok(files.includes("周报/pipeline.png"));
    assert.equal(files.some((f) => f.startsWith("node_modules/") || f.startsWith(".hidden/")), false);
    const [img, link, miss, escape] = await resolveTargets(roots, doc(), [
      { target: "pipeline.png", kind: "image" },
      { target: "设计系统迭代记录", kind: "link" },
      { target: "不存在", kind: "link" },
      { target: "../../../etc/passwd", kind: "image" },
    ]);
    assert.equal(img?.path, join(dir, "周报", "pipeline.png"));
    assert.equal(img?.root, dir);
    assert.equal(link?.relative, "设计系统迭代记录.md");
    assert.equal(miss, null);
    assert.equal(escape, null);
  });

  it("文档不在任何根里：全部解析不到", async () => {
    const result = await resolveTargets(roots, join(outside, "x.md"), [{ target: "a", kind: "link" }]);
    assert.deepEqual(result, [null]);
  });
});

describe("插图落盘", () => {
  it("默认放 attachments/，写 ![](相对路径)；重名加序号；非图片 / 超大拒绝", async () => {
    const first = await saveAttachment(roots, doc(), { kind: "bytes", name: "Pasted image 1.png", bytes: PNG });
    assert.equal(first.markdown, "![](<../attachments/Pasted image 1.png>)");
    assert.equal(first.name, "Pasted image 1.png");
    assert.deepEqual(await readFile(first.path), PNG);
    const second = await saveAttachment(roots, doc(), { kind: "bytes", name: "Pasted image 1.png", bytes: PNG });
    assert.equal(second.name, "Pasted image 1 1.png");
    await assert.rejects(saveAttachment(roots, doc(), { kind: "bytes", name: "x.exe", bytes: PNG }), /不是图片/);
    await assert.rejects(
      saveAttachment(roots, doc(), { kind: "bytes", name: "big.png", bytes: new Uint8Array(26 * 1024 * 1024) }),
      /太大/,
    );
    // 刚放进去的图马上能被解析到（索引缓存已丢）
    const [hit] = await resolveTargets(roots, doc(), [{ target: first.name, kind: "image" }]);
    assert.equal(hit?.path, first.path);
  });

  it("Obsidian 库：读 .obsidian/app.json 的 attachmentFolderPath，写 ![[名]]", async () => {
    const vault = await mkdtemp(join(tmpdir(), "ofm-vault-"));
    try {
      await mkdir(join(vault, ".obsidian"), { recursive: true });
      await writeFile(join(vault, ".obsidian", "app.json"), JSON.stringify({ attachmentFolderPath: "资源/图" }));
      await writeFile(join(vault, "n.md"), "x");
      const r: FileRoot[] = [{ kind: "workspace", label: "v", path: vault, exists: true }];
      const saved = await saveAttachment(r, join(vault, "n.md"), { kind: "bytes", name: "a.png", bytes: PNG });
      assert.equal(saved.markdown, "![[a.png]]");
      assert.equal(saved.path, join(vault, "资源", "图", "a.png"));
      // 没设置 = 库根（Obsidian 默认）
      await writeFile(join(vault, ".obsidian", "app.json"), "{}");
      const root = await saveAttachment(r, join(vault, "n.md"), { kind: "bytes", name: "b.png", bytes: PNG });
      assert.equal(root.path, join(vault, "b.png"));
    } finally {
      await rm(vault, { recursive: true, force: true });
    }
  });

  it("附件目录规则（纯函数）：相对文档、相对库根、越界退回默认", () => {
    assert.equal(attachmentDir({ vault: false, setting: undefined, docDir: "周报" }), "attachments");
    assert.equal(attachmentDir({ vault: true, setting: undefined, docDir: "周报" }), "");
    assert.equal(attachmentDir({ vault: true, setting: "/", docDir: "周报" }), "");
    assert.equal(attachmentDir({ vault: true, setting: "./图", docDir: "周报" }), "周报/图");
    assert.equal(attachmentDir({ vault: true, setting: "./", docDir: "周报" }), "周报");
    assert.equal(attachmentDir({ vault: true, setting: "assets/img", docDir: "周报" }), "assets/img");
    assert.equal(attachmentDir({ vault: true, setting: "../../x", docDir: "周报" }), "attachments");
    assert.equal(safeAttachmentName("../../a/b:c.png"), "b_c.png");
    assert.equal(safeAttachmentName("shot"), "shot.png");
    assert.equal(uniqueAttachmentName("a.png", (c) => c === "a.png" || c === "a 1.png"), "a 2.png");
  });
});

describe("buildDocExport", () => {
  const text = "# 标题\n\n见 [[页|别名]] ==亮==\n\n![[pipeline.png]]\n\n> [!warning] 风险\n> 内容\n";
  it("md 原样；md-plain 无 OFM 残留且图片写成相对路径；docx 带图；pdf 经注入的打印函数", async () => {
    const md = await buildDocExport({ format: "md", text, docReal: doc(), roots, title: "t" });
    assert.equal(Buffer.from(md.bytes).toString("utf8"), text);
    const plain = Buffer.from((await buildDocExport({ format: "md-plain", text, docReal: doc(), roots, title: "t" })).bytes).toString("utf8");
    assert.equal(/\[\[|==|> \[!/.test(plain), false, plain);
    assert.match(plain, /!\[\]\(pipeline\.png\)/);
    const docx = await buildDocExport({ format: "docx", text, docReal: doc(), roots, title: "t" });
    assert.equal(docx.ext, "docx");
    assert.ok(Buffer.from(docx.bytes).subarray(0, 2).toString() === "PK");
    let html = "";
    const pdf = await buildDocExport({
      format: "pdf",
      text,
      docReal: doc(),
      roots,
      title: "t",
      printPdf: async (h) => {
        html = h;
        return Buffer.from("%PDF-fake");
      },
    });
    assert.equal(pdf.ext, "pdf");
    assert.match(html, /data:image\/png;base64,/);
    assert.match(html, /data-callout="warning"/);
    await assert.rejects(buildDocExport({ format: "pdf", text, docReal: doc(), roots, title: "t" }), /没有打印能力/);
  });
});
