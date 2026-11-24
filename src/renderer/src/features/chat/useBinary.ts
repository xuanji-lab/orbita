import type { Workspace } from "@shared/workspace";
import type { GalaxyDesign } from "../galaxy-designer/design.ts";
import { useGalaxyDesign } from "../galaxy-designer/useGalaxyDesign.ts";

/**
 * 这个工作区的伴星（Workspace.binaryWith）：伴星工作区的 id、名字、主星设计稿，交给 HomeGalaxy 的 binary。
 * 没有伴星、或伴星工作区已经不在列表里时为 null。设计稿走同一个仓库：伴星那边改了主星，这边同一帧跟着变。
 */
export function useBinaryOf(workspaceId: string | null, workspaces: readonly Workspace[]): { workspaceId: string; name: string; design: GalaxyDesign } | null {
  const partnerId = workspaceId === null ? undefined : workspaces.find((workspace) => workspace.id === workspaceId)?.binaryWith;
  const partner = partnerId === undefined ? undefined : workspaces.find((workspace) => workspace.id === partnerId);
  // hook 无条件调用：没有伴星时读一个空 id（回退稿，不用）
  const { design } = useGalaxyDesign(partner?.id ?? "");
  return partner === undefined ? null : { workspaceId: partner.id, name: partner.name, design };
}
