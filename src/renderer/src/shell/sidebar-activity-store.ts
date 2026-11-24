import { useSyncExternalStore } from "react";
import { getProtoVariants, setProtoVariants } from "../features/chat/proto-variants-store.ts";
import type { ProtoVariants } from "../features/chat/proto-variants.ts";
import { activityVariantOf, subAgentFixturesOf, type ActivityVariant, type SubAgentFixtures } from "./sidebar-activity.ts";

/**
 * 侧栏「谁在干活」候选的运行时状态（见 sidebar-activity.ts）。不改 proto-variants 那两份共用文件（另一条线也在改），
 * 在这里把 window.orbitaProto 包一层：set 先交给原来的，再认自己的两个键——
 *   window.orbitaProto.set({ sidebarActivity: "a" })                         // "a" | "b" | "c" | "off"（缺省 off = 现状）
 *   window.orbitaProto.set({ subAgents: { orbita: [{ planet: 0, state: "working" }] } })   // 演示数据：哪座星系的第几颗行星在干活
 * 初值也可以从地址读 `?sidebarActivity=b`。
 */
export interface SidebarActivityState {
  variant: ActivityVariant;
  subAgents: SubAgentFixtures;
}

let current: SidebarActivityState = {
  variant: activityVariantOf(new URLSearchParams(window.location.search).get("sidebarActivity")) ?? "off",
  subAgents: {},
};
const listeners = new Set<() => void>();

export function getSidebarActivity(): SidebarActivityState {
  return current;
}

export function setSidebarActivity(patch: Readonly<Record<string, unknown>>): SidebarActivityState {
  const variant = activityVariantOf(patch.sidebarActivity) ?? current.variant;
  const subAgents = subAgentFixturesOf(patch.subAgents) ?? current.subAgents;
  if (variant === current.variant && subAgents === current.subAgents) return current;
  current = { variant, subAgents };
  for (const listener of listeners) listener();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSidebarActivity(): SidebarActivityState {
  return useSyncExternalStore(subscribe, getSidebarActivity);
}

Object.assign(window, {
  orbitaProto: {
    get: (): ProtoVariants & SidebarActivityState => ({ ...getProtoVariants(), ...current }),
    set: (patch: Readonly<Record<string, unknown>>): ProtoVariants & SidebarActivityState => {
      const variants = setProtoVariants(patch);
      return { ...variants, ...setSidebarActivity(patch) };
    },
  },
});
