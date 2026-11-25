/** 星系设计稿的 IPC（四层契约第 2 层）：读写逻辑在 store.ts（不碰 electron），这里只接通道、找工作区路径、处理地表图 */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { ipcMain, nativeImage } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isAvatarBodyRef, isAvatarGenerateRequest, isAvatarRenderPolicySetRequest, isAvatarSelectRequest, type AvatarHistoryResult, type AvatarJob, type AvatarJobEvent, type AvatarJobResult, type AvatarRenderPolicyResult } from "../../shared/planet-avatar.ts";
import { mainWindows } from "../window/main-windows.ts";
import type { AvatarJobs } from "./avatar.ts";
import { isPlanetWriteRequest, type PlanetReadResult, type PlanetWriteResult } from "../../shared/planet-design.ts";
import type { SubAgentMutationResult, SubAgentsChanged } from "../../shared/sub-agent.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { sphereCrop } from "./sphere.ts";
import { PlanetStore } from "./store.ts";
import type { SubAgentStore } from "./sub-agents.ts";

/** 地表贴图的边长（px）：最大的用处是设计面板预览（约 160px 的球）与 New Task 页主星，256 在 2× 屏上也够 */
export const SURFACE_PX = 256;

/** SVG 地表最大多大（插件校验上限是 200 KB，留点余量）；再大不读，当没有图 */
export const SVG_SURFACE_MAX_BYTES = 320 * 1024;

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
  // 智能体画的 SVG 地表（插件 model_svg 后端）：nativeImage 读不了 SVG。插件校验过它在正圆 clipPath 里、没有脚本与外链，
  // 原样转 data URL 交给界面（<image> 里的 SVG 也不执行脚本）
  if (extname(path).toLowerCase() === ".svg") {
    const info = await stat(path);
    const src = info.size > SVG_SURFACE_MAX_BYTES ? null : `data:image/svg+xml;base64,${(await readFile(path)).toString("base64")}`;
    cache.set(key, src);
    return src;
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function registerPlanetIpc(workspaces: WorkspaceStore, subAgents: SubAgentStore, broadcast: (event: SubAgentsChanged) => void): void {
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
  // 子智能体：面板里新建 / 改 / 删（与聊天里的工具同一个 SubAgentStore、同一份档案）。入参的形状与校验在 store 里做
  const mutate = async (
    workspaceId: unknown,
    action: SubAgentsChanged["action"],
    run: (path: string, workspaceId: string) => Promise<{ ok: true; value: { id: string } } | { ok: false; error: string }>,
  ): Promise<SubAgentMutationResult> => {
    const path = await pathOf(workspaceId);
    if (path === null || typeof workspaceId !== "string") return { ok: false, error: "没有这个工作区" };
    try {
      const result = await run(path, workspaceId);
      if (!result.ok) return result;
      broadcast({ workspaceId, subAgentId: result.value.id, action, source: "panel" });
      return { ok: true, id: result.value.id };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  ipcMain.handle(ipcChannels.subAgentCreate, (_event, request: unknown): Promise<SubAgentMutationResult> =>
    isRecord(request)
      ? mutate(request["workspaceId"], "created", (path, workspaceId) => subAgents.create(path, request["input"], "panel", workspaceId))
      : Promise.resolve({ ok: false, error: "请求的形状不对" }),
  );
  ipcMain.handle(ipcChannels.subAgentUpdate, (_event, request: unknown): Promise<SubAgentMutationResult> =>
    isRecord(request) ? mutate(request["workspaceId"], "updated", (path) => subAgents.update(path, request["input"], "panel")) : Promise.resolve({ ok: false, error: "请求的形状不对" }),
  );
  ipcMain.handle(ipcChannels.subAgentDelete, (_event, request: unknown): Promise<SubAgentMutationResult> =>
    isRecord(request) && typeof request["id"] === "string"
      ? mutate(request["workspaceId"], "deleted", (path) => subAgents.delete(path, request["id"] as string))
      : Promise.resolve({ ok: false, error: "请求的形状不对" }),
  );
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

/** 「生成形象」的进度推给所有主窗口（载荷带整份状态，面板按 workspaceId + bodyId 认领） */
export function broadcastAvatarJob(job: AvatarJob): void {
  const event: AvatarJobEvent = { job };
  for (const window of mainWindows.list()) window.webContents.send(ipcChannels.planetAvatarEvent, event);
}

/** 「生成形象」的通道（四层契约第 2 层）：入参全当不可信，形状在这里核，逻辑在 avatar.ts */
export function registerAvatarIpc(jobs: AvatarJobs): void {
  const guard = async (run: () => Promise<AvatarJobResult>): Promise<AvatarJobResult> => {
    try {
      return await run();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const guardHistory = async (run: () => Promise<AvatarHistoryResult>): Promise<AvatarHistoryResult> => {
    try {
      return await run();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  const bad: AvatarJobResult = { ok: false, error: "请求的形状不对" };
  const badHistory: AvatarHistoryResult = { ok: false, error: "请求的形状不对" };
  const badPolicy: AvatarRenderPolicyResult = { ok: false, error: "请求的形状不对" };
  const guardPolicy = async (run: () => Promise<AvatarRenderPolicyResult>): Promise<AvatarRenderPolicyResult> => {
    try {
      return await run();
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
  // 「用生图工具」开关：策略是插件级的（不分工作区），读 / 拨都经插件脚本
  ipcMain.handle(ipcChannels.planetAvatarPolicyGet, (): Promise<AvatarRenderPolicyResult> => guardPolicy(() => jobs.renderPolicy()));
  ipcMain.handle(ipcChannels.planetAvatarPolicySet, (_event, request: unknown): Promise<AvatarRenderPolicyResult> =>
    isAvatarRenderPolicySetRequest(request) ? guardPolicy(() => jobs.setRenderPolicy(request)) : Promise.resolve(badPolicy),
  );
  ipcMain.handle(ipcChannels.planetAvatarGenerate, (_event, request: unknown) => (isAvatarGenerateRequest(request) ? guard(() => jobs.generate(request)) : bad));
  ipcMain.handle(ipcChannels.planetAvatarGet, (_event, request: unknown) => (isAvatarBodyRef(request) ? guard(() => jobs.get(request)) : bad));
  ipcMain.handle(ipcChannels.planetAvatarHistory, (_event, request: unknown) => (isAvatarBodyRef(request) ? guardHistory(() => jobs.history(request)) : badHistory));
  ipcMain.handle(ipcChannels.planetAvatarSelect, (_event, request: unknown) => (isAvatarSelectRequest(request) ? guard(() => jobs.select(request)) : bad));
  ipcMain.handle(ipcChannels.planetAvatarCancel, (_event, request: unknown) => (isAvatarBodyRef(request) ? guard(() => jobs.cancel(request)) : bad));
}
