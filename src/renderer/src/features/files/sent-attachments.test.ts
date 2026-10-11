import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentName,
  collectSentAttachments,
  type TranscriptLikeItem,
} from "./sent-attachments.ts";

const user = (blocks: (string | { image: string })[]): TranscriptLikeItem => ({
  role: "user",
  content: blocks.map((block) =>
    typeof block === "string"
      ? { type: "text", text: block }
      : { type: "image", data: "x", mimeType: "image/png", original: block.image },
  ),
});

const FILES_BLOCK = (lines: string[]): string =>
  ["<attached-files>", "The user attached these files from their disk. Read them with the read tool when you need their contents.", ...lines, "</attached-files>"].join("\n");

// 合法的原图引用形（ORIGINAL_REF）：<会话 id>/<uuid>.<ext>
const REF = (n: number, ext = "png"): string =>
  `01a0c4fd-9ee5-73fc-82a8-78c43b90d20d/5b0d1a52-8c7e-4c52-9d0b-3f6a2b1c9e${String(n).padStart(2, "0")}.${ext}`;

test("逐条用户消息解析附件块，保首现顺序", () => {
  const out = collectSentAttachments([
    user(["帮我看看这两个", FILES_BLOCK(["- /tmp/a.ts", "- /tmp/docs/"])]),
    { role: "assistant", content: [{ type: "text", text: FILES_BLOCK(["- /tmp/assistant-only.ts"]) }] },
    user([FILES_BLOCK(["- /tmp/b.md"])]),
  ]);
  assert.deepEqual(out, [
    { kind: "ref", path: "/tmp/a.ts", fileKind: "file" },
    { kind: "ref", path: "/tmp/docs", fileKind: "dir" }, // 尾斜杠还原成 dir
    { kind: "ref", path: "/tmp/b.md", fileKind: "file" },
  ]);
});

test("同路径去重：跨消息重复引用只留一份", () => {
  const out = collectSentAttachments([
    user([FILES_BLOCK(["- /tmp/a.ts", "- /tmp/a.ts"])]),
    user([FILES_BLOCK(["- /tmp/a.ts", "- /tmp/c.ts"])]),
  ]);
  assert.deepEqual(out, [
    { kind: "ref", path: "/tmp/a.ts", fileKind: "file" },
    { kind: "ref", path: "/tmp/c.ts", fileKind: "file" },
  ]);
});

test("没有附件块的纯文字消息、空转录都不产出", () => {
  assert.deepEqual(collectSentAttachments([]), []);
  assert.deepEqual(collectSentAttachments([user(["你好"])]), []);
  // 粘贴块不是附件
  assert.deepEqual(collectSentAttachments([user(["<pasted-text>\nhi\n</pasted-text>"])]), []);
});

test("正文与附件块同在一条消息里也解析得出（块按内容识别，不按位置猜）", () => {
  const out = collectSentAttachments([
    user([`读一下`, FILES_BLOCK(["- /ws/plan.md"])]),
  ]);
  assert.deepEqual(out, [{ kind: "ref", path: "/ws/plan.md", fileKind: "file" }]);
});

test("图块收进清单：合成名按整条会话首现顺序编号，扩展名取自引用", () => {
  const out = collectSentAttachments([
    user([{ image: REF(1) }, { image: REF(2, "jpg") }]),
    user([{ image: REF(3) }]),
  ]);
  assert.deepEqual(out, [
    { kind: "image", ref: REF(1), name: "image-1.png" },
    { kind: "image", ref: REF(2, "jpg"), name: "image-2.jpg" },
    { kind: "image", ref: REF(3), name: "image-3.png" },
  ]);
});

test("图块与 <attached-files> 混在同一条消息：按转录块序排（文件引用在图前），跨消息去重保首现位", () => {
  const out = collectSentAttachments([
    // userPrompt 的拼装顺序：正文 / 附件块在前，图块殿后
    user(["hi", FILES_BLOCK(["- /tmp/a.ts"]), { image: REF(1) }]),
    user([FILES_BLOCK(["- /tmp/a.ts", "- /tmp/b.md"]), { image: REF(1) }, { image: REF(2) }]),
  ]);
  assert.deepEqual(out, [
    { kind: "ref", path: "/tmp/a.ts", fileKind: "file" },
    { kind: "image", ref: REF(1), name: "image-1.png" },
    { kind: "ref", path: "/tmp/b.md", fileKind: "file" },
    { kind: "image", ref: REF(2), name: "image-2.png" },
  ]);
});

test("没有原图引用的图块不进清单，编号不受影响", () => {
  const out = collectSentAttachments([
    user([{ image: "../etc/passwd" }, { image: REF(1) }]),
  ]);
  assert.deepEqual(out, [{ kind: "image", ref: REF(1), name: "image-1.png" }]);
});

test("attachmentName：文件引用取末段，附图用合成名，空末段退全路径", () => {
  assert.equal(attachmentName({ kind: "ref", path: "/tmp/a.ts", fileKind: "file" }), "a.ts");
  assert.equal(attachmentName({ kind: "image", ref: REF(1), name: "image-1.png" }), "image-1.png");
  assert.equal(attachmentName({ kind: "ref", path: "/", fileKind: "dir" }), "/");
});
