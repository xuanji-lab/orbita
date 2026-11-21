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
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { BrowserWindow, dialog, ipcMain } from "electron";
import type { FileListRequest } from "../../shared/files.ts";
import {
  isLatexEngine,
  latexChannels,
  type LatexCleanOutcome,
  type LatexConfigureOutcome,
  type LatexBuildProgress,
  type LatexCompileIpcRequest,
  type LatexConfigureRequest,
  type LatexFileContext,
  type LatexForwardOutcome,
  type LatexForwardRequest,
  type LatexIndexOutcome,
  type LatexLintOutcome,
  type LatexLocateOutcome,
  type LatexNavOutcome,
  type LatexPackageQuery,
  type LatexPackageNamesOutcome,
  type LatexProbeRequest,
  type LatexProjectOutcome,
  type LatexResolvedPackage,
  type LatexReverseOutcome,
  type LatexReverseRequest,
  type LatexRunOutcome,
} from "../../shared/latex.ts";
import { latexRecipePreset } from "../../shared/latex-recipes.ts";
import type { SessionStore } from "../session/store.ts";
import type { SettingsStore } from "../settings/store.ts";
import type { WorkspaceStore } from "../workspace/store.ts";
import { resolveFileRoots } from "../files/roots.ts";
import { whitelistedPath } from "../files/list.ts";
import { describeLatexProject, findLatexProjectDir, writeLatexProjectConfig } from "./project.ts";
import { buildLatexIndex } from "./index.ts";
import { buildLatexNav } from "./nav.ts";
import { lintWithChktex, probeChktex } from "./chktex.ts";
import { forwardSearch, insideProject, reverseSearch, synctexCommand } from "./synctex.ts";
import { createPandocProbe } from "../docx-export/probe.ts";
import { formatPandocVersion } from "../../shared/docx-export.ts";
import type { LatexEnvCheckItem, LatexEnvCheckResult } from "../../shared/latex.ts";
import { createLatexPackageLookup } from "./packages.ts";
import { createLatexPackageNameIndex } from "./package-names.ts";
import type { LatexRunner } from "./run.ts";

