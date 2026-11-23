import { useSyncExternalStore } from "react";
import { avatarVariantOf, mergeVariants, wsTitleVariantOf, type ProtoVariants } from "./proto-variants.ts";

/** 候选版式的运行时状态（见 proto-variants.ts）：初值读地址，之后用 window.orbitaProto.set 切 */
let current: ProtoVariants = { title: wsTitleVariantOf(window.location.search), avatar: avatarVariantOf(window.location.search) };
const listeners = new Set<() => void>();

export function getProtoVariants(): ProtoVariants {
  return current;
}

export function setProtoVariants(patch: Partial<Record<keyof ProtoVariants, unknown>>): ProtoVariants {
  const next = mergeVariants(current, patch);
  if (next.title === current.title && next.avatar === current.avatar) return current;
  current = next;
  for (const listener of listeners) listener();
  return current;
}

export function subscribeProtoVariants(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useProtoVariants(): ProtoVariants {
  return useSyncExternalStore(subscribeProtoVariants, getProtoVariants);
}

Object.assign(window, { orbitaProto: { get: getProtoVariants, set: setProtoVariants } });
