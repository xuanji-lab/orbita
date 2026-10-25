/**
 * 问题抽屉 —— 文件面板底部一行「问题 / 无问题」，点开列出本次编译的问题。
 *
 * 默认收起（安静态只有一行）；用户自己点的编译失败时由 FilesPanel 自动展开——
 * 失败要看得见，但不占常驻高度。每行「文件:行 + 消息」，缺宏包单列一类并给它
 * 自己的动作（在终端安装）；每条都能「交给 agent」（进输入框的引用，不直接发送）。
 * 版式提示（Overfull）默认排最后、退灰：真实论文几乎每篇都有，不该抢错误的视线。
 */
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import type { LatexIssue } from "@shared/latex";
import {
  installCommand,
  issueLocation,
  type LatexIssueGroups,
  type MissingPackage,
} from "./latex-workbench.ts";

/** 交给 agent 时的分类：决定引用里的前缀文案 */
export type ProblemLevel = "error" | "warning" | "layout" | "package";

export type ProblemItem = { level: ProblemLevel; file: string | null; line: number | null; message: string };

export function LatexProblems(props: {
  groups: LatexIssueGroups;
  open: boolean;
  onToggle: () => void;
  onHandToAgent: (item: ProblemItem) => void;
  /** 把 tlmgr 命令填进可见终端（不按回车） */
  onInstall: (command: string) => void;
}) {
  const t = useT();
  const { groups } = props;
  const total = groups.errorCount + groups.warningCount + groups.layout.length;
  const rows: { item: ProblemItem; packageName?: string }[] = [
    ...groups.packages.map((item) => ({ item: toItem(item, "package"), packageName: item.packageName })),
    ...groups.errors.map((item) => ({ item: toItem(item, "error") })),
    ...groups.warnings.map((item) => ({ item: toItem(item, "warning") })),
    ...groups.layout.map((item) => ({ item: toItem(item, "layout") })),
  ];

  return (
    <div className="latex-problems" data-open={props.open ? "true" : undefined}>
      <button
        type="button"
        className="latex-problems-head quiet-control"
        aria-expanded={total === 0 ? undefined : props.open}
        disabled={total === 0}
        onClick={props.onToggle}
      >
        <Icon name="circle-help" size={14} />
        <span>{t.latex.problems}</span>
        <span className="row-trailing latex-problem-counts">
          {total === 0 ? (
            <>
              <Icon name="circle-check" size={12} style={{ color: "var(--color-success)" }} />
              {t.latex.noProblems}
            </>
          ) : (
            <>
              {groups.errorCount > 0 && (
                <span className="latex-count err">
                  <Icon name="octagon-x" size={12} style={{ color: "var(--color-danger)" }} />
                  {t.latex.errorCount(groups.errorCount)}
                </span>
              )}
              {groups.warningCount > 0 && (
                <span className="latex-count warn">
                  <Icon name="triangle-alert" size={12} style={{ color: "var(--color-warning)" }} />
                  {t.latex.warningCount(groups.warningCount)}
                </span>
              )}
              <Icon name={props.open ? "chevron-down" : "chevron-up"} size={12} />
            </>
          )}
        </span>
      </button>
      {props.open && total > 0 && (
        <div className="latex-problem-list">
          {rows.map(({ item, packageName }) => (
            <div
              key={`${item.level}:${item.file ?? ""}:${item.line ?? 0}:${item.message}:${packageName ?? ""}`}
              className="latex-problem"
              data-level={item.level}
            >
              <Icon name={iconOf(item.level)} size={13} style={{ color: tintOf(item.level) }} />
              <span className="latex-problem-loc mono">{issueLocation(item)}</span>
              <span className="latex-problem-msg" title={item.message}>
                {item.level === "package" && packageName !== undefined
                  ? t.latex.missingPackage(packageName)
                  : item.message}
              </span>
              <span className="row-trailing latex-problem-acts">
                {packageName !== undefined && (
                  <button
                    type="button"
                    className="quiet-control latex-problem-act"
                    title={t.latex.installTip(installCommand(packageName))}
                    onClick={() => props.onInstall(installCommand(packageName))}
                  >
                    <Icon name="square-terminal" size={12} />
                    {t.latex.installInTerminal}
                  </button>
                )}
                <button
                  type="button"
                  className="quiet-control latex-problem-act"
                  title={t.latex.handToAgentTip}
                  onClick={() => props.onHandToAgent(item)}
                >
                  <Icon name="bot" size={12} />
                  {t.latex.handToAgent}
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function toItem(issue: LatexIssue | MissingPackage, level: ProblemLevel): ProblemItem {
  // MissingPackage 有 message / file / line，与 LatexIssue 同形（多一个 packageName）
  return { level, file: issue.file, line: issue.line, message: issue.message };
}

function iconOf(level: ProblemLevel): "octagon-x" | "triangle-alert" | "download" | "info" {
  if (level === "package") return "download";
  if (level === "error") return "octagon-x";
  if (level === "warning") return "triangle-alert";
  return "info";
}

function tintOf(level: ProblemLevel): string {
  if (level === "package" || level === "error") return "var(--color-danger)";
  if (level === "warning" || level === "layout") return "var(--color-warning)";
  return "var(--color-text-tertiary)";
}
