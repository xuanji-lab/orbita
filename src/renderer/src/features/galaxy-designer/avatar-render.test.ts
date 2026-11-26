import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AvatarRenderPolicy, AvatarRenderPolicyResult } from "../../../../shared/planet-avatar.ts";
import { avatarNotes, avatarRenderNote, avatarRenderSwitchTitle } from "./avatar-render.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

/** 一份读得出来的策略 */
const policy = (extra: Partial<AvatarRenderPolicy>): AvatarRenderPolicyResult => ({
  ok: true,
  policy: { mode: "hand_drawn", preset: "svg", label: "只让智能体画 SVG", note: "", candidates: ["model_svg", "model_svg"], decided: true, problem: null, ...extra },
});

describe("avatarRenderNote：开关下面那行说明什么时候出现、写什么", () => {
  it("还在读、或是面板自己的两档（svg / image_only）：不写说明，开关自己说清了", () => {
    assert.equal(avatarRenderNote(null, zh), null);
    assert.equal(avatarRenderNote(policy({}), zh), null);
    assert.equal(avatarRenderNote(policy({ mode: "image_tool", preset: "image_only" }), zh), null);
  });

  it("插件没装 / 脚本跑不起来：写「开关不可用」和原因", () => {
    const note = avatarRenderNote({ ok: false, error: "没装插件「行星造物」（planet-forge）" }, zh);
    assert.match(note ?? "", /开关不可用/);
    assert.match(note ?? "", /行星造物/);
  });

  it("策略文件读不出来：照实写插件给的原因，并说拨一下开关会重写它", () => {
    const note = avatarRenderNote(policy({ problem: "render-policy.json 不是合法 JSON" }), zh);
    assert.match(note ?? "", /读不出来/);
    assert.match(note ?? "", /不是合法 JSON/);
    assert.match(note ?? "", /重写/);
  });

  it("旧档 image_first：开关算「开」，说明里交代它其实是 2 张图 + 1 张手绘", () => {
    const note = avatarRenderNote(policy({ mode: "image_tool", preset: "image_first" }), zh);
    assert.match(note ?? "", /2 张/);
    assert.match(avatarRenderNote(policy({ mode: "image_tool", preset: "image_first" }), en) ?? "", /2 images/);
  });

  it("ask：开关算「关」，说明里交代从这里出图不会停下来问", () => {
    const note = avatarRenderNote(policy({ preset: "ask" }), zh);
    assert.match(note ?? "", /不会停下来问/);
    assert.match(avatarRenderNote(policy({ preset: "ask" }), en) ?? "", /don't stop to ask/);
  });

  it("custom：候选位写成面板自己的后端名（不写 model_svg 这种 id）", () => {
    const note = avatarRenderNote(policy({ preset: "custom", candidates: ["image_model", "model_svg"] }), zh);
    assert.match(note ?? "", /自定义/);
    assert.match(note ?? "", /图像模型 \/ 智能体手绘/);
    assert.doesNotMatch(note ?? "", /model_svg/);
  });
});

describe("avatarRenderSwitchTitle：开关的悬停名", () => {
  it("写明这一档是什么", () => {
    assert.match(avatarRenderSwitchTitle(false, zh), /手绘/);
    assert.match(avatarRenderSwitchTitle(true, zh), /生图工具/);
  });
});

describe("avatarNotes：插件账本的说明（这一轮为什么手绘了）", () => {
  it("原话照实显示；去掉「候选 N：」前缀后一样的只写一次", () => {
    assert.deepEqual(avatarNotes([]), []);
    assert.deepEqual(avatarNotes(["候选 1：没有可用的图像生成工具，改让智能体画 SVG", "候选 2：没有可用的图像生成工具，改让智能体画 SVG"]), ["没有可用的图像生成工具，改让智能体画 SVG"]);
    assert.deepEqual(avatarNotes(["候选 1：这次临时用图像模型"]), ["这次临时用图像模型"]);
    assert.deepEqual(avatarNotes(["第一句", "第一句", "第二句"]), ["第一句", "第二句"]);
  });
});
