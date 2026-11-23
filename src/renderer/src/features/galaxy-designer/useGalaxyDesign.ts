import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { Workspace } from "@shared/workspace";
import { api } from "../../api";
import { getProtoVariants, subscribeProtoVariants, useProtoVariants } from "../chat/proto-variants-store.ts";
import { createDesignStore, designFromPlanets, designLevelOf, planetsWriteOf, writableDesign, type DesignOrigin, type GalaxyDesign } from "./design.ts";

/**
 * 全应用一份的星系设计稿仓库。消费者读同一份：星系设计面板（写）、侧栏工作区行的主星头像、页头、
 * 工作区 New Task 页的星系、右栏编排面板的星系图（读）——面板里一改，各处同一帧跟着变。
 *
 * 真源是工作区文件夹里的 planet/（与插件 planet-forge 同一份，shared/planet-design.ts）：
 * 启动与工作区列表变化时读一遍（usePlanetFiles），面板里的修改去抖后写回（persistDesign）。
 * 读失败或盘上没有设计稿 → 回退到按工作区 id 取的种子稿。
 * 页面地址在一次加载里不变：`?designer=bare|full` 定 fixture 档，模块加载时建一次。
 */
/** 头像候选（原型，等用户挑；见 chat/proto-variants.ts）：seeded = 没设计过的工作区按 id 取种子稿，same = 全部同一颗默认主星 */
export const avatarSeeded = (): boolean => getProtoVariants().avatar === "seeded";

export const galaxyDesigns = createDesignStore(designLevelOf(window.location.search), { seeded: avatarSeeded });
// 候选切换时丢掉缓存的默认稿，侧栏头像与页面星系同一帧重画
subscribeProtoVariants(() => galaxyDesigns.refresh());

/** 头像要不要随质量放大放小（只在种子默认下开） */
export function useAvatarBySize(): boolean {
  return useProtoVariants().avatar === "seeded";
}

export function useGalaxyDesign(workspaceId: string): { design: GalaxyDesign; edited: boolean; origin: DesignOrigin } {
  const design = useSyncExternalStore(
    galaxyDesigns.subscribe,
    useCallback(() => galaxyDesigns.get(workspaceId), [workspaceId]),
  );
  return { design, edited: galaxyDesigns.has(workspaceId), origin: galaxyDesigns.origin(workspaceId) };
}

/** 读一个工作区的 planet/（失败与「盘上没有」一样回退种子稿，只记日志） */
export async function loadPlanetDesign(workspaceId: string): Promise<void> {
  try {
    const result = await api.planet.read(workspaceId);
    if (!result.ok) {
      console.warn(`[planet] 读设计稿失败（${workspaceId}）：${result.error}`);
      galaxyDesigns.load(workspaceId, null);
      return;
    }
    galaxyDesigns.load(workspaceId, result.planets === null ? null : designFromPlanets(result.planets, galaxyDesigns.fallback(workspaceId)));
  } catch (error) {
    console.warn(`[planet] 读设计稿失败（${workspaceId}）：`, error);
    galaxyDesigns.load(workspaceId, null);
  }
}

/** 工作区列表一变就把每个工作区的 planet/ 读一遍（App 挂一次） */
export function usePlanetFiles(workspaces: readonly Workspace[]): void {
  const key = workspaces.map((workspace) => `${workspace.id}:${workspace.path}`).join("|");
  useEffect(() => {
    const ids = workspaces.map((workspace) => workspace.id);
    const readAll = (): void => {
      for (const id of ids) void loadPlanetDesign(id);
    };
    readAll();
    // 插件（或用户在文件夹里）改了设计稿：窗口回到前台时再读一遍，侧栏头像与星系跟上
    window.addEventListener("focus", readAll);
    return () => window.removeEventListener("focus", readAll);
    // key 已覆盖 id 与路径；workspaces 引用每次渲染都可能新建
  }, [key]);
}

/** 写回的去抖（ms）：拖滑块时不每一帧写盘，松手后一小会儿写一次 */
export const PERSIST_DELAY_MS = 400;
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** 面板改了设计稿：去抖后写回工作区 planet/（插件稿只改名字与质量，其余进伴随文件 galaxy.json） */
export function persistDesign(workspaceId: string): void {
  const timer = pending.get(workspaceId);
  if (timer !== undefined) clearTimeout(timer);
  pending.set(
    workspaceId,
    setTimeout(() => {
      pending.delete(workspaceId);
      const design = galaxyDesigns.get(workspaceId);
      if (!writableDesign(design)) return;
      void api.planet.write(planetsWriteOf(workspaceId, design)).then((result) => {
        if (!result.ok) console.warn(`[planet] 写回失败（${workspaceId}）：${result.error}`);
      });
    }, PERSIST_DELAY_MS),
  );
}
