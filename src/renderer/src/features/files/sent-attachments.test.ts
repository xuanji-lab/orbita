import test from "node:test";
import assert from "node:assert/strict";
import { collectSentAttachments, type TranscriptLikeItem } from "./sent-attachments.ts";

const user = (blocks: string[]): TranscriptLikeItem => ({
  role: "user",
  content: blocks.map((text) => ({ type: "text", text })),
});

const FILES_BLOCK = (lines: string[]): string =>
  ["<attached-files>", "The user attached these files from their disk. Read them with the read tool when you need their contents.", ...lines, "</attached-files>"].join("\n");

test("逐条用户消息解析附件块，保首现顺序", () => {
  const out = collectSentAttachments([
    user(["帮我看看这两个", FILES_BLOCK(["- /tmp/a.ts", "- /tmp/docs/"])]),
    { role: "assistant", content: [{ type: "text", text: FILES_BLOCK(["- /tmp/assistant-only.ts"]) }] },
    user([FILES_BLOCK(["- /tmp/b.md"])]),
  ]);
  assert.deepEqual(out, [
    { path: "/tmp/a.ts", kind: "file" },
    { path: "/tmp/docs", kind: "dir" }, // 尾斜杠还原成 dir
    { path: "/tmp/b.md", kind: "file" },
  ]);
});

test("同路径去重：跨消息重复引用只留一份", () => {
  const out = collectSentAttachments([
    user([FILES_BLOCK(["- /tmp/a.ts", "- /tmp/a.ts"])]),
    user([FILES_BLOCK(["- /tmp/a.ts", "- /tmp/c.ts"])]),
  ]);
  assert.deepEqual(out, [
    { path: "/tmp/a.ts", kind: "file" },
    { path: "/tmp/c.ts", kind: "file" },
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
  assert.deepEqual(out, [{ path: "/ws/plan.md", kind: "file" }]);
});
