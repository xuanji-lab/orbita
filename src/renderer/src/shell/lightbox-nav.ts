/**
 * 看大图的按键 → 动作。抽成纯函数是为了把边界说死：到头**不回绕**——
 * 回绕时「再按一下右键回到第一张」看起来像图没换，用户会以为键失灵了。
 */
export type LightboxAction = { kind: "close" } | { kind: "show"; index: number } | null;

export function lightboxKey(key: string, index: number, count: number): LightboxAction {
  if (key === "Escape") return { kind: "close" };
  if (key === "ArrowLeft" && index > 0) return { kind: "show", index: index - 1 };
  if (key === "ArrowRight" && index < count - 1) return { kind: "show", index: index + 1 };
  return null;
}
