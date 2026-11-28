/**
 * 文件面板的多文件导航（`latex:nav`）：包含图 + 每个文件的章节。
 *
 * 两个读者共用这一次请求：编辑器的 Ctrl/Cmd+单击 跳转，与大纲的跨文件聚合。
 *
 * **什么时候重问**：与 useLatexIndex 同一条纪律——项目目录变了、项目里最新源码的
 * mtime 变了（`sourceModifiedAt`，含 .tex/.bib/.cls/.sty）、或当前文件变了（它决定
 * 「我在哪本书里」）。mtime 由 useLatexWorkbench 的 4 秒轮询驱动：agent 刚加的
 * `\input` 最多 4 秒后能点。
 *
 * 读不到（IPC 失败 / 白名单拒绝）时**静默**退回 null：大纲回到「只看当前文件」，
 * 不弹错误——用户没有发起任何动作，不该被一条红字打断。
 */
import { useEffect, useRef, useState } from "react";
import type { LatexFileContext, LatexNav, LatexProjectInfo } from "../../../../shared/latex.ts";
import { api } from "../../api.ts";

export function useLatexNav(
  context: LatexFileContext | null,
  project: LatexProjectInfo | null,
): LatexNav | null {
  const [nav, setNav] = useState<LatexNav | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** 请求代次：换项目后晚到的响应不许覆盖新项目的结果 */
  const requestRef = useRef(0);

  const dir = project?.dir ?? null;
  const stamp = project?.sourceModifiedAt ?? null;
  const path = context?.path ?? null;

  useEffect(() => {
    if (dir === null) {
      requestRef.current += 1;
      setNav(null);
      return;
    }
    const ctx = contextRef.current;
    if (ctx === null) return;
    const id = ++requestRef.current;
    void api.latex
      .nav(ctx)
      .then((outcome) => {
        if (id !== requestRef.current) return;
        setNav(outcome.found ? outcome.nav : null);
      })
      .catch(() => {
        if (id !== requestRef.current) return;
        setNav(null);
      });
  }, [dir, stamp, path]);

  return nav;
}
