/**
 * 看板的 IPC —— 四层契约的第 2 层（契约在 shared/plugin-board.ts）。
 * - `board:week`：全局周看板的数据（装配在 board-week.ts，纯核可测）；
 * - `board:frame`：按快照画卡——模板哈希 → 一次性 iframe 地址（模板仓库里读出来、内容对得上哈希才给）。
 * 入参一律当不可信：weekStart 非有限数回 null；哈希不过 /^[0-9a-f]{64}$/ 回 null。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import type { BoardShotResponse, BoardWeekResponse } from "../../shared/plugin-board.ts";
import { boardShotRect } from "../../shared/plugin-board.ts";
import { assembleBoardWeek, type BoardWeekDeps } from "./board-week.ts";
import { boardFrameOf, type BoardTemplateStore } from "./board-snapshot.ts";
import type { PanelFrames } from "./panel-frame.ts";

export interface BoardIpcDeps {
  week: BoardWeekDeps;
  templates: Pick<BoardTemplateStore, "read">;
  frames: Pick<PanelFrames, "register">;
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
    try {
      const image = await event.sender.capturePage(rect);
      if (image.isEmpty()) return null;
      const size = image.getSize();
      return { base64: image.toPNG().toString("base64"), width: size.width, height: size.height };
    } catch {
      return null;
    }
  });
}
