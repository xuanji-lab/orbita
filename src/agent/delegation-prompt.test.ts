/**
 * 派发前对齐 + 放行档验收闭环两段提示词的拼装契约（2026-10-18 用户裁决，合作者定稿）。
 *
 * 测的是可 import 的纯模块（delegation-prompt.ts + channel-tools.ts 的
 * describeChannelRole）——runtime.ts 顶层有副作用，import 不了它，拼装契约只能钉在
 * 这里（同 prompt-narration.test.ts 的理由）。
 *
 * 四条不变量：
 * 1. root **任何档位**都带对齐段，且带上本轮的可选模型清单；
 * 2. 闭环段**只有 skip + root** 有——manual / plan 档验收结果与「要不要审查」交回用户；
 * 3. child 任何档位都没有这两段（它不能再派，讲验收只会诱导它调不存在的工具）；
 * 4. 档位与清单逐轮重讲：换了它们，下一轮拼出来的文本跟着变；清单为空时写明沿用父模型。
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { describeChannelRole } from "./channel-tools.ts";
import { AUTO_VERIFICATION_GUIDELINE, delegationAlignmentGuideline } from "./delegation-prompt.ts";
import type { AvailableModel } from "../shared/available-models.ts";
import type { PermissionMode } from "../shared/permission.ts";

const MODES: readonly PermissionMode[] = ["plan", "manual", "skip"];

const MODELS: readonly AvailableModel[] = [
  {
    providerId: "zai-coding",
    providerName: "Zhipu",
    modelId: "glm-5.3",
    modelName: "GLM-5.3",
    imageInput: true,
  },
  // 配置没声明能不能看图 → 提示词要写 unknown，不许猜
  { providerId: "deepseek", providerName: "DeepSeek", modelId: "deepseek-v4", modelName: "deepseek-v4" },
  {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "gpt-x",
    modelName: "GPT-X",
    imageInput: false,
  },
];

const ALIGNMENT_OPEN = "<orbita-delegation>";
const ALIGNMENT_CLOSE = "</orbita-delegation>";
const VERIFICATION_OPEN = "<orbita-auto-verification>";

describe("describeChannelRole：root 的对齐段与闭环段", () => {
  test("root 三档都带对齐段，且带本轮可选模型清单", () => {
    for (const mode of MODES) {
      const text = describeChannelRole("root", mode, MODELS);
      assert.ok(text.includes(ALIGNMENT_OPEN), `${mode} 档该有对齐段`);
      assert.ok(text.includes(ALIGNMENT_CLOSE), `${mode} 档对齐段要闭合`);
      assert.match(text, /Available models for sub-sessions/);
      assert.match(text, /provider: Zhipu \(zai-coding\) \/ model id: glm-5\.3 \/ display name: GLM-5\.3 \/ image input: yes/);
      assert.match(text, /image input: unknown/, "没声明能力时如实写 unknown，不猜");
      assert.match(text, /image input: no/);
    }
  });

  test("只有 skip + root 带闭环段；manual / plan 不带", () => {
    assert.ok(describeChannelRole("root", "skip", MODELS).includes(VERIFICATION_OPEN));
    for (const mode of ["plan", "manual"] as const) {
      assert.equal(
        describeChannelRole("root", mode, MODELS).includes(VERIFICATION_OPEN),
        false,
        `${mode} 档不该自动跑验收闭环`,
      );
    }
  });

  test("对齐段措辞锚定（防手滑漂移）：先对齐再派、至多三问、每问带默认值", () => {
    const text = delegationAlignmentGuideline("skip", MODELS);
    assert.match(text, /propose the plan before delegating/);
    assert.match(text, /never\s+delegate first and explain later/);
    assert.match(text, /At most three questions, each with your default/);
    assert.match(text, /a plain "ok" is enough to start/);
    assert.match(text, /Delegate only after an explicit go-ahead/);
    assert.match(text, /factual statement only/);
  });

  test("档位语义写进对齐段：skip 说确认后自主跑；manual / plan 说审查交回用户", () => {
    assert.match(delegationAlignmentGuideline("skip", MODELS), /carry the plan through without asking again/);
    for (const mode of ["plan", "manual"] as const) {
      const text = delegationAlignmentGuideline(mode, MODELS);
      assert.match(text, /do not start a review on your own/);
      assert.equal(text.includes("carry the plan through without asking again"), false);
    }
  });

  test("闭环段措辞锚定：done 只是声明不是结果、复跑、返工至多 3 轮、独立审查、逐条裁决", () => {
    assert.match(AUTO_VERIFICATION_GUIDELINE, /A sub-session's done report is a claim, not a result/);
    assert.match(AUTO_VERIFICATION_GUIDELINE, /re-run the\s+checks yourself/);
    assert.match(AUTO_VERIFICATION_GUIDELINE, /at most 3 rounds/);
    assert.match(AUTO_VERIFICATION_GUIDELINE, /delegate an independent review/);
    assert.match(AUTO_VERIFICATION_GUIDELINE, /says "not found" rather than "does not exist"/);
    assert.match(AUTO_VERIFICATION_GUIDELINE, /Decide each finding yourself/);
    // 跨轮推进：派完结束本轮，不轮询
    assert.match(AUTO_VERIFICATION_GUIDELINE, /end the\s+turn instead of polling/);
  });
});

describe("describeChannelRole：child 不带这两段", () => {
  test("child 三档都没有对齐段与闭环段", () => {
    for (const mode of MODES) {
      const text = describeChannelRole("child", mode, MODELS);
      assert.equal(text.includes(ALIGNMENT_OPEN), false, `child 不该有对齐段（${mode}）`);
      assert.equal(text.includes(VERIFICATION_OPEN), false, `child 不该有闭环段（${mode}）`);
      assert.match(text, /report_to_parent/);
    }
  });
});

describe("describeChannelRole：档位与清单逐轮重讲", () => {
  test("同一档位换模型清单，拼装结果跟着变（加了模型下一轮生效）", () => {
    const before = describeChannelRole("root", "skip", MODELS);
    const after = describeChannelRole("root", "skip", [
      ...MODELS,
      { providerId: "kimi", providerName: "Kimi", modelId: "k3", modelName: "K3", imageInput: true },
    ]);
    assert.notEqual(after, before);
    assert.match(after, /model id: k3/);
  });

  test("清单为空（或缺席）：照样生成对齐段，写明没有可选模型、沿用父会话的模型", () => {
    const text = describeChannelRole("root", "skip", []);
    assert.ok(text.includes(ALIGNMENT_OPEN));
    assert.match(text, /none are configured — sub-sessions inherit this session's model/);
    assert.equal(text.includes("Available models for sub-sessions (provider"), false);
  });

  test("同一会话切换档位：闭环段随档位出现 / 消失", () => {
    const inSkip = describeChannelRole("root", "skip", MODELS);
    const inManual = describeChannelRole("root", "manual", MODELS);
    assert.ok(inSkip.includes(VERIFICATION_OPEN));
    assert.equal(inManual.includes(VERIFICATION_OPEN), false);
    // 对齐段两档都在（只有闭环段随档位变）
    assert.ok(inSkip.includes(ALIGNMENT_OPEN) && inManual.includes(ALIGNMENT_OPEN));
  });
});
