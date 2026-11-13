/**
 * 文件面板的文献库：项目里所有 .bib 的合并视图（`cite:library`）。
 *
 * **什么时候重问**：项目目录变了（换了论文），或项目里最新源码的 mtime 变了
 * （`sourceModifiedAt` 含 .bib —— 用户 / agent 刚加完一条文献就该能引到）。后者由
 * `useLatexWorkbench` 的 4 秒轮询驱动，所以最多每 4 秒重扫一次，不会跟着每次自动保存
 * 连打——一次扫描是几个小文件的 readFileSync，代价远低于在 renderer 里缓存的复杂度。
 *
 * 读不到（IPC 失败 / 白名单拒绝）时**静默**退回空库：补全不弹，问题抽屉里不出假的
 * warning。真正要报告的失败是「某份 .bib 解析不了」，那条由主进程放进 `files`。
 */
import { useEffect, useRef, useState } from "react";
import type { CiteLibrary } from "../../../../shared/cite.ts";
import type { LatexFileContext, LatexProjectInfo } from "../../../../shared/latex.ts";
import { api } from "../../api.ts";

export function useCiteLibrary(
  context: LatexFileContext | null,
  project: LatexProjectInfo | null,
): CiteLibrary | null {
  const [library, setLibrary] = useState<CiteLibrary | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** 请求代次：换项目后晚到的响应不许覆盖新项目的结果 */
  const requestRef = useRef(0);

  const dir = project?.dir ?? null;
  const stamp = project?.sourceModifiedAt ?? null;

  useEffect(() => {
    if (dir === null) {
      requestRef.current += 1;
      setLibrary(null);
      return;
    }
    const ctx = contextRef.current;
    if (ctx === null) return;
    const id = ++requestRef.current;
    void api.cite
      .library(ctx)
      .then((outcome) => {
        if (id !== requestRef.current) return;
        setLibrary(outcome.found ? outcome.library : null);
      })
      .catch(() => {
        if (id !== requestRef.current) return;
        setLibrary(null);
      });
  }, [dir, stamp]);

  return library;
}
