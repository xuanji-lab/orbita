/**
 * 形象一节那颗模型胶囊写什么（纯函数，node --test 可直测；头像与菜单在 AvatarSection.tsx 里画）。
 *
 * 胶囊在**点之前**就写明这一组会用哪个模型（2026-11-25 用户：在会话栏换了两次模型，出图两次都是
 * 子会话默认的那家，点了才发现）。它写的那一对 id 随请求发出去，主进程以请求为准——
 * 所以「取法 → 型号」这一步用 shared 的 pickAvatarModel，与主进程兜底时是同一份。
 */
import type { BuiltinProvider } from "@shared/agent-ipc";
import { modelDisplayName } from "../../../../shared/model-defaults.ts";
import { checkAvatarModel, pickAvatarModel, type AvatarModelPick } from "../../../../shared/planet-avatar.ts";
import type { ProviderDto } from "../../../../shared/provider.ts";
import type { AppSettings, AvatarModelChoice, ModelPair } from "../../../../shared/settings.ts";
import { modelPreferenceById } from "../settings/providers-view-model.ts";
import type { Messages } from "../../messages-en.ts";

/** 面板挑出图模型要用的东西：App 把主槽的模型、服务商、设置与星标递下来（面板不自己读盘、不另起通道） */
export interface AvatarModelSource {
  /** 全部服务商（含没填 key 的与关着的）：解析要认得出「已关闭」，模型菜单自己筛 */
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
  /** 会话栏（输入框）此刻的模型；没有可用模型为 null */
  composerModel: ModelPair | null;
  settings: Pick<AppSettings, "avatarModel" | "subSessionModel" | "lastUsed">;
  starredModels: readonly ModelPair[];
  onToggleStarModel: (pair: ModelPair) => void;
  /** 选了取法 / 型号（null = 选回默认「跟会话栏」）：走设置通道落盘，跨重启保留 */
  onChoiceChange: (choice: AvatarModelChoice | null) => void;
}

export interface AvatarModelFace {
  /** 此刻解析到的型号（随请求发出去的那一对）；一个都挑不出为 null */
  pair: ModelPair | null;
  /** 型号显示名，与模型菜单、输入卡同一口径；挑不出时是「没有可用模型」 */
  name: string;
  /** 胶囊上取法那一截（「跟会话栏」「子会话模型」）；挑了具体型号为 null——只写型号名 */
  sourceLabel: string | null;
  /** 悬停说明 */
  hint: string;
  /** 选的是「子会话模型」但退回了会话栏（那个模型的服务商被关 / 被删） */
  fellBack: boolean;
  /** 这个型号此刻用不了的原因；能用、或挑不出时为 null */
  problem: string | null;
}

function sourceLabel(source: AvatarModelPick["source"], t: Messages): string | null {
  const ta = t.galaxyDesigner.avatar;
  if (source === "sub_session_model") return t.settings.subSessionModel;
  return source === "session" ? ta.modelFollow : null;
}

/** 某个型号在面板上此刻的样子 */
export function avatarModelFace(input: {
  choice: AvatarModelChoice | undefined;
  /** 会话栏此刻的模型（主槽的；为 null 时调用方已退到 lastUsed） */
  session: ModelPair | undefined;
  settings: Pick<AppSettings, "subSessionModel">;
  providers: readonly ProviderDto[];
  catalog: readonly BuiltinProvider[];
  t: Messages;
}): AvatarModelFace {
  const ta = input.t.galaxyDesigner.avatar;
  const picked = pickAvatarModel(input.choice, input.session, input.settings, input.providers);
  if (picked === null) return { pair: null, name: ta.modelNone, sourceLabel: null, hint: ta.modelNoneHint, problem: null, fellBack: false };
  const provider = input.providers.find((item) => item.id === picked.providerId);
  const declared = provider?.models.declared.find((model) => model.id === picked.modelId);
  const name = modelDisplayName(
    input.catalog,
    picked.modelId,
    modelPreferenceById(input.providers, picked.providerId),
    declared?.name,
  );
  const label = sourceLabel(picked.source, input.t);
  // 选的是「子会话模型」却落回会话栏：设置里那个模型的服务商被关 / 被删了（原链路的退回）——悬停说明把缘由写出来，
  // 否则胶囊上的「跟会话栏」和菜单里打勾的「子会话模型」看起来像是选择没生效
  const fellBack = input.choice === "sub_session" && picked.source === "session";
  const hint = fellBack
    ? ta.modelSubSessionFallback
    : picked.source === "session"
      ? ta.modelFollowHint
      : picked.source === "sub_session_model"
        ? ta.modelSubSessionHint
        : ta.modelPickedHint;
  const check = checkAvatarModel(picked, input.providers);
  let problem: string | null = null;
  if (!check.ok) {
    const reason = check.reason;
    problem =
      reason.kind === "provider_off"
        ? ta.modelOff(reason.providerName ?? reason.providerId, name)
        : reason.kind === "model_gone"
          ? ta.modelGone(name)
          : ta.modelRemoved(name);
  }
  return { pair: { providerId: picked.providerId, modelId: picked.modelId }, name, sourceLabel: label, hint, problem, fellBack };
}

/** 胶囊上的字：「取法 · 型号名」；挑了具体型号只写型号名 */
export function avatarModelChipText(face: AvatarModelFace): string {
  return face.sourceLabel === null ? face.name : `${face.sourceLabel} · ${face.name}`;
}
