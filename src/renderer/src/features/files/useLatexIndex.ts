/**
 * 文件面板的项目符号索引（`latex:index`）：`\ref` 的 label 候选、项目自定义命令 / 环境、
 * `\input` / `\includegraphics` 的路径候选。
 *
 * **什么时候重问**：与 useCiteLibrary 同一条纪律——项目目录变了，或项目里最新源码的
 * mtime 变了（`sourceModifiedAt`，含 .tex/.bib/.cls/.sty）。后者由 useLatexWorkbench
 * 的 4 秒轮询驱动：agent 刚加完一个 `\label` / 一张图，最多 4 秒后就能补到。
 *
 * 读不到（IPC 失败 / 白名单拒绝）时**静默**退回 null：补全只剩静态表，不弹错误——
 * 用户没有发起任何动作，不该被一条红字打断。
 */
import { useEffect, useRef, useState } from "react";
import type { LatexFileContext, LatexProjectIndex, LatexProjectInfo } from "../../../../shared/latex.ts";
import { api } from "../../api.ts";

export function useLatexIndex(
  context: LatexFileContext | null,
  project: LatexProjectInfo | null,
): LatexProjectIndex | null {
  const [index, setIndex] = useState<LatexProjectIndex | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** 请求代次：换项目后晚到的响应不许覆盖新项目的结果 */
  const requestRef = useRef(0);

  const dir = project?.dir ?? null;
  const stamp = project?.sourceModifiedAt ?? null;

  useEffect(() => {
    if (dir === null) {
      requestRef.current += 1;
      setIndex(null);
      return;
    }
    const ctx = contextRef.current;
    if (ctx === null) return;
    const id = ++requestRef.current;
    void api.latex
      .index(ctx)
      .then((outcome) => {
        if (id !== requestRef.current) return;
        setIndex(outcome.found ? outcome.index : null);
      })
      .catch(() => {
        if (id !== requestRef.current) return;
        setIndex(null);
      });
  }, [dir, stamp]);

  return index;
}
