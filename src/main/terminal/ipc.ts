/**
 * 终端面板的 IPC —— 四层契约的第 2 层。校验在 service（shared 的形状闸 + 夹取），
 * 这里只做接线；renderer 传什么都不信，坏值一律当场抛（invoke 会把错误带回调用方）。
 */
import { ipcMain } from "electron";
import {
  clampTerminalDimension,
  terminalChannels,
  type TerminalCreateRequest,
} from "../../shared/terminal.ts";
import type { TerminalService } from "./service.ts";

/** 创建时行列夹取的兜底值：renderer 量不到尺寸时的 80×24 经典值 */
const FALLBACK_COLS = 80;
const FALLBACK_ROWS = 24;

export function registerTerminalIpc(service: TerminalService): void {
  ipcMain.handle(terminalChannels.create, (_event, request: TerminalCreateRequest) =>
    service.create({
      terminalId: request.terminalId,
      cols: clampTerminalDimension(request?.cols, FALLBACK_COLS),
      rows: clampTerminalDimension(request?.rows, FALLBACK_ROWS),
      ...(typeof request?.cwd === "string" && request.cwd !== "" ? { cwd: request.cwd } : {}),
    }),
  );

  ipcMain.handle(terminalChannels.list, () => service.list());

  ipcMain.handle(terminalChannels.snapshot, (_event, terminalId: string) => service.snapshot(terminalId));

  ipcMain.handle(terminalChannels.input, (_event, terminalId: string, data: string) => {
    service.input(terminalId, data);
  });

  ipcMain.handle(
    terminalChannels.resize,
    (_event, terminalId: string, cols: number, rows: number) => {
      service.resize(terminalId, clampTerminalDimension(cols, FALLBACK_COLS), clampTerminalDimension(rows, FALLBACK_ROWS));
    },
  );

  ipcMain.handle(terminalChannels.ackOutput, (_event, terminalId: string, sequence: number) => {
    service.acknowledge(terminalId, sequence);
  });

  ipcMain.handle(terminalChannels.kill, (_event, terminalId: string) => {
    service.kill(terminalId);
  });
}
