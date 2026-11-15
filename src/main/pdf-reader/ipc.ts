/**
 * PDF 阅读器的 IPC —— 四层契约的第 2 层（契约在 shared/pdf-reader.ts）。
 *
 * open 过文件面板同一道 root/dir 白名单（resolveFileRoots + whitelistedPath，realpath 之后再判 .pdf——
 * 改名成 foo.pdf 的软链接指向别的文件同样被拒），之后的存 / 删只认 open 发的 token。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/agent-ipc.ts";
import { isPdfFile } from "../../shared/files.ts";
import type {
  PdfReaderDeleteRequest,
  PdfReaderOpenRequest,
  PdfReaderOpenResult,
  PdfReaderSaveRequest,
  PdfReaderWriteResult,
} from "../../shared/pdf-reader.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { resolveFileRoots } from "../files/roots.ts";
import { whitelistedPath } from "../files/list.ts";
import { checkReaderBuild, type BuildCheck } from "./build-check.ts";
import type { PdfReaderDocs } from "./docs.ts";

export function registerPdfReaderIpc(deps: {
  workspaces: WorkspaceStore;
  sessions: SessionStore;
  docs: PdfReaderDocs;
  buildDir: string;
  hostDir: string;
}): void {
  const { docs } = deps;
  // 产物核对一次就够（进程内不变）；失败的结果不缓存——开发时补跑构建后重开面板即可，不必重启应用
  let checked: Promise<BuildCheck> | null = null;
  const check = async (): Promise<BuildCheck> => {
    checked ??= checkReaderBuild(deps.buildDir, deps.hostDir);
    const result = await checked;
    if (!result.ok) checked = null;
    return result;
  };

  ipcMain.handle(ipcChannels.pdfReaderOpen, async (_event, req: PdfReaderOpenRequest): Promise<PdfReaderOpenResult> => {
    // 先领号再 await：几次 open 谁算「当前」按请求到达的先后定（见 PdfReaderDocs.begin）
    const ticket = docs.begin();
    const roots = await resolveFileRoots(deps.workspaces, deps.sessions, req);
    const path = await whitelistedPath(roots, req);
    if (!isPdfFile(path)) throw new Error(`Not a PDF file: ${path}`);
    const build = await check();
    if (!build.ok) return { kind: "unavailable", reason: build.reason, detail: build.detail };
    return { kind: "ready", ...(await docs.open(path, ticket)) };
  });

  ipcMain.handle(ipcChannels.pdfReaderSave, (_event, req: PdfReaderSaveRequest): Promise<PdfReaderWriteResult> =>
    docs.save(String(req?.token), Array.isArray(req?.annotations) ? req.annotations : []),
  );

  ipcMain.handle(ipcChannels.pdfReaderDelete, (_event, req: PdfReaderDeleteRequest): Promise<PdfReaderWriteResult> =>
    docs.remove(String(req?.token), Array.isArray(req?.ids) ? req.ids : []),
  );

  ipcMain.handle(ipcChannels.pdfReaderClose, (_event, token: unknown): void => {
    if (typeof token === "string") docs.close(token);
  });
}
