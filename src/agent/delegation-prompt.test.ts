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

/** 子会话模型事实：本会话模型 + （可选）设置里的子会话模型 */
const FACTS = { sessionModelId: "deepseek-v4" } as const;
const FACTS_WITH_DEFAULT = { sessionModelId: "deepseek-v4", subSessionModelId: "glm-5.3" } as const;

describe("describeChannelRole：root 的对齐段与闭环段", () => {
  test("root 三档都带对齐段，且带子会话模型事实（默认落点 + 看图能力）", () => {
    for (const mode of MODES) {
      const text = describeChannelRole("root", mode, MODELS, FACTS);
      assert.ok(text.includes(ALIGNMENT_OPEN), `${mode} 档该有对齐段`);
      assert.ok(text.includes(ALIGNMENT_CLOSE), `${mode} 档对齐段要闭合`);
      // 不再铺开清单：不出现逐条厂商/型号表
      assert.equal(text.includes("Available models for sub-sessions"), false);
      assert.match(text, /Sub-session models:/);
      // 默认落点：没设 subSessionModel → 本会话模型
      assert.match(text, /inherits this session's model \(deepseek-v4\)/);
      // 看图能力只列声明为 true 的型号（glm-5.3 声明 true；gpt-x 是 false、deepseek-v4 未声明 → 都不列）
      assert.match(text, /Models that accept image input: glm-5\.3\./);
      assert.doesNotMatch(text, /Models that accept image input: [^\n]*gpt-x/, "声明为 no 的模型不进看图名单");
      assert.doesNotMatch(
        text,
        /Models that accept image input: [^\n]*deepseek-v4/,
        "未声明能力的模型不进看图名单",
      );
    }
  });

  test("设了子会话模型时，默认落点写成设置里的那个（优先于同父）", () => {
    const text = describeChannelRole("root", "skip", MODELS, FACTS_WITH_DEFAULT);
    assert.match(text, /inherits the configured sub-session model \(glm-5\.3\)/);
    assert.equal(text.includes("inherits this session's model"), false);
  });

  test("一个模型都没声明 vision 时，看图那行如实写「没有声明」，不猜", () => {
    const noVision = MODELS.filter((model) => model.imageInput !== true);
    const text = describeChannelRole("root", "skip", noVision, FACTS);
    assert.match(text, /No configured model is declared as accepting image input\./);
  });

  test("只有 skip + root 带闭环段；manual / plan 不带", () => {
    assert.ok(describeChannelRole("root", "skip", MODELS, FACTS).includes(VERIFICATION_OPEN));
    for (const mode of ["plan", "manual"] as const) {
      assert.equal(
        describeChannelRole("root", mode, MODELS, FACTS).includes(VERIFICATION_OPEN),
        false,
        `${mode} 档不该自动跑验收闭环`,
      );
    }
  });

  test("对齐段措辞锚定（防手滑漂移）：先对齐再派、至多三问、每问带默认值", () => {
    const text = delegationAlignmentGuideline("skip", MODELS, FACTS);
    assert.match(text, /propose the plan before delegating/);
    assert.match(text, /never\s+delegate first and explain later/);
    assert.match(text, /At most three questions, each with your default/);
    assert.match(text, /a plain "ok" is enough to start/);
    assert.match(text, /Delegate only after an explicit go-ahead/);
    // 口径写实（2026-10-18 第三轮验收）：已给方案与默认值后，「你看着办」算授权；
    // 还没给方案、或回复质疑拆分时才再确认一次。
    assert.match(text, /counts as approval/);
    assert.match(text, /confirm once with the concrete default/);
    // 不再有「从下面清单里推荐」；改成推荐默认落点或用户给的 id，绝不编造
    assert.match(text, /Never invent a model id/);
    assert.equal(text.includes("Recommend from the available models below"), false);
  });

  test("档位语义写进对齐段：skip 说确认后自主跑；manual / plan 说审查交回用户", () => {
    assert.match(
      delegationAlignmentGuideline("skip", MODELS, FACTS),
      /carry the plan through without asking again/,
    );
    for (const mode of ["plan", "manual"] as const) {
      const text = delegationAlignmentGuideline(mode, MODELS, FACTS);
      assert.match(text, /do not start a review on your own/);
      // manual / plan 不是「不提审查」：把选择权交回时要用一句话给出可选动作
      assert.match(text, /offer an independent review\s+in one line/);
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
    // 并行上限写成分批动作（第三轮实测：一条消息派了 4 个；运行时闸门另行立项）
    assert.match(AUTO_VERIFICATION_GUIDELINE, /start the first three, queue the rest/);
    assert.match(AUTO_VERIFICATION_GUIDELINE, /start the next only after one reports/);
  });
});

describe("describeChannelRole：child 不带这两段", () => {
  test("child 三档都没有对齐段与闭环段", () => {
    for (const mode of MODES) {
      const text = describeChannelRole("child", mode, MODELS, FACTS);
      assert.equal(text.includes(ALIGNMENT_OPEN), false, `child 不该有对齐段（${mode}）`);
      assert.equal(text.includes(VERIFICATION_OPEN), false, `child 不该有闭环段（${mode}）`);
      assert.match(text, /report_to_parent/);
    }
  });
});

describe("describeChannelRole：档位与子会话模型事实逐轮重讲", () => {
  test("同一档位换了看图模型，拼装结果跟着变（加了模型下一轮生效）", () => {
    const before = describeChannelRole("root", "skip", MODELS, FACTS);
    const after = describeChannelRole("root", "skip", [
      ...MODELS,
      { providerId: "kimi", providerName: "Kimi", modelId: "k3", modelName: "K3", imageInput: true },
    ], FACTS);
    assert.notEqual(after, before);
    assert.match(after, /Models that accept image input: glm-5\.3, k3\./);
  });

  test("换了本会话模型，默认落点跟着变（同一档位、同一清单）", () => {
    const before = describeChannelRole("root", "skip", MODELS, { sessionModelId: "deepseek-v4" });
    const after = describeChannelRole("root", "skip", MODELS, { sessionModelId: "k3" });
    assert.notEqual(after, before);
    assert.match(after, /inherits this session's model \(k3\)/);
  });

  test("清单为空（没配好 provider）：照样生成对齐段，默认落点与「没有声明看图」照写", () => {
    const text = describeChannelRole("root", "skip", [], FACTS);
    assert.ok(text.includes(ALIGNMENT_OPEN));
    assert.match(text, /inherits this session's model \(deepseek-v4\)/);
    assert.match(text, /No configured model is declared as accepting image input\./);
    assert.equal(text.includes("Available models for sub-sessions"), false);
  });

  test("同一会话切换档位：闭环段随档位出现 / 消失", () => {
    const inSkip = describeChannelRole("root", "skip", MODELS, FACTS);
    const inManual = describeChannelRole("root", "manual", MODELS, FACTS);
    assert.ok(inSkip.includes(VERIFICATION_OPEN));
    assert.equal(inManual.includes(VERIFICATION_OPEN), false);
    // 对齐段两档都在（只有闭环段随档位变）
    assert.ok(inSkip.includes(ALIGNMENT_OPEN) && inManual.includes(ALIGNMENT_OPEN));
  });
});
