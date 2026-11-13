/**
 * chktex 行内检查的 renderer 侧：什么时候问、问哪个文件。
 *
 * **只在「文件或它的源码 mtime 变了」时问**（依赖 `sourceModifiedAt`，由 4 秒轮询驱动），
 * 并在 700ms 里去抖：连续自动保存只跑最后一次。本机没有 chktex 时主进程回
 * `available:false`，这里就不再问第二次——它是可选组件，没装的人不该每 4 秒付一次
 * 起的子进程 IPC。
 *
 * 只对当前打开的那个 `.tex` 跑：chktex 的检查是文件级的，对项目里每个文件都跑一轮
 * 是另一件事（也慢得多）。
 */
import { useEffect, useRef, useState } from "react";
import type { LatexFileContext, LatexIssue, LatexProjectInfo } from "../../../../shared/latex.ts";
import { api } from "../../api.ts";

/** 自动保存 → chktex 之间的去抖：连续打字时只跑最后一次 */
const DEBOUNCE_MS = 700;

export function useLatexLint(
  context: LatexFileContext | null,
  project: LatexProjectInfo | null,
): readonly LatexIssue[] {
  const [issues, setIssues] = useState<readonly LatexIssue[]>([]);
  /** 本机有没有 chktex：只知道「有」之后才继续问；null = 还没问过 */
  const availableRef = useRef<boolean | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** 请求代次：换文件 / 换项目后晚到的结果不许覆盖新的 */
  const requestRef = useRef(0);

  const path = context?.path ?? null;
  const dir = project?.dir ?? null;
  const stamp = project?.sourceModifiedAt ?? null;
  const isTex = path !== null && /\.tex$/i.test(path);

  // 换项目：允许重新探测一次（用户可能刚装了 chktex / 换了 TeX 树）。
  // 「没有」只在同一个项目里缓存——那是「这台机器上没有」，不必每 4 秒再问一遍
  useEffect(() => {
    availableRef.current = null;
  }, [dir]);

  useEffect(() => {
    if (path === null || dir === null || !isTex || availableRef.current === false) {
      requestRef.current += 1;
      setIssues((current) => (current.length === 0 ? current : []));
      return;
    }
    const ctx = contextRef.current;
    if (ctx === null) return;
    const id = ++requestRef.current;
    const timer = window.setTimeout(() => {
      void api.latex
        .lint(ctx)
        .then((outcome) => {
          if (id !== requestRef.current) return;
          availableRef.current = outcome.available;
          setIssues(outcome.available ? outcome.issues : []);
        })
        .catch(() => {
          // 通道失败：不留旧波浪线（它们描述的是上一版文本），也不弹错误
          if (id !== requestRef.current) return;
          setIssues((current) => (current.length === 0 ? current : []));
        });
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [path, dir, stamp, isTex]);

  return issues;
}
