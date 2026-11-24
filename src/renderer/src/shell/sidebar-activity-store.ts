import { useSyncExternalStore } from "react";
import { getProtoVariants, setProtoVariants } from "../features/chat/proto-variants-store.ts";
import type { ProtoVariants } from "../features/chat/proto-variants.ts";
import { subAgentFixtureEnabled, subAgentFixturesOf, type SubAgentFixtures } from "./sidebar-activity.ts";

/**
 * 侧栏「子智能体在干活」的演示数据（见 sidebar-activity.ts）。真实数据里会话与子智能体还没有归属关系，
 * 所以只有地址带 ?fixture=sub-agents 时才收数据，其余时候永远是空的——真实实例里不画子智能体小头像。
 * 不改 proto-variants 那两份共用文件，在这里把 window.orbitaProto 包一层：
 *   window.orbitaProto.set({ subAgents: { orbita: [{ planet: 0, state: "working" }] } })
 */
const enabled = subAgentFixtureEnabled(window.location.search);
const EMPTY: SubAgentFixtures = {};
let current: SubAgentFixtures = EMPTY;
const listeners = new Set<() => void>();

export function getSubAgentFixtures(): SubAgentFixtures {
  return current;
}

function setSubAgentFixtures(value: unknown): SubAgentFixtures {
  if (!enabled) return current;
  const next = subAgentFixturesOf(value);
  if (next === null) return current;
  current = next;
  for (const listener of listeners) listener();
  return current;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useSubAgentFixtures(): SubAgentFixtures {
  return useSyncExternalStore(subscribe, getSubAgentFixtures);
}

Object.assign(window, {
  orbitaProto: {
    get: (): ProtoVariants & { subAgents: SubAgentFixtures } => ({ ...getProtoVariants(), subAgents: current }),
    set: (patch: Readonly<Record<string, unknown>>): ProtoVariants & { subAgents: SubAgentFixtures } => {
      const variants = setProtoVariants(patch);
      return { ...variants, subAgents: patch.subAgents === undefined ? current : setSubAgentFixtures(patch.subAgents) };
    },
  },
});
