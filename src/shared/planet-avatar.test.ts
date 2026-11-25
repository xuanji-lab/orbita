import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { defaultThinkingLevel } from "./model-defaults.ts";
import type { ProviderDto } from "./provider.ts";
import {
  AVATAR_RENDER_PRESETS,
  avatarModelError,
  avatarPolicyNote,
  avatarRenderPolicyOf,
  checkAvatarModel,
  isAvatarGenerateRequest,
  isAvatarRenderMode,
  isAvatarRenderPolicySetRequest,
  isAvatarSelectRequest,
  isAvatarJobLive,
  pickAvatarModel,
  resolveAvatarModel,
  type AvatarJob,
} from "./planet-avatar.ts";
import { parseSessionMeta, rootSessions, type SessionMeta } from "./session.ts";

describe("planet-avatar 契约", () => {
  it("生成请求：主星 / 行星 id 都认，越界的 id 与超长名字不认", () => {
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "main" }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1a2b", name: "赭汐", mix: { seed: 1, items: [] } }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "../x" }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "", bodyId: "main" }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "main", name: "x".repeat(201) }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "再暖一点", baseCandidateId: "r2-s1" }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "  " }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "x".repeat(1001) }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "加一圈云", baseCandidateId: "../x" }), false);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", instruction: "再暖一点", useCurrentSurface: true }), true);
    assert.equal(isAvatarGenerateRequest({ workspaceId: "w", bodyId: "agent-1", useCurrentSurface: "yes" }), false);
  });

  it("挑选请求：候选 id 只认插件的 r<轮>-s<位>", () => {
    assert.equal(isAvatarSelectRequest({ workspaceId: "w", bodyId: "main", candidateId: "r2-s3" }), true);
    assert.equal(isAvatarSelectRequest({ workspaceId: "w", bodyId: "main", candidateId: "../../etc" }), false);
    assert.equal(isAvatarSelectRequest({ workspaceId: "w", bodyId: "main" }), false);
  });

  it("只有 preparing / running 算在出图", () => {
    const job = (state: AvatarJob["state"]): AvatarJob => ({
      workspaceId: "w", bodyId: "main", state, round: null, slots: [], notes: [], policy: null, model: null, sessionId: null, selected: null, error: null, startedAt: 0, finishedAt: null,
    });
    assert.equal(isAvatarJobLive(job("preparing")), true);
    assert.equal(isAvatarJobLive(job("running")), true);
    assert.equal(isAvatarJobLive(job("ready")), false);
    assert.equal(isAvatarJobLive(null), false);
  });

  it("幕后会话：meta 读得回 backstage，根会话列表不列它", () => {
    const raw = { id: "s1", cwd: "/w", providerId: "p", modelId: "m", createdAt: 1, backstage: "avatar" };
    const meta = parseSessionMeta(raw) as SessionMeta;
    assert.equal(meta.backstage, "avatar");
    assert.deepEqual(rootSessions([meta]), []);
    const plain = parseSessionMeta({ ...raw, id: "s2", backstage: "other" }) as SessionMeta;
    assert.equal(plain.backstage, undefined);
    assert.equal(rootSessions([plain]).length, 1);
  });
});

/**
 * 出图用哪个模型：取法 → 型号 → 校验这一段是面板与主进程共用的纯函数，所以和契约一起测。
 * 夹具照用户正式版的情形摆：子会话默认模型是 Kimi Code 的 kimi-for-coding，会话栏用的是智谱的 glm-5.4——
 * 2026-11-25 就是在这个设置下，会话栏怎么换模型出图都是 Kimi。
 */
function modelProvider(id: string, displayName: string, modelIds: string[], disabled = false): ProviderDto {
  return {
    id,
    displayName,
    disabled,
    endpoint: { baseUrl: "https://x.example", api: "anthropic-messages" },
    auth: { scheme: "api_key", hasSecret: true, masked: "abc…xyz" },
    models: { declared: modelIds.map((modelId) => ({ id: modelId })) },
  };
}

const ZHIPU = "zhipu-coding";
const KIMI = "kimi-coding";
const GLM = { providerId: ZHIPU, modelId: "glm-5.4" };
const KIMI_CODE = { providerId: KIMI, modelId: "kimi-for-coding" };

