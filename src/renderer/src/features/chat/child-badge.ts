/**
 * 子会话头像的角标（纯推导，TurnAvatar.tsx 用）：同一个模型的几个子会话靠角标分开。
 */

/** 子会话的头像身份：模型 + 它在父会话下的序号（1 起，按创建先后）+ 标题首字，给角标用 */
export interface ChildIdentity {
  providerId: string | null;
  modelId: string;
  ordinal: number;
  title: string;
}

/** 角标用的首字（标题的第一个非空白字符，大写）；标题空 = 序号 */
export function badgeInitial(title: string, ordinal: number): string {
  const first = [...title.trim()][0];
  return first === undefined ? String(ordinal) : first.toUpperCase();
}

/** 色环的序号档：只用非语义的几个 token（不占 danger / warning 的含义） */
export const RING_TONES = ["info", "success", "accent", "text-secondary"] as const;
export function ringTone(ordinal: number): (typeof RING_TONES)[number] {
  return RING_TONES[Math.max(0, ordinal - 1) % RING_TONES.length] ?? "info";
}

