import { test } from "node:test";
import assert from "node:assert/strict";
import { PROGRESS_NARRATION_GUIDELINE, adaptSystemPrompt } from "./prompt-narration.ts";

/**
 * 系统提示词改写（进度说明）的契约：
 * 1. pi 的 concise 行被整行替换，原句不再出现；
 * 2. pi 升级改了措辞（匹配不到）→ 原样保留 + 照常追加，不报错；
 * 3. 追加段幂等（只出现一次）；
 * 4. 整行精确匹配：前缀相同但更长的行不被误替换；
 * 5. 追加段措辞锚定（用户认可的一字不差的版本，防手滑漂移）。
 */

const PI_BASE = [
  "You are an expert coding assistant operating inside pi, a coding agent harness.",
  "",
  "Guidelines:",
  "- Follow the user's instructions carefully",
  "- Be concise in your responses",
  "- Show file paths clearly when working with files",
].join("\n");

test("concise 行被替换成 final answers，原句不再出现", () => {
  const out = adaptSystemPrompt(PI_BASE);
  assert.equal(out.includes("- Be concise in your responses\n"), false, "原句（行形态）不能再出现");
  assert.equal(out.includes("- Be concise in your final answers."), true);
});

test("匹配不到（pi 升级改措辞）：原样保留 + 照常追加，不报错", () => {
  const out = adaptSystemPrompt("Guidelines:\n- Be brief\n");
  assert.equal(out.includes("- Be brief"), true);
  assert.equal(out.includes(PROGRESS_NARRATION_GUIDELINE), true);
});

test("追加段幂等：对输出再跑一遍，段落只出现一次且内容不变", () => {
  const once = adaptSystemPrompt(PI_BASE);
  const twice = adaptSystemPrompt(once);
  assert.equal(twice, once);
  assert.equal(twice.split(PROGRESS_NARRATION_GUIDELINE).length - 1, 1, "追加段只出现一次");
});

test("整行精确匹配：前缀相同但更长的行不被替换", () => {
  const variant = "Guidelines:\n- Be concise in your responses and keep it short\n";
  const out = adaptSystemPrompt(variant);
  assert.equal(out.includes("- Be concise in your responses and keep it short"), true, "更长的那行原样保留");
  assert.equal(out.includes("- Be concise in your final answers."), false, "没有整行命中就不替换");
});

test("追加段措辞锚定（用户认可版本，一字不差）", () => {
  assert.equal(
    PROGRESS_NARRATION_GUIDELINE,
    "工具调用和思考在界面上默认折叠，用户只能看到你写出的正文。\n" +
      "开始一组工具调用前，用一句话说明接下来要做什么；每完成一个阶段（调研结束、定位到原因、改完、验证完），用一两句话写出阶段性结论。\n" +
      "不要逐个工具复述命令，也不要把思考原文搬进正文。",
  );
});

test("其余内容不动：替换与追加之外的基底逐字保留", () => {
  const out = adaptSystemPrompt(PI_BASE);
  assert.ok(out.startsWith(PI_BASE.split("\n").slice(0, 4).join("\n")), "前四行原样");
  assert.equal(out.includes("- Show file paths clearly when working with files"), true);
});
