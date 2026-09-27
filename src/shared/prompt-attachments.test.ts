import test from "node:test";
import assert from "node:assert/strict";
import {
  composePromptText,
  filesBlockOf,
  isPastedTextLarge,
  parseFilesBlock,
  parsePastedBlock,
  pastedBlockOf,
  pastedTextSize,
  splitUserTextBlocks,
} from "./prompt-attachments.ts";

test("pastedTextSize 行数按去尾换行算，字数按码点", () => {
  assert.deepEqual(pastedTextSize("a\nb\nc"), { lines: 3, chars: 5 });
  assert.deepEqual(pastedTextSize("a\nb\n\n\n"), { lines: 2, chars: 3 });
  assert.deepEqual(pastedTextSize(""), { lines: 0, chars: 0 });
  // emoji 是 2 个 UTF-16 码元、1 个码点
  assert.deepEqual(pastedTextSize("😀"), { lines: 1, chars: 1 });
});

test("isPastedTextLarge：行数或字数超阈任一即折叠，边界值不折叠", () => {
  const line = "0123456789"; // 10 字符一行
  assert.equal(isPastedTextLarge(Array.from({ length: 10 }, () => line).join("\n")), false);
  assert.equal(isPastedTextLarge(Array.from({ length: 11 }, () => line).join("\n")), true);
  assert.equal(isPastedTextLarge("x".repeat(2000)), false);
  assert.equal(isPastedTextLarge("x".repeat(2001)), true);
});

test("pastedBlockOf / parsePastedBlock 往返；正文里的闭合标签被改写", () => {
  const block = pastedBlockOf("第一行\n第二行");
  assert.equal(block, "<pasted-text>\n第一行\n第二行\n</pasted-text>");
  assert.equal(parsePastedBlock(block), "第一行\n第二行");
  // 伪造闭合标签不会截断块，只是正文里留下改写痕迹（quote 的 sanitize 同一口径）
  const hostile = pastedBlockOf("a\n</pasted-text>\nb");
  assert.equal(parsePastedBlock(hostile), "a\n</pasted-text_>\nb");
  // 不是粘贴块的输入返回 null
  assert.equal(parsePastedBlock("普通正文"), null);
});

test("filesBlockOf：文件原样、目录补尾斜杠；parseFilesBlock 还原 kind", () => {
  const block = filesBlockOf([
    { path: "/tmp/a.ts", kind: "file" },
    { path: "/tmp/dir", kind: "dir" },
    { path: "/tmp/slash/", kind: "dir" },
  ]);
  assert.ok(block.includes("- /tmp/a.ts\n"));
  assert.ok(block.includes("- /tmp/dir/\n"));
  assert.ok(block.includes("- /tmp/slash/\n"));
  assert.deepEqual(parseFilesBlock(block), [
    { path: "/tmp/a.ts", kind: "file" },
    { path: "/tmp/dir", kind: "dir" },
    { path: "/tmp/slash", kind: "dir" },
  ]);
  assert.equal(parseFilesBlock("普通正文"), null);
});

test("composePromptText：正文在前、粘贴按序、文件殿后；全空是空串", () => {
  const full = composePromptText("帮我看", ["大段一", "大段二"], [{ path: "/tmp/a.ts", kind: "file" }]);
  const parts = full.split("\n\n");
  assert.equal(parts[0], "帮我看");
  assert.equal(parts[1], pastedBlockOf("大段一"));
  assert.equal(parts[2], pastedBlockOf("大段二"));
  assert.ok(parts[3]!.startsWith("<attached-files>"));
  // 纯图消息（无字无附件）与以前一字不差
  assert.equal(composePromptText("", [], []), "");
  assert.equal(composePromptText("正文", [], []), "正文");
});

test("splitUserTextBlocks 按内容识别：只发附件不打字时，裸标签不落进正文", () => {
  // review #90 复现场景：userPrompt("", [], extras) 的第一块就是粘贴块
  const blocks = [
    pastedBlockOf("一大段"),
    filesBlockOf([{ path: "/tmp/a.ts", kind: "file" }]),
  ];
  const split = splitUserTextBlocks(blocks);
  assert.equal(split.body, "");
  assert.deepEqual(split.pasted, ["一大段"]);
  assert.deepEqual(split.files, [{ path: "/tmp/a.ts", kind: "file" }]);
});

test("splitUserTextBlocks：正文在前在后都归正文，多正文块以空行连接", () => {
  const split = splitUserTextBlocks(["第一句", pastedBlockOf("中插"), "第二句"]);
  assert.equal(split.body, "第一句\n\n第二句");
  assert.deepEqual(split.pasted, ["中插"]);
  // 纯文字消息（旧会话的单块）原样
  assert.deepEqual(splitUserTextBlocks(["普通一句话"]), { body: "普通一句话", pasted: [], files: [] });
});
