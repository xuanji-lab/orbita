/**
 * 文件面板的文献库：项目里所有 .bib 的合并视图（`cite:library`）+ 「未使用的文献」。
 *
 * **什么时候重问**：项目目录变了（换了论文）、当前 root 换了（未使用清单跟 root 的
 * 包含闭包走），或项目里最新源码的 mtime 变了（`sourceModifiedAt` 含 .bib —— 用户 /
 * agent 刚加完一条文献就该能引到）。后者由 `useLatexWorkbench` 的 4 秒轮询驱动，
 * 所以最多每 4 秒重扫一次，不会跟着每次自动保存连打——一次扫描是几个小文件的
 * readFileSync，代价远低于在 renderer 里缓存的复杂度。
 *
 * 读不到（IPC 失败 / 白名单拒绝）时**静默**退回空库：补全不弹，问题抽屉里不出假的
 * warning。真正要报告的失败是「某份 .bib 解析不了」，那条由主进程放进 `files`。
 */
import { useEffect, useRef, useState } from "react";
import type { CiteLibrary, CiteUnusedReport } from "../../../../shared/cite.ts";
import type { LatexFileContext, LatexProjectInfo } from "../../../../shared/latex.ts";
import { api } from "../../api.ts";

/** 一次读库的完整事实：文献库本体 + 未使用清单（都从同一个 IPC 回执来） */
export interface CiteLibraryState {
  library: CiteLibrary;
  unused: CiteUnusedReport;
}

export function useCiteLibrary(
  context: LatexFileContext | null,
  project: LatexProjectInfo | null,
): CiteLibraryState | null {
  const [state, setState] = useState<CiteLibraryState | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** 请求代次：换项目后晚到的响应不许覆盖新项目的结果 */
  const requestRef = useRef(0);

  const dir = project?.dir ?? null;
  const stamp = project?.sourceModifiedAt ?? null;
  // root 换了，闭包就换了：未使用清单必须重算（同一份源码 mtime 没变也一样）
  const root = project?.activeRoot ?? project?.main ?? null;

  useEffect(() => {
    if (dir === null) {
      requestRef.current += 1;
      setState(null);
      return;
    }
    const ctx = contextRef.current;
    if (ctx === null) return;
    const id = ++requestRef.current;
    void api.cite
      .library(ctx)
      .then((outcome) => {
        if (id !== requestRef.current) return;
        setState(outcome.found ? { library: outcome.library, unused: outcome.unused } : null);
      })
      .catch(() => {
        if (id !== requestRef.current) return;
        setState(null);
      });
  }, [dir, stamp, root]);

  return state;
}
