/**
 * 本机宏包名表的 renderer 侧：**一次取回、之后只读内存**。
 *
 * 名单在主进程扫一次 TeX 树（`package-names.ts`），这里只负责在项目打开时把它拿过来。
 * 三条约束：
 * - **不是按键级 IPC**：`\usepackage{` 每敲一个字都去问主进程，等于把一份几千条的表
 *   反复序列化；这里按「会话 + 工作区 + 根」取一次。
 * - **失败安静**：没有 TeX、通道失败都回空数组——补全退回「只补已加载的 `\usepackage`」，
 *   界面不出现「缺少工具」的提示（补全不是必须依赖 TeX 的功能）。
 * - **不是快照换编辑器**：返回值只是给补全 source 读的数组；名单晚到不会重建编辑器
 *   （重建会丢光标、撤销历史与滚动位置）。
 */
import { useEffect, useRef, useState } from "react";
import type { LatexFileContext, LatexProjectInfo } from "../../../../shared/latex.ts";
import { api } from "../../api.ts";

const NONE: readonly string[] = [];

export function useLatexPackageNames(
  context: LatexFileContext | null,
  project: LatexProjectInfo | null,
): readonly string[] {
  const [names, setNames] = useState<readonly string[]>(NONE);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** 已经问过的那个项目（同一个键只问一次；失败时留空，下次换项目再试） */
  const askedRef = useRef<string | null>(null);

  const key =
    context === null || project === null
      ? null
      : `${context.sessionId ?? ""}\u0000${context.workspaceId ?? ""}\u0000${context.root}`;

  useEffect(() => {
    if (key === null) {
      askedRef.current = null;
      setNames((current) => (current.length === 0 ? current : NONE));
      return;
    }
    if (askedRef.current === key) return;
    const ctx = contextRef.current;
    if (ctx === null) return;
    askedRef.current = key;
    let alive = true;
    void api.latex
      .packageNames(ctx)
      .then((outcome) => {
        if (!alive) return;
        setNames(outcome.available ? outcome.names : NONE);
      })
      .catch(() => {
        if (!alive) return;
        askedRef.current = null;
        setNames((current) => (current.length === 0 ? current : NONE));
      });
    return () => {
      alive = false;
    };
  }, [key]);

  return names;
}
