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
  LatexCleanResult,
  LatexEngine,
  LatexFileContext,
  LatexIssue,
  LatexProjectInfo,
  LatexProbeResult,
  LatexStatus,
} from "@shared/latex";

/** 一次编译的摘要（界面只需要这些；错误全文在日志里） */
export interface LatexBuildSummary {
  status: LatexStatus;
  pages: number | null;
  durationMs: number;
  errors: LatexIssue[];
  warnings: LatexIssue[];
  /** 本次结果里的 PDF 绝对路径（失败时可能是上一版的） */
  pdfPath: string | null;
  finishedAt: number;
}

export interface LatexWorkbench {
  project: LatexProjectInfo | null;
  probe: LatexProbeResult | null;
  running: boolean;
  /** 这一轮开始的时刻（编译中的计时器用）；没在跑时 null */
  startedAt: number | null;
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
  cancel: () => void;
  clean: () => void;
  selectEngine: (engine: LatexEngine) => void;
  selectMain: (main: string) => void;
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

export function useLatexWorkbench(context: LatexFileContext | null): LatexWorkbench {
  const key = contextKey(context);
  const contextRef = useRef(context);
  contextRef.current = context;
  const runningRef = useRef(false);
  /** 请求代次：切文件后晚到的项目响应不许覆盖新文件的 */
  const requestRef = useRef(0);

  const [project, setProject] = useState<LatexProjectInfo | null>(null);
  const projectRef = useRef<LatexProjectInfo | null>(null);
  projectRef.current = project;
  const [probe, setProbe] = useState<LatexProbeResult | null>(null);
  const [running, setRunning] = useState(false);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [last, setLast] = useState<LatexBuildSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfReloadToken, setPdfReloadToken] = useState(0);
  const [cleaning, setCleaning] = useState(false);
  const [notice, setNotice] = useState<LatexNotice | null>(null);

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
      if (!soft) setError(null);    } catch (cause) {
      if (id !== requestRef.current) return;
      setProject(null);
      if (!soft) setError(failMessage(cause));
    }
  }, []);

  // 换文件 / 换会话：同一项目内切标签**不重置**（main.tex → main.pdf 时编译条不该
  // 闪一下、失败摘要更不能丢），只有跳出上一个项目目录才清掉这一轮的摘要。
  useEffect(() => {
    setError(null);
    runningRef.current = false;
    setRunning(false);
    setStartedAt(null);
    const ctx = contextRef.current;
    const current = projectRef.current;
    const keep = ctx !== null && current !== null && pathWithin(current.dir, ctx.path);
    if (!keep) {
      setProject(null);
      setLast(null);
    }
    if (key === "") {
      setProject(null);
      setLast(null);
      return;
    }
    void loadProject(false);
    void api.latex
      .probe()
      .then((result) => setProbe(result))
      .catch(() => setProbe(null));
  }, [key, loadProject]);

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

  const compile = useCallback((): void => {
    const ctx = contextRef.current;
    if (ctx === null || runningRef.current) return;
    runningRef.current = true;
    setRunning(true);
    setStartedAt(Date.now());
    setError(null);
    void (async () => {
      try {
        const outcome = await api.latex.compile(ctx);
        if (!outcome.ok) {
          setError(outcome.error);
          return;
        }
        const result = outcome.result;
        setLast({
          status: result.status,
          pages: result.pages,
          durationMs: result.durationMs,
          errors: result.errors,
          warnings: result.warnings,
          pdfPath: result.pdf,
          finishedAt: Date.now(),
        });
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
      }
    })();
  }, [loadProject]);

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
    last,
    error,
    cleaning,
    notice,
    pdfReloadToken,
    compile,
    cancel,
    clean,
    selectEngine: (engine) => configure({ engine }),
    selectMain: (main) => configure({ main }),
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
    a.mains.join("\u0000") === b.mains.join("\u0000")
  );
}
