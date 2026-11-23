import { useCallback, useSyncExternalStore } from "react";
import { getProtoVariants, subscribeProtoVariants, useProtoVariants } from "../chat/proto-variants-store.ts";
import { createDesignStore, designLevelOf, type GalaxyDesign } from "./design.ts";

/**
 * 全应用一份的星系设计稿仓库（原型：只活在这次运行的内存里，尚未写入配置）。
 * 三个消费者读同一份：星系设计面板（写）、侧栏工作区行的主星头像、工作区 New Task 页的星系（读）——
 * 面板里一改，头像与页面星系同一帧跟着变。
 * 页面地址在一次加载里不变：`?designer=bare|full` 定 fixture 档，模块加载时建一次。
 */
/** 头像候选（原型，等用户挑；见 chat/proto-variants.ts）：seeded = 没设计过的工作区按 id 取种子稿，same = 全部同一颗默认主星 */
export const avatarSeeded = (): boolean => getProtoVariants().avatar === "seeded";

export const galaxyDesigns = createDesignStore(designLevelOf(window.location.search), { seeded: avatarSeeded });
// 候选切换时丢掉缓存的默认稿，侧栏头像与页面星系同一帧重画
subscribeProtoVariants(() => galaxyDesigns.refresh());

/** 某个工作区的设计稿与「改没改过」；没改过时是默认稿（主星质量 620、只开眼睛），不随机 */
/** 头像要不要随质量放大放小（只在种子默认下开） */
export function useAvatarBySize(): boolean {
  return useProtoVariants().avatar === "seeded";
}

export function useGalaxyDesign(workspaceId: string): { design: GalaxyDesign; edited: boolean } {
  const design = useSyncExternalStore(
    galaxyDesigns.subscribe,
    useCallback(() => galaxyDesigns.get(workspaceId), [workspaceId]),
  );
  return { design, edited: galaxyDesigns.has(workspaceId) };
}
