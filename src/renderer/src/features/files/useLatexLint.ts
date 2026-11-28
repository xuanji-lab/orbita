/**
 * chktex 风格检查的 renderer 侧：**什么时候问、问哪个文件**。
 *
 * 触发点是**保存成功**（`revision` 是保存成功的次数，由文件面板递增），不是轮询：
 * 以前靠项目描述里 4 秒一变的 `sourceModifiedAt` 驱动，结果是「保存后要等几秒才有
 * 波浪线」+ 没保存也每 4 秒空转一次。现在：
 *
 * - 打开 .tex 时问一次（存量问题立刻可见，不算轮询）；
 * - 之后每保存成功一次问一次，300ms 去抖 —— 连续保存只跑最后一次
 *   （节奏逻辑在 latex-lint-trigger.ts，有测试）；
 * - 保存被取消 / 文本没变时不会走到这里（编辑器的 `onSaved` 只在真的写盘成功后触发）；
 * - 本机没有 chktex 时主进程回 `available:false`，同一个项目里不再问第二次。
 *
 * 只对当前打开的那个 `.tex` 跑：chktex 的检查是文件级的，对项目里每个文件都跑一轮
 * 是另一件事（也慢得多）。
 */
import { useEffect, useRef, useState } from "react";
import type { LatexFileContext, LatexIssue, LatexProjectInfo } from "../../../../shared/latex.ts";
import { api } from "../../api.ts";
import { createLintScheduler, type LintScheduler } from "./latex-lint-trigger.ts";

export function useLatexLint(
  context: LatexFileContext | null,
  project: LatexProjectInfo | null,
  /** 保存成功的次数：每次写完盘由文件面板加一（0 = 这次打开还没保存过） */
  revision: number,
): readonly LatexIssue[] {
  const [issues, setIssues] = useState<readonly LatexIssue[]>([]);
  /** 本机有没有 chktex：只知道「有」之后才继续问；null = 还没问过 */
  const availableRef = useRef<boolean | null>(null);
  const contextRef = useRef(context);
  contextRef.current = context;
  /** 请求代次：换文件 / 换项目后晚到的结果不许覆盖新的 */
  const requestRef = useRef(0);
  const schedulerRef = useRef<LintScheduler | null>(null);

  const path = context?.path ?? null;
  const dir = project?.dir ?? null;
  const isTex = path !== null && /\.tex$/i.test(path);

  // 换项目：允许重新探测一次（用户可能刚装了 chktex / 换了 TeX 树）。
  // 「没有」只在同一个项目里缓存——那是「这台机器上没有」，不必每次保存都再问一遍
  useEffect(() => {
    availableRef.current = null;
  }, [dir]);

  useEffect(() => {
    schedulerRef.current?.dispose();
    schedulerRef.current = null;
    requestRef.current += 1;

    if (path === null || dir === null || !isTex) {
      setIssues((current) => (current.length === 0 ? current : []));
      return;
    }

    const scheduler = createLintScheduler(() => {
      const ctx = contextRef.current;
      if (ctx === null || availableRef.current === false) return;
      const id = ++requestRef.current;
      return api.latex
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
    });
    schedulerRef.current = scheduler;
    // 打开文件先问一次（不是轮询）：之后只在保存成功时由 revision 触发
    scheduler.request(0);
    return () => {
      scheduler.dispose();
      if (schedulerRef.current === scheduler) schedulerRef.current = null;
    };
  }, [path, dir, isTex]);

  // 保存成功 → 排一次检查（去抖在调度器里：连续保存只跑最后一次）
  useEffect(() => {
    if (revision <= 0) return;
    schedulerRef.current?.request();
  }, [revision]);

  return issues;
}
