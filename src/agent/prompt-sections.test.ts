/**
 * 系统提示词「身份段」与「装配顺序」的契约测试（2026-10-18）：
 *   1. 身份段（identity-prompt）：内容锚定——英文一句话、产品名与中文名都在，
 *      且**不含**「动作前确认」类措辞（那是权限模式段的职责，两处写会互相打架）；
 *   2. 装配（system-prompt）：身份段紧跟基底、在权限段之前；回复语言段恒在最末；
 *      空串段被滤掉；顺序与对象键序无关。
 *
 * 为什么装配也要测：顺序契约原本写在 runtime.ts 的数组里，而那个模块顶层有副作用
 * （没有 parentPort 就 exit），测试 import 不了它——顺序就没人能钉住。抽成纯函数后，
 * 这条断言才成立（测试 import 的是 system-prompt.ts，runtime 真的调它）。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ORBITA_IDENTITY_GUIDELINE } from "./identity-prompt.ts";
import { composeSystemPrompt, type SystemPromptParts } from "./system-prompt.ts";

const PI_BASE = "You are an expert coding assistant operating inside pi, a coding agent harness.";

describe("身份段", () => {
  test("措辞锚定（防手滑漂移）", () => {
    assert.equal(ORBITA_IDENTITY_GUIDELINE, "You are Orbita (璇玑), a local-first desktop AI agent.");
  });

  test("两个名字都在，且不是空串（空串会被装配滤掉，等于没讲）", () => {
    assert.ok(ORBITA_IDENTITY_GUIDELINE.length > 0);
    assert.match(ORBITA_IDENTITY_GUIDELINE, /Orbita/);
    assert.match(ORBITA_IDENTITY_GUIDELINE, /璇玑/);
  });

  test("只管身份：不写「动作前确认」（权限段在管，两处写会矛盾）、不把自己限定成编程助手", () => {
    for (const keyword of ["不可逆删除", "对外发送", "付费", "系统设置", "confirm", "ask the user"]) {
      assert.equal(ORBITA_IDENTITY_GUIDELINE.includes(keyword), false, `不该出现「${keyword}」`);
    }
    assert.equal(/coding assistant|programming/i.test(ORBITA_IDENTITY_GUIDELINE), false);
  });
});

describe("系统提示词装配", () => {
  const parts = (patch: Partial<SystemPromptParts> = {}): SystemPromptParts => ({
    base: PI_BASE,
    permission: '<orbita-permission>\nThe user has set tool permission to "skip".\n</orbita-permission>',
    directories: "<directories>cwd</directories>",
    channelRole: "<orbita-sub-sessions>root</orbita-sub-sessions>",
    storeTools: "<orbita-store>workspace</orbita-store>",
    toolGuidelines: "For commands that may take a while…",
    expectedSeconds: "When calling bash/powershell…",
    intent: "",
    quote: "Quoted context…",
    gitAttribution: "",
    replyLanguage: "Reply language: write all user-visible text…",
    ...patch,
  });

  test("身份段紧跟基底、在权限段之前", () => {
    const out = composeSystemPrompt(parts());
    assert.ok(out.startsWith(PI_BASE), "基底仍是最前面");
    const identityAt = out.indexOf(ORBITA_IDENTITY_GUIDELINE);
    const permissionAt = out.indexOf("<orbita-permission>");
    assert.ok(identityAt > 0, "身份段必须在");
    assert.ok(permissionAt > identityAt, "身份段在权限段之前");
    assert.equal(out.indexOf(ORBITA_IDENTITY_GUIDELINE, identityAt + 1), -1, "身份段只出现一次");
  });

  test("回复语言段恒在最末（离对话最近、权重最高）", () => {
    const out = composeSystemPrompt(parts({ intent: "intent context…", gitAttribution: "git…" }));
    assert.ok(out.endsWith(parts().replyLanguage));
  });

  test("空串段被滤掉，不留空行", () => {
    const out = composeSystemPrompt(parts());
    assert.equal(out.includes("\n\n\n"), false, "不该出现连续空行");
    assert.equal(out.includes("<orbita-store>"), true);
  });

  test("顺序与对象键序无关（契约在装配函数里，不在调用方的字面量里）", () => {
    const straight = composeSystemPrompt(parts());
    const shuffled = composeSystemPrompt({
      quote: parts().quote,
      replyLanguage: parts().replyLanguage,
      toolGuidelines: parts().toolGuidelines,
      base: parts().base,
      channelRole: parts().channelRole,
      expectedSeconds: parts().expectedSeconds,
      directories: parts().directories,
      intent: "",
      gitAttribution: "",
      permission: parts().permission,
      storeTools: parts().storeTools,
    });
    assert.equal(shuffled, straight);
  });
});