function modelProviders(withKimi = true): ProviderDto[] {
  const list = [modelProvider(ZHIPU, "智谱 Coding Plan", ["glm-5.4", "glm-5.3-flash"])];
  if (withKimi) list.push(modelProvider(KIMI, "Kimi Code", ["kimi-for-coding", "k3.1-pro"]));
  return list;
}

/** Kimi 那家被关了，智谱照常 */
function kimiOff(): ProviderDto[] {
  return [modelProvider(ZHIPU, "智谱 Coding Plan", ["glm-5.4", "glm-5.3-flash"]), modelProvider(KIMI, "Kimi Code", ["kimi-for-coding", "k3.1-pro"], true)];
}

/** 用户正式版设置的那一段：子会话默认模型压在会话栏模型上面 */
const userSettings = { subSessionModel: KIMI_CODE };

const resolve = (input: Partial<Parameters<typeof resolveAvatarModel>[0]> = {}) =>
  resolveAvatarModel({
    requested: undefined,
    session: GLM,
    settings: { avatarModel: undefined, ...userSettings },
    providers: modelProviders(),
    ...input,
  });
/** 解析失败时的那句错误（成功就是测试写错了） */
function failure(result: ReturnType<typeof resolveAvatarModel>): string {
  if (result.ok) assert.fail(`expected a failure, got ${result.providerId}/${result.modelId}`);
  return result.error;
}

describe("pickAvatarModel：取法落到哪个型号（只挑不校验）", () => {
  it("没选过 = 跟会话栏：取会话栏此刻的模型，不被子会话默认模型压住", () => {
    assert.deepEqual(pickAvatarModel(undefined, GLM, userSettings, modelProviders()), { ...GLM, source: "session" });
  });

  it("会话栏没有模型时挑不出（回 null），不拿别家的型号顶上", () => {
    assert.equal(pickAvatarModel(undefined, undefined, userSettings, modelProviders()), null);
  });

  it("选「子会话模型」= 走原链路：设置里的子会话默认模型", () => {
    assert.deepEqual(pickAvatarModel("sub_session", GLM, userSettings, modelProviders()), { ...KIMI_CODE, source: "sub_session_model" });
  });

  it("「子会话模型」在服务商被关 / 被删、或根本没设时，退回会话栏的模型（同原子会话的退回）", () => {
    assert.deepEqual(pickAvatarModel("sub_session", GLM, userSettings, kimiOff()), { ...GLM, source: "session" });
    assert.deepEqual(pickAvatarModel("sub_session", GLM, userSettings, modelProviders(false)), { ...GLM, source: "session" });
    assert.deepEqual(pickAvatarModel("sub_session", GLM, {}, modelProviders()), { ...GLM, source: "session" });
  });

  it("选了具体型号就用它，原样返回——服务商被关了也不在这里换（留给校验报错）", () => {
    const picked = { providerId: KIMI, modelId: "k3.1-pro" };
    assert.deepEqual(pickAvatarModel(picked, GLM, userSettings, modelProviders(false)), { ...picked, source: "picked" });
  });
});

describe("checkAvatarModel：这个型号此刻能不能用", () => {
  it("服务商开着、型号还声明着：能用", () => {
    assert.deepEqual(checkAvatarModel(KIMI_CODE, modelProviders()), { ok: true });
  });

  it("服务商被关：报原因，带上服务商的显示名", () => {
    assert.deepEqual(checkAvatarModel(KIMI_CODE, kimiOff()), {
      ok: false,
      reason: { kind: "provider_off", providerId: KIMI, modelId: "kimi-for-coding", providerName: "Kimi Code" },
    });
  });

  it("型号从服务商的模型列表里没了：报原因", () => {
    assert.deepEqual(checkAvatarModel({ providerId: KIMI, modelId: "k2.7" }, modelProviders()), {
      ok: false,
      reason: { kind: "model_gone", providerId: KIMI, modelId: "k2.7", providerName: "Kimi Code" },
    });
  });

  it("服务商被删：报原因，显示名为 null", () => {
    assert.deepEqual(checkAvatarModel(KIMI_CODE, modelProviders(false)), {
      ok: false,
      reason: { kind: "provider_gone", providerId: KIMI, modelId: "kimi-for-coding", providerName: null },
    });
  });

  it("主进程的错误句说清是哪一种、怎么办", () => {
    const off = avatarModelError({ kind: "provider_off", providerId: KIMI, modelId: "kimi-for-coding", providerName: "Kimi Code" });
    assert.match(off, /Kimi Code/);
    assert.match(off, /已关闭/);
    assert.match(off, /模型服务/);
    assert.match(avatarModelError({ kind: "model_gone", providerId: KIMI, modelId: "k2.7", providerName: "Kimi Code" }), /kimi-coding\/k2\.7/);
    assert.match(avatarModelError({ kind: "provider_gone", providerId: KIMI, modelId: "kimi-for-coding", providerName: null }), /已被删除/);
  });
});