export function registerLatexIpc(
  runner: LatexRunner,
  workspaces: WorkspaceStore,
  sessions: SessionStore,
  settings: SettingsStore,
): void {
  // 反查只在渲染层点开问题抽屉时用到；它与具体项目无关（看的是本机 TeX 树），
  // 但入口照旧先过一遍白名单——不让这条通道变成「没有授权也能起外部命令」。
  const packages = createLatexPackageLookup(async () => (await runner.probeEnvironment()).latexmk);
  // 宏包名表（`\usepackage` 的候选）：与本机 TeX 树有关，与项目无关；主进程扫一次、缓存
  const packageNames = createLatexPackageNameIndex();

  ipcMain.handle(latexChannels.probe, (_event, req?: LatexProbeRequest) =>
    runner.probeEnvironment(req ?? {}),
  );

  // 设置页 preflight：synctex / chktex / pandoc 的真实探测（latexmk 走 latex:probe）
  ipcMain.handle(latexChannels.envCheck, async (): Promise<LatexEnvCheckResult> => {
    const probe = await runner.probeEnvironment();
    const latexmk = probe.latexmk;
    const items: LatexEnvCheckItem[] = [];
    // synctex：latexmk 同目录的候选或 PATH 上的命令
    const syncCandidate = synctexCommand(latexmk, process.platform, existsSync);
    const syncOk = syncCandidate !== "synctex" && existsSync(syncCandidate);
    items.push({
      id: "synctex",
      ok: syncOk,
      detail: syncOk ? syncCandidate : "这台电脑上没有找到 synctex 命令（TeX 发行版可能缺组件）",
    });
    // chktex
    const chktex = await probeChktex(latexmk);
    items.push({
      id: "chktex",
      ok: chktex !== null,
      detail: chktex ?? "未安装（行内检查可选）",
    });
    // pandoc（≥3.10.2 才支持公式编号 \\tag）
    const pandoc = await createPandocProbe().probe();
    items.push({
      id: "pandoc",
      ok: pandoc.supported,
      detail: pandoc.supported
        ? `${pandoc.version ? formatPandocVersion(pandoc.version) : "已安装"} · ${pandoc.path ?? "PATH"}`
        : (pandoc.message ?? "需要 3.10.2 或更新"),
    });
    return { items };
  });

  /**
   * 「指定位置」：系统文件选择器 → 现验 `--version` → 通过才写进设置。
   * **不自动下载**，也不猜路径：用户选什么就只验什么。选到的文件跑不起来时返回
   * `invalid`（不写设置）——否则下次编译会在一个假路径上失败，比没选更难受。
   */
  ipcMain.handle(latexChannels.locate, async (): Promise<LatexLocateOutcome> => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null;
    // 不限扩展名：Windows 上的 latexmk 可能叫 latexmk.exe / .bat / .cmd，mac / Linux 上没有后缀
    const options: Electron.OpenDialogOptions = {
      title: "Select the latexmk executable",
      properties: ["openFile"],
    };
    const picked = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options);
    const path = picked.filePaths[0];
    if (picked.canceled || path === undefined) return { kind: "cancelled" };
    if (!(await runner.verifyLatexmkPath(path))) return { kind: "invalid", path };
    await settings.write({ latexmkPath: path });
    return { kind: "ok", path };
  });

  ipcMain.handle(latexChannels.project, async (_event, req: LatexFileContext): Promise<LatexProjectOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    return located === null
      ? { found: false }
      : {
          found: true,
          // 带上当前文件：它的 `% !TEX root` 决定 activeRoot，也用来算 focusedRoot。
          // 编译条看到的「下一次会编哪份」必须就是编译时真正用的那一份。
          project: describeLatexProject(located.dir, {
            ...(sourceFileOf(located.file) === null ? {} : { file: located.file }),
            boundary: [located.boundary],
          }),
        };
  });

  /**
   * chktex 行内检查。**探测到才启用**：本机没有 chktex 时回 available:false，界面
   * 不显示这条通道的任何痕迹。只对 .tex 跑（对 .bib / .sty 跑 chktex 是把别的语法
   * 当 TeX 解析，结果全是噪音）。
   */
  ipcMain.handle(latexChannels.lint, async (_event, req: LatexFileContext): Promise<LatexLintOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    if (located === null) return { available: false, issues: [] };
    if (!/\.tex$/i.test(located.file)) return { available: false, issues: [] };
    const source = insideProject(located.dir, located.file);
    if (source === null) return { available: false, issues: [] };
    const probe = await runner.probeEnvironment();
    const binary = await probeChktex(probe.latexmk);
    if (binary === null) return { available: false, issues: [] };
    const result = await lintWithChktex({ binary, file: source.file, projectDir: located.dir });
    return { available: true, issues: result.issues };
  });

  /**
   * 本机 TeX 发行版里的宏包名（`\usepackage{` 的补全）。与 `lint` 同一条白名单入口：
   * 不在 LaTeX 项目里就不给名单（补全只发生在项目里的 .tex / .sty）。
   * 扫描与缓存在 `package-names.ts`；这里只负责把探测到的 latexmk 递过去。
   */
  ipcMain.handle(
    latexChannels.packageNames,
    async (_event, req: LatexFileContext): Promise<LatexPackageNamesOutcome> => {
      const located = await locateLatexProject(req, workspaces, sessions);
      if (located === null) return { available: false, names: [], truncated: false };
      const probe = await runner.probeEnvironment();
      return packageNames.list(probe.latexmk);
    },
  );

  /**
   * 编一次。**当前文件（`path`）参与解析**：子文件里的 `% !TEX root` 从这里生效
   * （以前面板不传文件，那一行 magic 一个字都没被读）。`main` 只给「忽略 magic、
   * 编我点的那个 root」用——它是本次请求的显式覆盖，优先级最高。
   */
  ipcMain.handle(latexChannels.compile, async (_event, req: LatexCompileIpcRequest): Promise<LatexRunOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    if (located === null) return { ok: false, error: "This file is not inside a LaTeX project." };
    const source = sourceFileOf(located.file);
    return runner.compile({
      dir: located.dir,
      ...(source === null ? {} : { file: source }),
      boundary: [located.boundary],
      ...(typeof req.main === "string" && req.main.trim() !== "" ? { main: req.main } : {}),
    });
  });

  /** 编译中的进度（当前跑到哪一轮引擎）。1 秒轮询一次，不进项目描述（它是热路径） */
  ipcMain.handle(latexChannels.progress, async (_event, req: LatexFileContext): Promise<LatexBuildProgress> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    if (located === null) return { running: false, step: null, run: null };
    return runner.buildProgress(located.dir);
  });

  /**
   * 项目符号索引。与编译同一个项目目录（magic root 也一并生效）：补全的 `\ref`
   * 候选与 `\input` 路径候选读的是「编译真正会读的那些文件」。
   */
  ipcMain.handle(latexChannels.index, async (_event, req: LatexFileContext): Promise<LatexIndexOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    return located === null ? { found: false } : { found: true, index: buildLatexIndex(located.dir) };
  });

  /**
   * 多文件导航（包含图 + 每个文件的章节）。
   *
   * root 列表与编译条 / 闭包读的是同一个结论（`describeLatexProject`）：导航里
   * 「这个文件属于 main.tex」不能与「编译会编 main.tex」不一致。`file` 是当前打开的
   * 文件，用来算它属于哪些 root；图本身覆盖全部 root（文件树标记也要用到）。
   */
  ipcMain.handle(latexChannels.nav, async (_event, req: LatexFileContext): Promise<LatexNavOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    if (located === null) return { found: false };
    const project = describeLatexProject(located.dir, {
      ...(sourceFileOf(located.file) === null ? {} : { file: located.file }),
      boundary: [located.boundary],
    });
    const roots = project.roots.map((root) => resolve(project.dir, root.path));
    return {
      found: true,
      nav: buildLatexNav(project.dir, roots, { file: located.file }),
    };
  });

  ipcMain.handle(latexChannels.cancel, async (_event, req: LatexFileContext): Promise<boolean> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    return located === null ? false : runner.cancel(located.dir);
  });

  ipcMain.handle(latexChannels.clean, async (_event, req: LatexFileContext): Promise<LatexCleanOutcome> => {
    const located = await locateLatexProject(req, workspaces, sessions);
    if (located === null) return { ok: false, error: "This file is not inside a LaTeX project." };
    return runner.clean(located.dir);
  });

  ipcMain.handle(
    latexChannels.configure,
    async (_event, req: LatexConfigureRequest): Promise<LatexConfigureOutcome> => {
      if (req.engine !== undefined && !isLatexEngine(req.engine)) {
        return { ok: false, error: `Unknown engine: ${String(req.engine)}` };
      }
      if (req.upsertRoot !== undefined && req.upsertRoot.engine !== undefined && !isLatexEngine(req.upsertRoot.engine)) {
        return { ok: false, error: `Unknown engine: ${String(req.upsertRoot.engine)}` };
      }
      if (req.upsertRoot?.recipeId !== undefined && latexRecipePreset(req.upsertRoot.recipeId) === null) {
        return { ok: false, error: `Unknown recipe preset: ${req.upsertRoot.recipeId}` };
      }
      const located = await locateLatexProject(req, workspaces, sessions);
      if (located === null) return { ok: false, error: "This file is not inside a LaTeX project." };
      try {
        await writeLatexProjectConfig(located.dir, {
          ...(req.main === undefined ? {} : { main: req.main }),
          ...(req.activate === undefined ? {} : { activate: req.activate }),
          ...(req.upsertRoot === undefined ? {} : { root: req.upsertRoot }),
          ...(req.removeRoot === undefined ? {} : { removeRoot: req.removeRoot }),
          ...(req.engine === undefined ? {} : { engine: req.engine }),
          ...(req.compileOnSave === undefined ? {} : { compileOnSave: req.compileOnSave }),
        });
      } catch (cause) {
        return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
      }
      return {
        ok: true,
        project: describeLatexProject(located.dir, {
          ...(sourceFileOf(located.file) === null ? {} : { file: located.file }),
          boundary: [located.boundary],
        }),
      };
    },
  );

  /**
   * 缺的文件名 → 包名 / 安装命令。反查不到不是错误：返回的每一项都自带
   * `packageName: null`，界面据此说「未知包」。
   */
  ipcMain.handle(
    latexChannels.packages,
    async (_event, req: LatexPackageQuery): Promise<LatexResolvedPackage[]> => {
      const located = await locateLatexProject(req, workspaces, sessions);
      if (located === null) return [];
      const missing = Array.isArray(req.missing) ? req.missing.filter((name) => typeof name === "string") : [];
      return packages.resolve(missing);
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
      const project = describeLatexProject(located.dir, {
        ...(sourceFileOf(located.file) === null ? {} : { file: located.file }),
        boundary: [located.boundary],
      });
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
 * 只有 .tex 才值得拿 magic（编译条也会在项目 PDF 上出现：拿 PDF 去 parseMagicComments
 * 是在把二进制当文本读）。返回 null = 这次没有可用的当前文件。
 */
function sourceFileOf(file: string): string | null {
  return /\.tex$/i.test(file) ? file : null;
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
): Promise<{ dir: string; file: string; boundary: string } | null> {
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
  return dir === null ? null : { dir, file, boundary };
}
