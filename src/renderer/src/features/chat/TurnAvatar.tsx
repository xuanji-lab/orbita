import { createContext, useContext } from "react";
import type { BuiltinProvider } from "@shared/agent-ipc";
import { modelDisplayName } from "@shared/model-defaults";
import type { ProviderDto } from "@shared/provider";
import { Icon } from "../../shell/Icon";
import { NebulaPet } from "../../shell/UsageMeter";
import { modelAvatarFor } from "../settings/model-menu";
import { badgeInitial, ringTone, type ChildIdentity } from "./child-badge.ts";

/**
 * 对话里「谁在说话」的标记（2026-11-22，试方案 B，待用户定）：
 * - 主会话每一轮 agent 开头左边是**我们自己的星云**（TurnPet，侧栏左下角那只的缩小静止版）——用产品自己的角色当说话人，
 *   不是模型头像（用户看了模型头像的截图不好看：灰色书法位图在小尺寸下是一团灰）。落定静止，跑着的那一轮才有最轻的动静（只有它自己呼吸与碎片慢转）；
 * - 子会话卡（派出卡 / 交回卡）才用它所用模型的头像 + 同模型角标（ChildAvatar），或者模型名文字标签（ChildModelLabel）。
 */

/** 子会话头像的像素大小（= --control-height-sm 的 28） */
export const TURN_AVATAR_SIZE = 28;

export interface ModelIdentity {
  providers: readonly ProviderDto[];
  /** pi 内建目录：模型显示名（子会话卡上的文字标签）按它查 */
  catalog: readonly BuiltinProvider[];
  /** 当前这条会话自己的模型（子会话视图顶上的「XX 的子会话」用它）；还没选 null */
  current: { providerId: string; modelId: string } | null;
}

export const ModelIdentityContext = createContext<ModelIdentity>({ providers: [], catalog: [], current: null });

/**
 * 主会话每一轮开头的星云：NebulaPet（tier 3，睁眼）缩到头像槽大小。`live` = 这一轮正在跑：
 * 呼吸 + 碎片慢转；落定是静止的（一整列静止星云不吵）。
 */
export function TurnPet(props: { live: boolean }) {
  return (
    <span className="turn-avatar turn-pet" data-still={props.live ? undefined : true} aria-hidden="true">
      <span className="turn-pet-scale">
        <NebulaPet tier={3} orbit={props.live} fast={false} />
      </span>
    </span>
  );
}

/** 子会话头像（头像用）：模型头像 */
export function TurnAvatar(props: { providerId: string | null; modelId: string }) {
  const { providers } = useContext(ModelIdentityContext);
  return (
    <span className="turn-avatar" title={props.modelId}>
      {modelAvatarFor(providers, props.providerId, props.modelId, TURN_AVATAR_SIZE)}
    </span>
  );
}

/**
 * 子会话在主流里的头像。三种方案都画出来，由 <html data-child-badge="initial|ring|label"> 切（样式里只显一种；缺省 initial）：
 *  ① initial：模型头像 + 右下角角标 = 子会话标题的首字；
 *  ② ring：模型头像外一圈颜色环（按序号取色）+ 角标 = 序号；
 *  ③ label：不用位图头像，卡左边是一枚机器人图标，卡标题后面跟模型名的文字小标签（ChildModelLabel）。
 * 选定后只留一种、删掉另外两种与这个开关。
 */
export function ChildAvatar(props: { child: ChildIdentity }) {
  const { providers } = useContext(ModelIdentityContext);
  const { child } = props;
  return (
    <span className="child-avatar" data-tone={ringTone(child.ordinal)} title={child.title}>
      {modelAvatarFor(providers, child.providerId, child.modelId, TURN_AVATAR_SIZE)}
      <span className="child-avatar-badge initial" aria-hidden="true">
        {badgeInitial(child.title, child.ordinal)}
      </span>
      <span className="child-avatar-badge ordinal" aria-hidden="true">
        {child.ordinal}
      </span>
      <span className="child-avatar-bot" aria-hidden="true">
        <Icon name="bot" size={18} strokeWidth={1.6} />
      </span>
    </span>
  );
}

/** 方案 ③：卡标题后面的模型名小标签（灰色小字，如「GLM-5.3」）；只在 data-child-badge="label" 时显示 */
export function ChildModelLabel(props: { child: ChildIdentity }) {
  const { catalog } = useContext(ModelIdentityContext);
  return <span className="child-model-label">{modelDisplayName(catalog, props.child.modelId, {}, undefined)}</span>;
}