describe("resolveAvatarModel：主进程开这一轮用的模型", () => {
  it("默认跟会话栏：子会话默认模型压不过它，思考档取该型号的默认档", () => {
    assert.deepEqual(resolve(), { ok: true, ...GLM, source: "session", thinkingLevel: defaultThinkingLevel("glm-5.4") });
  });

  it("选「子会话模型」：用子会话默认模型，思考档沿子会话的设置", () => {
    const r = resolve({ settings: { avatarModel: "sub_session", subSessionModel: KIMI_CODE, subSessionThinking: "high" } });
    assert.deepEqual(r, { ok: true, ...KIMI_CODE, source: "sub_session_model", thinkingLevel: "high" });
    // 没单独设档 = 那个型号的默认档
    const unset = resolve({ settings: { avatarModel: "sub_session", ...userSettings } });
    assert.equal(unset.ok && unset.thinkingLevel, defaultThinkingLevel("kimi-for-coding"));
  });

  it("「子会话模型」退回会话栏时，思考档不再认子会话那一档", () => {
    const r = resolve({ providers: kimiOff(), settings: { avatarModel: "sub_session", subSessionModel: KIMI_CODE, subSessionThinking: "high" } });
    assert.deepEqual(r, { ok: true, ...GLM, source: "session", thinkingLevel: defaultThinkingLevel("glm-5.4") });
  });

  it("选了具体型号：用它，思考档取它的默认档", () => {
    const r = resolve({ settings: { avatarModel: { providerId: KIMI, modelId: "k3.1-pro" }, ...userSettings } });
    assert.deepEqual(r, { ok: true, providerId: KIMI, modelId: "k3.1-pro", source: "picked", thinkingLevel: defaultThinkingLevel("k3.1-pro") });
  });

  it("会话栏的模型不可用（服务商关了 / 型号没了 / 服务商删了）：报错说清怎么办，不静默换成别家", () => {
    const off = resolve({ session: KIMI_CODE, providers: kimiOff() });
    const offError = failure(off);
    assert.match(offError, /Kimi Code/);
    assert.match(offError, /已关闭/);
    // 报错里不许出现别家型号
    assert.doesNotMatch(offError, /glm/);

    const gone = resolve({ session: { providerId: KIMI, modelId: "k2.7" } });
    assert.match(failure(gone), /kimi-coding\/k2\.7/);

    const removed = resolve({ session: KIMI_CODE, providers: modelProviders(false) });
    assert.match(failure(removed), /已被删除/);
  });

  it("选了具体型号但它已不可用：同样报错不换", () => {
    const r = resolve({ settings: { avatarModel: KIMI_CODE, ...userSettings }, providers: modelProviders(false) });
    assert.match(failure(r), /已被删除/);
  });

  it("挑不出任何模型（会话栏没有、也没选）：报错引导去选", () => {
    const r = resolve({ session: undefined });
    assert.match(failure(r), /选一个模型/);
  });

  it("请求里带了型号就以请求为准，设置里的取法管不着它", () => {
    const r = resolve({ requested: { providerId: KIMI, modelId: "k3.1-pro" }, settings: { avatarModel: "sub_session", ...userSettings } });
    assert.deepEqual(r, { ok: true, providerId: KIMI, modelId: "k3.1-pro", source: "picked", thinkingLevel: defaultThinkingLevel("k3.1-pro") });
  });

  it("请求带的型号正好是子会话默认模型：思考档沿子会话的设置（同一个型号同一档）", () => {
    const r = resolve({ requested: KIMI_CODE, settings: { avatarModel: "sub_session", subSessionModel: KIMI_CODE, subSessionThinking: "high" } });
    assert.equal(r.ok && r.thinkingLevel, "high");
  });

  it("请求带的型号不可用：报错不换，也不回头看设置里别的取法", () => {
    const r = resolve({ requested: KIMI_CODE, providers: modelProviders(false), settings: { avatarModel: GLM, ...userSettings } });
    assert.match(failure(r), /已被删除/);
  });
});

