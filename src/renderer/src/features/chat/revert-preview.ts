/**
 * 回退 / 撤销的预演对象（形态 D）——对话流、轮尾卡、底部确认栏三处共读。
 * 单独一个模块：轮尾卡与确认栏互相 import 会成环。
 */
import { createContext } from "react";
import type { RevertPlan, UndoPlan } from "@shared/revert";

/** 正在预演的对象。null = 没有预演。 */
export type RevertPreview = { kind: "revert"; messageId: string } | { kind: "undo"; turnId: string } | null;

/** 轮尾卡读它判断自己是不是被预演撤销的那一轮（免得穿过 memo 层层透传一个 prop）。 */
export const RevertPreviewContext = createContext<RevertPreview>(null);

export type PreviewEffect = "restore" | "delete" | "yours" | "later" | "stuck";

export interface ChipItem {
  path: string;
  effect: PreviewEffect;
}

/** 计划 → 胶囊：每个路径只出现一次，按「会伤到你的」在前排。 */
export function chipsOf(plan: RevertPlan | UndoPlan): ChipItem[] {
  const yours = new Set(plan.userModified);
  const later = new Set("laterTouched" in plan ? plan.laterTouched : []);
  const out: ChipItem[] = [];
  for (const path of plan.userModified) out.push({ path, effect: "yours" });
  for (const path of later) if (!yours.has(path)) out.push({ path, effect: "later" });
  const flagged = (path: string) => yours.has(path) || later.has(path);
  for (const path of plan.deletes) if (!flagged(path)) out.push({ path, effect: "delete" });
  for (const path of plan.restore) if (!flagged(path)) out.push({ path, effect: "restore" });
  for (const path of plan.unrecoverable) out.push({ path, effect: "stuck" });
  return out;
}

