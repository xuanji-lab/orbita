/** 星系设计稿的 IPC（四层契约第 2 层）：读写逻辑在 store.ts（不碰 electron），这里只接通道、找工作区路径、处理地表图 */
import { stat } from "node:fs/promises";
import { ipcMain, nativeImage } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isPlanetWriteRequest, type PlanetReadResult, type PlanetWriteResult } from "../../shared/planet-design.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { sphereCrop } from "./sphere.ts";
import { PlanetStore } from "./store.ts";

/** 地表贴图的边长（px）：最大的用处是设计面板预览（约 160px 的球）与 New Task 页主星，256 在 2× 屏上也够 */
export const SURFACE_PX = 256;

/** 同一张图（路径 + 修改时间 + 大小）只裁一次：侧栏、页头、星系各处同源，切工作区不重复解码 1024 的 PNG */
const cache = new Map<string, string | null>();

export async function loadSurface(path: string): Promise<string | null> {
  let key: string;
  try {
    const info = await stat(path);
    key = `${path}:${info.mtimeMs}:${info.size}`;
  } catch {
    return null;
  }
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const image = nativeImage.createFromPath(path);
  let src: string | null = null;
  if (!image.isEmpty()) {
    const { width, height } = image.getSize();
    const box = sphereCrop(image.toBitmap(), width, height);
    src = image.crop({ x: box.x, y: box.y, width: box.size, height: box.size }).resize({ width: SURFACE_PX, height: SURFACE_PX, quality: "best" }).toDataURL();
  }
  cache.set(key, src);
  return src;
}

export function registerPlanetIpc(workspaces: WorkspaceStore): void {
  const store = new PlanetStore(loadSurface);
  const pathOf = async (workspaceId: unknown): Promise<string | null> => {
    if (typeof workspaceId !== "string") return null;
    return (await workspaces.list()).find((workspace) => workspace.id === workspaceId)?.path ?? null;
  };
  ipcMain.handle(ipcChannels.planetRead, async (_event, workspaceId: unknown): Promise<PlanetReadResult> => {
    const path = await pathOf(workspaceId);
    if (path === null) return { ok: false, error: "没有这个工作区" };
    try {
      const planets = await store.read(path);
      if (planets !== null && planets.warnings.length > 0) console.warn(`[planet] ${path}: ${planets.warnings.join("；")}`);
      return { ok: true, planets };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(ipcChannels.planetWrite, async (_event, request: unknown): Promise<PlanetWriteResult> => {
    if (!isPlanetWriteRequest(request)) return { ok: false, error: "写回请求的形状不对" };
    const path = await pathOf(request.workspaceId);
    if (path === null) return { ok: false, error: "没有这个工作区" };
    try {
      await store.write(path, request);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