describe("生成请求的 model 字段：面板解析好的具体型号，成对才认", () => {
  const base = { workspaceId: "w", bodyId: "main" };
  it("不带 model 照旧通过；带成对的 providerId + modelId 通过", () => {
    assert.equal(isAvatarGenerateRequest(base), true);
    assert.equal(isAvatarGenerateRequest({ ...base, model: GLM }), true);
  });
  it("半截的、空字符串的、不是对象的都拒绝", () => {
    assert.equal(isAvatarGenerateRequest({ ...base, model: { providerId: ZHIPU } }), false);
    assert.equal(isAvatarGenerateRequest({ ...base, model: { providerId: ZHIPU, modelId: "" } }), false);
    assert.equal(isAvatarGenerateRequest({ ...base, model: { providerId: "", modelId: "glm-5.4" } }), false);
    assert.equal(isAvatarGenerateRequest({ ...base, model: "glm-5.4" }), false);
    assert.equal(isAvatarGenerateRequest({ ...base, model: null }), false);
  });
});

/** 插件 `policy` 读命令的输出（render_surface.py 的 cmd_policy） */
function scriptPolicy(policy: unknown): unknown {
  return { ok: true, path: "/plugin/data/render-policy.json", policy, presets: {} };
}
const SVG_POLICY = {
  version: 1,
  preset: "svg",
  label: "只让智能体画 SVG，不调任何外部服务",
  candidates: ["model_svg", "model_svg"],
  imageModel: { prefer: [], avoid: [] },
  maxAttempts: { model_svg: 3, image_model: 2, user_image: 1 },
  decidedBy: "user",
  decidedAt: "2026-11-24T21:00:00+08:00",
  note: "",
};

describe("avatarRenderPolicyOf：「用生图工具」开关的状态（输入是插件 policy 读命令的输出）", () => {
  it("开关只有两档，各对应插件策略的一个预设：关 = svg（手绘），开 = image_only", () => {
    assert.deepEqual(AVATAR_RENDER_PRESETS, { hand_drawn: "svg", image_tool: "image_only" });
    assert.equal(isAvatarRenderMode("image_tool"), true);
    assert.equal(isAvatarRenderMode("hand_drawn"), true);
    assert.equal(isAvatarRenderMode("image_first"), false);
  });

  it("策略文件还没有（脚本按默认回、decided=false）：开关是关，标成还没定", () => {
    const p = avatarRenderPolicyOf(scriptPolicy({ ...SVG_POLICY, decidedBy: "default", decidedAt: null, decided: false }));
    assert.equal(p.mode, "hand_drawn");
    assert.equal(p.preset, "svg");
    assert.equal(p.decided, false);
    assert.equal(p.problem, null);
    assert.equal(p.label, "只让智能体画 SVG，不调任何外部服务");
  });

  it("svg = 关；image_only = 开", () => {
    assert.equal(avatarRenderPolicyOf(scriptPolicy(SVG_POLICY)).mode, "hand_drawn");
    assert.equal(avatarRenderPolicyOf(scriptPolicy(SVG_POLICY)).decided, true);
    const on = avatarRenderPolicyOf(scriptPolicy({ ...SVG_POLICY, preset: "image_only", candidates: ["image_model", "image_model"] }));
    assert.equal(on.mode, "image_tool");
    assert.equal(on.preset, "image_only");
  });

  it("旧的 image_first（图像 2 张 + 手绘 1 张）读出来当「开」；界面里不再有这一档，一拨开关才换成新档", () => {
    const p = avatarRenderPolicyOf(scriptPolicy({ ...SVG_POLICY, preset: "image_first", candidates: ["image_model", "image_model", "model_svg"] }));
    assert.equal(p.mode, "image_tool");
    assert.equal(p.preset, "image_first");
  });

  it("ask：按手绘显示（面板出图不会停下来问），原则的原话照实留着不丢", () => {
    const p = avatarRenderPolicyOf(scriptPolicy({ ...SVG_POLICY, preset: "ask", label: "每次出图前都问我用哪种" }));
    assert.equal(p.mode, "hand_drawn");
    assert.equal(p.preset, "ask");
    assert.equal(p.label, "每次出图前都问我用哪种");
  });

  it("custom：候选位里有生图工具才算开；候选位与备注原样带着", () => {
    const withImage = avatarRenderPolicyOf(scriptPolicy({ ...SVG_POLICY, preset: "custom", label: "自定义", candidates: ["image_model", "model_svg"], note: "一张图一张手绘" }));
    assert.equal(withImage.mode, "image_tool");
    assert.deepEqual(withImage.candidates, ["image_model", "model_svg"]);
    assert.equal(withImage.note, "一张图一张手绘");
    const svgOnly = avatarRenderPolicyOf(scriptPolicy({ ...SVG_POLICY, preset: "custom", label: "自定义", candidates: ["model_svg"] }));
    assert.equal(svgOnly.mode, "hand_drawn");
  });

  it("文件坏了（脚本回 ok:false + 原因）：按手绘显示、把原因带上——不改用户的文件", () => {
    const p = avatarRenderPolicyOf({ ok: false, message: "render-policy.json 不是合法 JSON：Expecting value" });
    assert.equal(p.mode, "hand_drawn");
    assert.equal(p.preset, null);
    assert.equal(p.problem, "render-policy.json 不是合法 JSON：Expecting value");
  });

  it("插件没说出一句有用的话（不是对象、没有 ok、没有预设）：也回一句原因，不抛", () => {
    assert.equal(avatarRenderPolicyOf("Traceback ...").problem !== null, true);
    assert.equal(avatarRenderPolicyOf({}).problem !== null, true);
    assert.equal(avatarRenderPolicyOf(scriptPolicy({ label: "没有预设" })).problem !== null, true);
  });
});

