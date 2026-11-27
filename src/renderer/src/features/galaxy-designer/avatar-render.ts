/**
 * 「用生图工具」开关旁边的文字（纯函数，node --test 可直测）：什么时候在开关下面补一行说明、写什么。
 *
 * 开关只有两档（手绘 / 用生图工具），真源却是插件的策略文件——那里的档更多。面板自己的两档不解释；
 * 其余情况（插件没装、文件读不出来、旧档、每次都问、自定义）各补一句，原则是**不丢信息、不去改用户的文件**。
 */
import type { AvatarRenderPolicy, AvatarRenderPolicyResult } from "@shared/planet-avatar";
import type { Messages } from "../../messages-en.ts";

/** 开关下面那行说明；不需要说明时为 null */
export function avatarRenderNote(result: AvatarRenderPolicyResult | null, t: Messages): string | null {
  const ta = t.galaxyDesigner.avatar;
  if (result === null) return null;
  if (!result.ok) return ta.renderUnavailable(result.error);
  return avatarRenderPolicyNote(result.policy, t);
}

export function avatarRenderPolicyNote(policy: AvatarRenderPolicy, t: Messages): string | null {
  const ta = t.galaxyDesigner.avatar;
  if (policy.problem !== null) return ta.renderPolicyBroken(policy.problem);
  switch (policy.preset) {
    case "image_first":
      return ta.renderPresetImageFirst;
    case "ask":
      return ta.renderPresetAsk;
    case "custom":
      return ta.renderPresetCustom(policy.candidates.map((backend) => ta.backend[backend as keyof typeof ta.backend] ?? backend).join(" / "));
    default:
      return null;
  }
}

/** 开关的悬停名：这一档是什么 */
export function avatarRenderSwitchTitle(on: boolean, t: Messages): string {
  return on ? t.galaxyDesigner.avatar.renderSwitchOn : t.galaxyDesigner.avatar.renderSwitchOff;
}

/**
 * 插件账本的说明（这一轮为什么手绘了、为什么换了后端）：原话照实显示，只把「候选 N：」前缀去掉后一样的并成一句——
 * 开关开着却没找到生图工具时，两个候选位各写一遍同一句话。
 */
export function avatarNotes(notes: readonly string[]): string[] {
  const out: string[] = [];
  for (const note of notes) {
    const line = note.replace(/^候选\s*\d+\s*[:：]\s*/, "").trim();
    if (line !== "" && !out.includes(line)) out.push(line);
  }
  return out;
}
