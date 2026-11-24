/**
 * 看板的 IPC —— 四层契约的第 2 层（契约在 shared/plugin-board.ts）。
 * - `board:week`：全局周看板的数据（装配在 board-week.ts，纯核可测）；
 * - `board:frame`：按快照画卡——模板哈希 → 一次性 iframe 地址（模板仓库里读出来、内容对得上哈希才给）。
 * 入参一律当不可信：weekStart 非有限数回 null；哈希不过 /^[0-9a-f]{64}$/ 回 null。
 */
import { ipcMain, nativeImage, type WebContents } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { BoardShotResponse, BoardWeekResponse } from "../../shared/plugin-board.ts";
import { boardShotRect } from "../../shared/plugin-board.ts";
import { assembleBoardWeek, type BoardWeekDeps } from "./board-week.ts";
import { captureFrame } from "../browser/frame-capture.ts";
import { boardFrameOf, type BoardTemplateStore } from "./board-snapshot.ts";
import type { PanelFrames } from "./panel-frame.ts";

export interface BoardIpcDeps {
  week: BoardWeekDeps;
  templates: Pick<BoardTemplateStore, "read">;
  frames: Pick<PanelFrames, "register">;
}

/** 同一页面里的多块看板可能一起画好；capturePage 并发会等不到帧，按 webContents 串行 */
const boardShotQueues = new Map<number, Promise<BoardShotResponse>>();

function captureBoardShot(contents: WebContents, rect: NonNullable<ReturnType<typeof boardShotRect>>): Promise<BoardShotResponse> {
  const previous = boardShotQueues.get(contents.id) ?? Promise.resolve(null);
  const next = previous.then(async () => {
    try {
      // CDP clip 在 Electron 里会留下一个等于裁剪区的仿真视口。整页取帧后只在内存里裁，页面布局不动。
      const png = await captureFrame(contents);
      if (png === null) return null;
      const page = nativeImage.createFromBuffer(png);
      const ratio = await contents.executeJavaScript("window.devicePixelRatio || 1");
      if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio < 1 || ratio > 3) return null;
      const image = page.crop({ x: Math.round(rect.x * ratio), y: Math.round(rect.y * ratio), width: Math.round(rect.width * ratio), height: Math.round(rect.height * ratio) });
      if (image.isEmpty()) return null;
      const size = image.getSize();
      return { base64: image.toPNG().toString("base64"), width: size.width, height: size.height };
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
  // 只截发起调用的这个 webContents：renderer 给的是看板在自己页面里的 CSS 矩形，不能借它截别人的窗口
  ipcMain.handle(ipcChannels.boardShot, async (event, raw: unknown): Promise<BoardShotResponse> => {
    const rect = boardShotRect(raw);
    if (rect === null) return null;
    return captureBoardShot(event.sender, rect);
  });
}
