import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { ProviderDto } from "../../../../shared/provider.ts";
import { avatarModelChipText, avatarModelFace } from "./avatar-model.ts";
import { en } from "../../messages-en.ts";
import { zh } from "../../messages-zh.ts";

/**
 * 形象一节那颗模型胶囊写什么。夹具照用户正式版的情形：子会话默认模型是 Kimi Code 的 kimi-for-coding，
 * 会话栏用的是智谱的 glm-5.4。
 */
function provider(id: string, displayName: string, modelIds: string[], disabled = false): ProviderDto {
  return {
    id,
    displayName,
    disabled,
    endpoint: { baseUrl: "https://x.example", api: "anthropic-messages" },
    auth: { scheme: "api_key", hasSecret: true, masked: "abc…xyz" },
    models: { declared: modelIds.map((modelId) => ({ id: modelId })) },
  };
}

const GLM = { providerId: "zhipu-coding", modelId: "glm-5.4" };
const KIMI_CODE = { providerId: "kimi-coding", modelId: "kimi-for-coding" };
const providers = (): ProviderDto[] => [provider("zhipu-coding", "智谱 Coding Plan", ["glm-5.4"]), provider("kimi-coding", "Kimi Code", ["kimi-for-coding", "k3.1-pro"])];
const settings = { subSessionModel: KIMI_CODE };

const face = (input: Partial<Parameters<typeof avatarModelFace>[0]> = {}) =>
  avatarModelFace({ choice: undefined, session: GLM, settings, providers: providers(), catalog: [], t: zh, ...input });

describe("avatarModelFace：胶囊上写哪个模型、取法是哪一种", () => {
  it("没选过 = 跟会话栏：胶囊写「跟会话栏 · 」加会话栏那个模型的显示名，不被子会话默认模型压住", () => {
    const f = face();
    assert.deepEqual(f.pair, GLM);
    assert.equal(f.sourceLabel, "跟会话栏");
    assert.equal(f.name, "GLM-5.4");
    assert.equal(f.problem, null);
    assert.equal(avatarModelChipText(f), "跟会话栏 · GLM-5.4");
  });

  it("显示名用白名单的名字，不写型号 id", () => {
    assert.equal(face({ choice: "sub_session" }).name, "Kimi K2.8 Preview");
    assert.equal(face({ choice: { providerId: "kimi-coding", modelId: "k3.1-pro" } }).name, "Kimi K3.1 Pro");
  });

  it("选「子会话模型」：胶囊写「子会话模型 · Kimi K2.8 Preview」", () => {
    const f = face({ choice: "sub_session" });
    assert.deepEqual(f.pair, KIMI_CODE);
    assert.equal(avatarModelChipText(f), "子会话模型 · Kimi K2.8 Preview");
  });

  it("挑了具体型号：胶囊只写型号名（取法那一截不写）", () => {
    const f = face({ choice: { providerId: "kimi-coding", modelId: "k3.1-pro" } });
    assert.equal(f.sourceLabel, null);
    assert.equal(avatarModelChipText(f), "Kimi K3.1 Pro");
  });

  it("会话栏没有模型、也没挑：写「没有可用模型」，pair 为 null（请求里就不带型号）", () => {
    const f = face({ session: undefined });
    assert.equal(f.pair, null);
    assert.equal(f.sourceLabel, null);
    assert.equal(avatarModelChipText(f), zh.galaxyDesigner.avatar.modelNone);
    assert.match(f.hint, /输入框/);
  });

  it("型号此刻用不了（服务商关了 / 型号没了 / 服务商删了）：原因照实写清是哪一家、怎么办，型号不换", () => {
    const off = face({ session: KIMI_CODE, providers: [provider("zhipu-coding", "智谱 Coding Plan", ["glm-5.4"]), provider("kimi-coding", "Kimi Code", ["kimi-for-coding"], true)] });
    assert.deepEqual(off.pair, KIMI_CODE);
    assert.match(off.problem ?? "", /Kimi Code/);
    assert.match(off.problem ?? "", /已关闭/);
    assert.match(off.problem ?? "", /模型服务/);
    const gone = face({ session: { providerId: "kimi-coding", modelId: "k2.7" } });
    assert.match(gone.problem ?? "", /k2\.7/);
    const removed = face({ session: KIMI_CODE, providers: [provider("zhipu-coding", "智谱 Coding Plan", ["glm-5.4"])] });
    assert.match(removed.problem ?? "", /已被删除/);
  });

  it("选了「子会话模型」但那家被关：退回会话栏的型号（同原子会话的退回），悬停说明写明是退回", () => {
    const f = face({ choice: "sub_session", providers: [provider("zhipu-coding", "智谱 Coding Plan", ["glm-5.4"]), provider("kimi-coding", "Kimi Code", ["kimi-for-coding"], true)] });
    assert.deepEqual(f.pair, GLM);
    assert.equal(avatarModelChipText(f), "跟会话栏 · GLM-5.4");
    assert.equal(f.fellBack, true);
    assert.equal(f.hint, zh.galaxyDesigner.avatar.modelSubSessionFallback);
    assert.equal(f.problem, null);
    // 没退回时不带这句
    assert.equal(face({ choice: "sub_session" }).fellBack, false);
    assert.equal(face().fellBack, false);
  });

  it("英文界面同一套：Same as session · GLM-5.4 / Sub-session model · Kimi K2.8 Preview", () => {
    const base = { session: GLM, settings, providers: providers(), catalog: [] };
    assert.equal(avatarModelChipText(avatarModelFace({ ...base, choice: undefined, t: en })), "Same as session · GLM-5.4");
    assert.equal(avatarModelChipText(avatarModelFace({ ...base, choice: "sub_session", t: en })), "Sub-session model · Kimi K2.8 Preview");
    assert.equal(avatarModelChipText(avatarModelFace({ ...base, choice: { providerId: "kimi-coding", modelId: "k3.1-pro" }, t: en })), "Kimi K3.1 Pro");
  });

  it("声明里有用户起的名字时用它（显示名与模型菜单同一口径）", () => {
    const named = [provider("zhipu-coding", "智谱 Coding Plan", ["glm-5.4"])];
    (named[0] as ProviderDto).models.declared[0] = { id: "glm-5.4", name: "主力" };
    assert.equal(face({ providers: named }).name, "主力");
  });
});
