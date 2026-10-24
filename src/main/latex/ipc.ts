/**
 * 文件面板的 LaTeX 通道 —— 四层契约的第 2 层（契约在 `shared/latex.ts` 的
 * `latexChannels`，preload 面在 `preload/api/latex.ts`）。
 *
 * **不新造第二套授权**：请求只带「根 + 当前文件」，先用 `resolveFileRoots` +
 * `whitelistedPath`（与 fs:read 同一道）拿到真实路径，再往上找项目目录。
 * renderer 因此无法让主进程去编一个根之外的 .tex。
 *
 * 编译本身仍是 PR1 的 `LatexRunner`：同一份并发记账、同一套 .log 解析，agent 的
 * `compile_latex` 与这里的按钮编的是同一个东西——「两边看到的是同一次编译」。
 */
import { realpath } from "node:fs/promises";
import { ipcMain } from "electron";
import type { FileListRequest } from "../../shared/files.ts";
import {
  isLatexEngine,
  latexChannels,
  type LatexConfigureOutcome,
  type LatexConfigureRequest,
  type LatexFileContext,
  type LatexForwardOutcome,
  type LatexForwardRequest,
  type LatexProjectOutcome,
  type LatexReverseOutcome,
  type LatexReverseRequest,
  type LatexRunOutcome,
} from "../../shared/latex.ts";
import type { SessionStore } from "../session/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { resolveFileRoots } from "../files/roots.ts";
import { whitelistedPath } from "../files/list.ts";
import { describeLatexProject, findLatexProjectDir, writeLatexProjectConfig } from "./project.ts";
import { forwardSearch, insideProject, reverseSearch } from "./synctex.ts";
import type { LatexRunner } from "./run.ts";

export function registerLatexIpc(
  runner: LatexRunner,
  workspaces: WorkspaceStore,
  sessions: SessionStore,
): void {
  ipcMain.handle(latexChannels.probe, () => runner.probeEnvironment());

  ipcMain.handle(latexChannels.project, async (_event, req: LatexFileContext): Promise<LatexProjectOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    return located === null
      ? { found: false }
      : { found: true, project: describeLatexProject(located.dir) };
  });

  ipcMain.handle(latexChannels.compile, async (_event, req: LatexFileContext): Promise<LatexRunOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    if (located === null) return { ok: false, error: "This file is not inside a LaTeX project." };
    return runner.compile({ dir: located.dir });
  });

  ipcMain.handle(latexChannels.cancel, async (_event, req: LatexFileContext): Promise<boolean> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    return located === null ? false : runner.cancel(located.dir);
  });

  ipcMain.handle(
    latexChannels.configure,
    async (_event, req: LatexConfigureRequest): Promise<LatexConfigureOutcome> => {
      if (req.engine !== undefined && !isLatexEngine(req.engine)) {
        return { ok: false, error: `Unknown engine: ${String(req.engine)}` };
      }
      const located = await locateLatexProject(req, workspaces, sessions);
      if (located === null) return { ok: false, error: "This file is not inside a LaTeX project." };
      try {
        await writeLatexProjectConfig(located.dir, {
          ...(req.main === undefined ? {} : { main: req.main }),
          ...(req.engine === undefined ? {} : { engine: req.engine }),
        });
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
      return { ok: true, project: describeLatexProject(located.dir) };
    },
  );

  /**
   * 源码 → PDF。响应要求（源码文件）必须是项目内的文件：synctex 对「项目外的一行」
   * 会给出最近似的命中，那会把用户引到别的文件上——先在白名单层拦下。
   */
  ipcMain.handle(
    latexChannels.synctexForward,
    async (_event, req: LatexForwardRequest): Promise<LatexForwardOutcome> => {
      const located = await locateLatexProject(req, workspaces, sessions);
      if (located === null) return { ok: false, reason: "outside-project", detail: req.path };
      const source = insideProject(located.dir, located.file);
      if (source === null) return { ok: false, reason: "outside-project", detail: located.file };
      const project = describeLatexProject(located.dir);
      if (project.pdf === null) return { ok: false, reason: "no-pdf", detail: project.dir };
      const probe = await runner.probeEnvironment();
      return forwardSearch({
        dir: project.dir,
        file: source.file,
        pdf: project.pdf.path,
        line: req.line,
        column: req.column ?? 1,
        latexmk: probe.latexmk,
      });
    },
  );

  /** PDF 页面坐标 → 源码。`path` 是 PDF 自己：项目目录与白名单都按它核 */
  ipcMain.handle(
    latexChannels.synctexReverse,
    async (_event, req: LatexReverseRequest): Promise<LatexReverseOutcome> => {
      const located = await locateLatexProject(req, workspaces, sessions);
      if (located === null) return { ok: false, reason: "outside-project", detail: req.path };
      const probe = await runner.probeEnvironment();
      return reverseSearch({
        dir: located.dir,
        pdf: located.file,
        page: req.page,
        x: req.x,
        y: req.y,
        latexmk: probe.latexmk,
      });
    },
  );
}

/**
 * 请求 → 白名单内的真实文件路径 → 项目目录。找不到项目回 null（不是错误：
 * 「这个文件不属于 LaTeX 项目」是文件面板的日常，编译条不出现即可）。
 * 路径越界 / 根不对由 whitelistedPath 抛，renderer 的 catch 把它显示成一行错误。
 *
 * 导出给 `main/cite/ipc.ts` 用：引用补全读哪个目录，必须与编译读的同一个目录——
 * 两份「从文件往上找项目」的实现在 magic comment 上迟早会分家。
 */
export async function locateLatexProject(
  req: LatexFileContext,
  workspaces: WorkspaceStore,
  sessions: SessionStore,
): Promise<{ dir: string; file: string } | null> {
  const roots = await resolveFileRoots(workspaces, sessions, req);
  const listReq: FileListRequest = {
    sessionId: req.sessionId,
    workspaceId: req.workspaceId,
    ...(req.extraWorkspaceId === undefined ? {} : { extraWorkspaceId: req.extraWorkspaceId }),
    root: req.root,
    dir: req.path,
  };
  const file = await whitelistedPath(roots, listReq);
  let boundary = req.root;
  try {
    boundary = await realpath(req.root);
  } catch {
    // 根不存在（工作台还没建）：findLatexProjectDir 也会走到同一个结论
  }
  const dir = findLatexProjectDir(file, boundary);
  return dir === null ? null : { dir, file };
}
