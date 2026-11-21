/**
 * 文件面板的 LaTeX 状态：项目事实、探测、编译 / 取消 / 写配置、PDF 刷新信号。
 *
 * 状态住在 FilesPanel 这一层（不是编译条自己的 state）：切标签、关文件树都不该
 * 抹掉「这一轮编了什么、失败还是成功」——编译条只负责画。切到另一个文件时
 * context 的 key 变了才重置。
 *
 * 轮询项目事实（4 秒一次、窗口不可见时停）：agent 在对话区改完源码，面板里那颗
 * 编译按钮要自己变成主操作，而文件面板没有别的信号源（不 watch 整个项目）。
 * 只读 stat 与几个小文件，代价远低于一个 fs.watch 树。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { pathWithin } from "../../../../shared/path.ts";
import { api } from "../../api.ts";
import type {
  LatexBuildProgress,
  LatexCleanResult,
  LatexEngine,
  LatexFileContext,
  LatexIssue,
  LatexProjectInfo,
  LatexProbeResult,
  LatexStatus,
} from "@shared/latex";

import { recallBuild, rememberBuild, type LatexBuildSummary } from "./latex-build-store.ts";
import { COMPILE_NO_CONTEXT } from "./latex-workbench.ts";

export type { LatexBuildSummary } from "./latex-build-store.ts";

export interface LatexWorkbench {
  project: LatexProjectInfo | null;
  probe: LatexProbeResult | null;
  running: boolean;
  /** 这一轮开始的时刻（编译中的计时器用）；没在跑时 null */
  startedAt: number | null;
  /** 编译中的进度（latexmk 的 "Run number N of rule 'x'"）；没在跑时 null */
  progress: LatexBuildProgress | null;
  last: LatexBuildSummary | null;
  /** IPC / 授权 / 写配置失败的一句话（面板里一行红字，不弹窗） */
  error: string | null;
  /** 清理辅助文件在跑 */
  cleaning: boolean;
  /**
   * 一次动作的结果（目前只有清理）。**结构化而不是句子**：文案在 FilesPanel 那一层
   * 拼（那里才有 t），这里只说事实。几秒后自己消失——它是一次动作的回执，
   * 不是需要用户处理的问题（那种走 error）。
   */
  notice: LatexNotice | null;
  /** 编译成功后自增：PDF 标签据此重载（失败不动，保留上一版） */
  pdfReloadToken: number;
  compile: () => void;
  /** 切到另一个 root：写 activeRoot，然后立刻编它（显式 main，优先于文件里的 magic） */
  selectRoot: (path: string) => void;
  cancel: () => void;
  clean: () => void;
  /** 保存即编译的总开关（项目级）；写失败落到 error 行 */
  setCompileOnSave: (on: boolean) => void;
  /** 「重新检测」/「指定位置」在跑（引导卡的按钮置灰，避免连点两次起两个 `--version`） */
  probeBusy: boolean;
  /** 「指定位置」选到的文件跑不起来：路径如实回给卡片，不写设置 */
  locateInvalid: string | null;
  /** 重新探测本机 latexmk（作废缓存） */
  refreshProbe: () => void;
  /** 系统文件选择器选 latexmk：现验通过才写设置，然后重新探测 */
  locateLatexmk: () => void;
  selectEngine: (engine: LatexEngine) => void;
  refresh: () => void;
}

/** 动作回执。`cleaned` 带磁盘事实（删了几份、留下了什么），由界面决定怎么说 */
export type LatexNotice =
  | { kind: "cleaned"; result: LatexCleanResult }
  | { kind: "clean-error"; message: string };

/** 回执停留时长：够看清一行「删了 6 个文件」，又不至于占着面板 */
const NOTICE_MS = 6000;

/** 项目事实的轮询间隔：够快看到 agent 改完源码，又不至于让面板一直读盘 */
const POLL_MS = 4000;

const failMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** context 的身份：同一组授权 + 同一个文件才复用状态 */
function contextKey(context: LatexFileContext | null): string {
  if (context === null) return "";
  return [context.sessionId ?? "", context.workspaceId ?? "", context.extraWorkspaceId ?? "", context.root, context.path].join("\u0000");
}

/**
 * 编译结局**按项目目录**存（latex-build-store.ts，活过标签切换 / 面板卸载）。
 * 切到 pptx / docx 再切回来时，编译条与问题抽屉要原样恢复上一轮的结果
 * （2026-11-15 验收 P0-4）。
 */

export function useLatexWorkbench(context: LatexFileContext | null): LatexWorkbench {
  const key = contextKey(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  const runningRef = useRef(false);
  /**
   * 编译中来了一次「保存即编译」的请求：只记一次。连着保存十次也只补跑一轮——
   * 每一份中间稿都编一遍是纯浪费，而最后一次保存的内容一定会被那一轮带上。
   */
  const queuedRef = useRef(false);
  /** 排队那一轮要编的 root（null = 按当前解析；undefined = 没排队） */
  const queuedMainRef = useRef<string | null | undefined>(undefined);
  /** 请求代次：切文件后晚到的项目响应不许覆盖新文件的 */
  const requestRef = useRef(0);

  const [project, setProject] = useState<LatexProjectInfo | null>(null);
  const projectRef = useRef<LatexProjectInfo | null>(null);
  projectRef.current = project;
  const [probe, setProbe] = useState<LatexProbeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [progress, setProgress] = useState<LatexBuildProgress | null>(null);
  const [last, setLast] = useState<LatexBuildSummary | null>(null);
  /** `last` 属于哪个项目目录：切换项目时据此从 BUILD_BY_PROJECT 取回那一份 */
  const lastDirRef = useRef<string | null>(null);
  /** 项目目录变了（或第一次加载）：把那一份编译结局拿回来；同目录不动 */
  const restoreBuild = useCallback((dir: string | null): void => {
    if (dir === null || dir === lastDirRef.current) return;
    lastDirRef.current = dir;
    setLast(recallBuild(dir));
  }, []);
  const [error, setError] = useState<string | null>(null);
  const [pdfReloadToken, setPdfReloadToken] = useState(0);
  const [cleaning, setCleaning] = useState(false);
  const [notice, setNotice] = useState<LatexNotice | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [locateInvalid, setLocateInvalid] = useState<string | null>(null);

  // 回执自己过期：它是「刚才那件事成了」的一句话，不该留到下一次操作
  useEffect(() => {
    if (notice === null) return;
    const timer = window.setTimeout(() => setNotice(null), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  /**
   * 拉一次项目事实。`soft` = 轮询：失败静默（一次 stat 撞上文件被删，不该在面板上
   * 留一行红字），成功也只在项目真的变了才 setState（轮询每 4 秒重建一份对象会
   * 让整个编译条跟着重渲染）。
   */
  const loadProject = useCallback(async (soft: boolean): Promise<void> => {
    const ctx = contextRef.current;
    const id = ++requestRef.current;
    if (ctx === null) {
      setProject(null);
      return;
    }
    try {
      const outcome = await api.latex.project(ctx);
      if (id !== requestRef.current) return;
      const next = outcome.found ? outcome.project : null;
      setProject((current) => (sameProject(current, next) ? current : next));
      // 项目事实回来才知道目录：同一项目内切标签不动摘要，换项目取那个项目的那一份
      restoreBuild(next?.dir ?? null);
      if (!soft) setError(null);    } catch (cause) {
      if (id !== requestRef.current) return;
      setProject(null);
      if (!soft) setError(failMessage(cause));
    }
  }, [restoreBuild]);

  // 换文件 / 换会话：同一项目内切标签**不重置**（main.tex → main.pdf 时编译条不该
  // 闪一下、失败摘要更不能丢），只有跳出上一个项目目录才清掉这一轮的摘要。
  useEffect(() => {
    setError(null);
    runningRef.current = false;
    // 上一份项目的排队不留到新项目：它那张 PDF 与新文件无关
    queuedRef.current = false;
    setRunning(false);
    setStartedAt(null);
    const ctx = contextRef.current;
    const current = projectRef.current;
    const keep = ctx !== null && current !== null && pathWithin(current.dir, ctx.path);
    if (!keep) {
      setProject(null);
      // **不清 `last`**：切到 docx / pptx（ctx 为 null）再切回来时，编译结果要原样还在
      // （P0-4）。换到另一个项目由 restoreBuild 换成那个项目的那一份。
    }
    if (key === "") {
      setProject(null);
      return;
    }
    void loadProject(false);
    void api.latex
      .probe()
      .then((result) => setProbe(result))
      .catch(() => setProbe(null));
  }, [key, loadProject]);

  /**
   * 编译中的进度：1 秒问一次主进程「跑到哪一轮了」。**只在 running 时轮询**——
   * 它读的是 runner 内存里的一个字段（不读盘），但没在编时问它没有意义。
   */
  useEffect(() => {
    if (!running || context === null) {
      setProgress(null);
      return;
    }
    let cancelled = false;
    const tick = (): void => {
      void api.latex
        .progress(context)
        .then((next) => {
          if (!cancelled) setProgress(next);
        })
        .catch(() => {
          // 进度是锦上添花：通道失败时退回「编译中…」，不写 error 行
        });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // context 的身份由 key 决定（context 对象每一帧都可能是新的）
  }, [running, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // 轮询：只在窗口可见、且没在编译时跑（编译结束后会主动拉一次）
  useEffect(() => {
    if (key === "") return;
    const timer = window.setInterval(() => {
      if (runningRef.current) return;
      if (document.visibilityState !== "visible") return;
      void loadProject(true);
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [key, loadProject]);

  /** 真正跑一轮。自引用（结束时补跑排队的那一轮）走 ref，不为递归加依赖 */
  const runCompileRef = useRef<((main?: string) => Promise<void>) | null>(null);

  const runCompile = useCallback(async (main?: string): Promise<void> => {
    const ctx = contextRef.current;
    if (ctx === null) return;
    runningRef.current = true;
    setRunning(true);
    setStartedAt(Date.now());
    setError(null);
    try {
      const outcome = await api.latex.compile({ ...ctx, ...(main === undefined ? {} : { main }) });
      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }
      const result = outcome.result;
      const summary: LatexBuildSummary = {
        status: result.status,
        pages: result.pages,
        durationMs: result.durationMs,
        errors: result.errors,
        warnings: result.warnings,
        pdfPath: result.pdf,
        rootPath: result.root?.path ?? null,
        outputs: result.outputs,
        outputsTruncated: result.outputsTruncated,
        logPath: result.log?.path ?? null,
        finishedAt: Date.now(),
      };
      // 编译条只在项目内出现，这一拍 project 一定在；存进模块表，切走再回来还在
      const dir = projectRef.current?.dir ?? null;
      if (dir !== null) {
        rememberBuild(dir, summary);
        lastDirRef.current = dir;
      }
      setLast(summary);
      if (result.status === "ok" || result.status === "warning-only") {
        setPdfReloadToken((token) => token + 1);
      }
    } catch (cause) {
      setError(failMessage(cause));
    } finally {
      runningRef.current = false;
      setRunning(false);
      setStartedAt(null);
      await loadProject(true);
      // 排队的那一轮在「本轮收尾」之后才起：并发被拒（same-project）不是排队能解决的
      if (queuedRef.current) {
        queuedRef.current = false;
        const queuedMain = queuedMainRef.current ?? undefined;
        queuedMainRef.current = undefined;
        void runCompileRef.current?.(queuedMain);
      }
    }
  }, [loadProject]);
  runCompileRef.current = runCompile;

  const compile = useCallback((): void => {
    // 没有上下文（没绑会话 / 没有激活文件）：不能静默返回——那正是「点了没反应」
    if (contextRef.current === null) {
      setError(COMPILE_NO_CONTEXT);
      return;
    }
    if (runningRef.current) {
      queuedRef.current = true;
      queuedMainRef.current = null;
      return;
    }
    void runCompileRef.current?.();
  }, []);

  /**
   * 编指定的 root。**显式 main 是最高的优先级**：它就是「忽略这个文件的
   * `% !TEX root`、编我点的那个」——不这样，子文件里那行 magic 会让 chip 的
   * 选择看起来没生效。在编时排队（与保存即编译同一条队列）。
   */
  const compileRoot = useCallback((main: string): void => {
    if (contextRef.current === null) {
      setError(COMPILE_NO_CONTEXT);
      return;
    }
    if (runningRef.current) {
      queuedRef.current = true;
      queuedMainRef.current = main;
      return;
    }
    void runCompileRef.current?.(main);
  }, []);

  const compileRootRef = useRef(compileRoot);
  compileRootRef.current = compileRoot;

  /** 切 root：先写 activeRoot（下次打开项目也认它），再编它一次 */
  const selectRoot = useCallback((path: string): void => {
    const ctx = contextRef.current;
    if (ctx === null) return;
    void (async () => {
      try {
        const outcome = await api.latex.configure({ ...ctx, activate: path });
        if (!outcome.ok) {
          setError(outcome.error);
          return;
        }
        requestRef.current += 1;
        setProject(outcome.project);
        setError(null);
        compileRootRef.current(path);
      } catch (cause) {
        setError(failMessage(cause));
      }
    })();
  }, []);

  const cancel = useCallback((): void => {
    const ctx = contextRef.current;
    if (ctx === null) return;
    void api.latex.cancel(ctx).catch((cause: unknown) => setError(failMessage(cause)));
  }, []);

  /**
   * 清理辅助文件（`latexmk -c`）。与编译一样按当前 context 找项目——renderer 给不出
   * 目录，主进程用文件面板的白名单核。清理会动同一组 .aux，所以主进程侧与编译互斥：
   * 在编时回 same-project，这里如实转成回执里的错误，不自己猜。
   */
  const clean = useCallback((): void => {
    const ctx = contextRef.current;
    if (ctx === null || cleaning) return;
    setCleaning(true);
    setError(null);
    void (async () => {
      try {
        const outcome = await api.latex.clean(ctx);
        if (outcome.ok) {
          setNotice({ kind: "cleaned", result: outcome.result });
          // 产物目录变了（aux/log 被删）：编译条的「PDF 是否过期」要按新事实算一次。
          // PDF 本身没动，所以不碰 pdfReloadToken——重载会让阅读位置丢一次。
          await loadProject(true);
        } else {
          setNotice({ kind: "clean-error", message: outcome.error });
        }
      } catch (cause) {
        setNotice({ kind: "clean-error", message: failMessage(cause) });
      } finally {
        setCleaning(false);
      }
    })();
  }, [cleaning, loadProject]);

  const configure = useCallback(
    (patch: { main?: string; engine?: LatexEngine }): void => {
      const ctx = contextRef.current;
      if (ctx === null) return;
      void (async () => {
        try {
          const outcome = await api.latex.configure({ ...ctx, ...patch });
          if (!outcome.ok) {
            setError(outcome.error);
            return;
          }
          requestRef.current += 1;
          setProject(outcome.project);
          setError(null);
        } catch (cause) {
          setError(failMessage(cause));
        }
      })();
    },
    [],
  );

  /**
   * 重新探测（「已装好，重新检测」）。必须走 refresh：探测结果按进程缓存，不作废
   * 就会把启动时那句「没找到」原样还回来——用户刚装完 TeX 时会以为我们没看。
   */
  const refreshProbe = useCallback((): void => {
    setProbeBusy(true);
    setLocateInvalid(null);
    void api.latex
      .probe({ refresh: true })
      .then((result) => setProbe(result))
      .catch((cause: unknown) => setError(failMessage(cause)))
      .finally(() => setProbeBusy(false));
  }, []);

  /**
   * 「指定位置」：系统文件选择器选 latexmk。通过 `--version` 现验才写设置（主进程
   * 那一侧做），随后重新探测一次让界面与磁盘一致。取消选择什么也不做。
   */
  const locateLatexmk = useCallback((): void => {
    setProbeBusy(true);
    setLocateInvalid(null);
    void (async () => {
      try {
        const outcome = await api.latex.locate();
        if (outcome.kind === "invalid") {
          setLocateInvalid(outcome.path);
          return;
        }
        if (outcome.kind === "cancelled") return;
        const result = await api.latex.probe({ refresh: true });
        setProbe(result);
      } catch (cause) {
        setError(failMessage(cause));
      } finally {
        setProbeBusy(false);
      }
    })();
  }, []);

  /** 保存即编译的开关（写项目 `.orbita/latex.json`）；失败照旧落到 error 行 */
  const setCompileOnSave = useCallback(
    (on: boolean): void => {
      const ctx = contextRef.current;
      if (ctx === null) return;
      void (async () => {
        try {
          const outcome = await api.latex.configure({ ...ctx, compileOnSave: on });
          if (!outcome.ok) {
            setError(outcome.error);
            return;
          }
          // 作废在飞的轮询：它带回来的是改之前的事实，晚到会把刚写的开关冲回旧值
          requestRef.current += 1;
          setProject(outcome.project);
          setError(null);
        } catch (cause) {
          setError(failMessage(cause));
        }
      })();
    },
    [],
  );

  return {
    project,
    probe,
    running,
    startedAt,
    progress,
    last,
    error,
    cleaning,
    notice,
    pdfReloadToken,
    compile,
    selectRoot,
    cancel,
    clean,
    setCompileOnSave,
    probeBusy,
    locateInvalid,
    refreshProbe,
    locateLatexmk,
    selectEngine: (engine) => configure({ engine }),
    refresh: () => void loadProject(false),
  };
}

/** 项目事实是否等价（轮询去抖用：pdf mtime / 源码 mtime / 主文件 / 引擎变了才更新） */
function sameProject(a: LatexProjectInfo | null, b: LatexProjectInfo | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.dir === b.dir &&
    a.main === b.main &&
    a.engine === b.engine &&
    a.engineSource === b.engineSource &&
    a.pdf?.path === b.pdf?.path &&
    a.pdf?.modifiedAt === b.pdf?.modifiedAt &&
    a.sourceModifiedAt === b.sourceModifiedAt &&
    a.detail === b.detail &&
    // 开关也是项目事实：不比它，轮询会把「用户刚关掉」的那个值永远留在界面上
    a.compileOnSave === b.compileOnSave &&
    a.activeRoot === b.activeRoot &&
    a.focusedRoot === b.focusedRoot &&
    a.mains.join("\u0000") === b.mains.join("\u0000") &&
    a.roots.length === b.roots.length &&
    a.roots.every((root, index) => rootKey(root) === rootKey(b.roots[index]))
  );
}

/** 轮询去抖用的 root 指纹：只比会让界面变化的事实 */
function rootKey(root: LatexProjectInfo["roots"][number] | undefined): string {
  if (root === undefined) return "";
  return [
    root.path,
    root.source,
    root.engine,
    root.outDirRelative,
    root.jobname ?? "",
    root.pdf?.path ?? "",
    String(root.pdf?.modifiedAt ?? 0),
    String(root.sourceModifiedAt ?? 0),
    root.detail ?? "",
  ].join("\u0001");
}
