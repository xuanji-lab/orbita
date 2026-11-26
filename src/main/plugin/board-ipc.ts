/**
 * 看板的 IPC —— 四层契约的第 2 层（契约在 shared/plugin-board.ts）。
 * - `board:week`：全局周看板的数据（装配在 board-week.ts，纯核可测）；
 * - `board:frame`：按快照画卡——模板哈希 → 一次性 iframe 地址（模板仓库里读出来、内容对得上哈希才给）；
 * - `board:shot`：截发起调用的这张主窗口自己页面上的一块（切回会话时看板先贴位图用）。只认主窗口的 webContents，
 *   矩形必须整块落在这一页此刻的视口里；截到的图只回给调用方，不落盘、不进日志。
 * 入参一律当不可信：weekStart 非有限数回 null；哈希不过 /^[0-9a-f]{64}$/ 回 null。
 */
import { ipcMain, nativeImage, type NativeImage, type WebContents } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { BoardShotResponse, BoardWeekResponse } from "../../shared/plugin-board.ts";
import { boardShotInViewport, boardShotRect } from "../../shared/plugin-board.ts";
import { assembleBoardWeek, type BoardWeekDeps } from "./board-week.ts";
import { cdp, withTimeout } from "../browser/cdp.ts";
import { captureFrame } from "../browser/frame-capture.ts";
import { boardFullPage, boardShotPixels, boardShotViewport } from "./board-shot-image.ts";
import { boardFrameOf, type BoardTemplateStore } from "./board-snapshot.ts";
import type { PanelFrames } from "./panel-frame.ts";
import { mainWindows } from "../window/main-windows.ts";

export interface BoardIpcDeps {
  week: BoardWeekDeps;
  templates: Pick<BoardTemplateStore, "read">;
  frames: Pick<PanelFrames, "register">;
}

/** 同一页面里的多块看板可能一起画好；capturePage 并发会等不到帧，按 webContents 串行 */
const boardShotQueues = new Map<number, Promise<BoardShotResponse>>();

/** 原生 capturePage 没有 deadline：只给它 2 秒，挂住就换 CDP 路，不让后台留图拖住 IPC */
const NATIVE_SHOT_TIMEOUT_MS = 2_000;

function captureBoardShot(contents: WebContents, rect: NonNullable<ReturnType<typeof boardShotRect>>, viewport: { width: number; height: number }): Promise<BoardShotResponse> {
  const previous = boardShotQueues.get(contents.id) ?? Promise.resolve(null);
  const next = previous.then(async () => {
    try {
      const ratio = await contents.executeJavaScript("window.devicePixelRatio || 1");
      if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 1 || ratio > 3) return null;
      // 整窗取帧但不传裁剪矩形：原生快路省掉整页 PNG 的编码、传输与解码；尺寸不合 / 取不到再回 CDP 整页取帧
      const full = await boardFullPage<NativeImage>(
        {
          native: () => withTimeout(contents.capturePage(), NATIVE_SHOT_TIMEOUT_MS, "capturePage did not respond in time."),
          fallback: async () => {
            const png = await captureFrame(contents);
            return png === null ? null : nativeImage.createFromBuffer(png);
          },
        },
        { width: Math.round(viewport.width * ratio), height: Math.round(viewport.height * ratio) },
      );
      return full === null ? null : boardShotPixels(full.page, rect, ratio);
    } catch {
      return null;
    }
  });
  boardShotQueues.set(contents.id, next);
  return next.finally(() => {
    if (boardShotQueues.get(contents.id) === next) boardShotQueues.delete(contents.id);
  });
}

export function registerBoardIpc(deps: BoardIpcDeps): void {
  ipcMain.handle(ipcChannels.boardWeek, async (_e, raw: unknown): Promise<BoardWeekResponse | null> => {
    const weekStart = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["weekStart"] : undefined;
    return assembleBoardWeek(deps.week, weekStart);
  });
  ipcMain.handle(ipcChannels.boardFrame, (_e, raw: unknown) => boardFrameOf(deps, raw));
  // 只截发起调用的这个 webContents 自己的页面，而且只认主窗口：renderer 给的矩形只能落在这一页此刻的视口里，
  // 借它截不到别的窗口，也截不到屏幕上没有的内容。截到的图只回给调用方
  ipcMain.handle(ipcChannels.boardShot, async (event, raw: unknown): Promise<BoardShotResponse> => {
    const rect = boardShotRect(raw);
    if (rect === null) return null;
    const contents = event.sender;
    if (contents.isDestroyed() || !mainWindows.list().some((window) => window.webContents === contents)) return null;
    // 视口大小问调试协议（CSS 像素），不问页面脚本；问不到就不截
    let viewport: { width: number; height: number } | null;
    try {
      viewport = boardShotViewport((await cdp(contents, "Page.getLayoutMetrics") as { cssVisualViewport?: unknown }).cssVisualViewport);
    } catch {
      return null;
    }
    if (viewport === null || !boardShotInViewport(rect, viewport)) return null;
    return captureBoardShot(contents, rect, viewport);
  });
}