describe("avatarPolicyNote：面板改出图原则时写进备注的那一句", () => {
  const first = avatarPolicyNote("用户 2026-11-24：先按建议用", "2026-11-25 23:53", "改为 image_only（用生图工具）");
  it("用户自己写的备注留在前面，面板的记录缀在后面", () => {
    assert.equal(first, "用户 2026-11-24：先按建议用；2026-11-25 23:53 在 Orbita 的星系设计面板里改为 image_only（用生图工具）");
    assert.equal(avatarPolicyNote(null, "2026-11-25 23:53", "默认：只让智能体手绘"), "2026-11-25 23:53 在 Orbita 的星系设计面板里默认：只让智能体手绘");
  });
  it("拨过一次再拨：上一次面板的记录被换掉，不会拨一次长一截", () => {
    const twice = avatarPolicyNote(first, "2026-11-25 23:54", "改为 svg（只让智能体手绘）");
    assert.equal(twice, "用户 2026-11-24：先按建议用；2026-11-25 23:54 在 Orbita 的星系设计面板里改为 svg（只让智能体手绘）");
    const thrice = avatarPolicyNote(twice, "2026-11-25 23:55", "改为 image_only（用生图工具）");
    assert.equal(thrice.match(/在 Orbita 的星系设计面板里/g)?.length, 1);
    assert.match(thrice, /^用户 2026-11-24：先按建议用/);
  });
});

describe("isAvatarRenderPolicySetRequest：拨开关的入参只认两档", () => {
  it("{ mode } 且 mode 是两档之一才认", () => {
    assert.equal(isAvatarRenderPolicySetRequest({ mode: "image_tool" }), true);
    assert.equal(isAvatarRenderPolicySetRequest({ mode: "hand_drawn" }), true);
    assert.equal(isAvatarRenderPolicySetRequest({ mode: "image_first" }), false);
    assert.equal(isAvatarRenderPolicySetRequest({ mode: "svg" }), false);
    assert.equal(isAvatarRenderPolicySetRequest({}), false);
    assert.equal(isAvatarRenderPolicySetRequest("image_tool"), false);
    assert.equal(isAvatarRenderPolicySetRequest({ mode: "image_tool", preset: "../x" }), true);
  });
});
