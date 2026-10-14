import { Fragment, type ReactNode } from "react";
import type { EditDiffEntry, IntraToken } from "../features/chat/tool-results";

/**
 * DiffBody —— 行号列 + 整行 soft 底色 + 词级高亮的 diff 正文（ChatView 的 DiffView
 * 与审查面板共用的一层，视觉规格见原 DiffView 的注释：增/上下文行带新文档行号、
 * 删行带旧行号、相邻一删一增做词级对比）。输入是 editDiffEntries 的产物
 * （EditDiffEntry[]）——pi 的展示格式与 unified diff 都先归一到它（后者在
 * review-panel.ts 里做 DiffRow → EditDiffRow 的映射），这一层不关心 diff 从哪来。
 */

/** 行号列（DiffView 与 FileContentView 共用）：右对齐等宽数字、细分隔线、褪色——只作定位不作内容 */
const LINE_NUM_COLUMN = {
  textAlign: "right",
  padding: "0 var(--space-2) 0 var(--space-1)",
  borderRight: "1px solid var(--color-border-subtle)",
  color: "var(--color-text-tertiary)",
  opacity: 0.7,
  fontVariantNumeric: "tabular-nums",
} satisfies React.CSSProperties;

/** diff 行两列 grid：行号（gutter）| 正文。深浅三级：改动行正文 primary（第一眼）>
 * 上下文正文 secondary > 行号（tertiary 再降不透明度）；增删整行淡底色 */
function DiffRow(props: { kind: "add" | "del" | "ctx"; lineNum: string; children: ReactNode }) {
  const { kind } = props;
  return (
    <div
      style={{
        display: "grid",
        // 轨道要连 LINE_NUM_COLUMN 的横向内边距一起算进去，否则三位数行号顶穿竖线挤进正文
        gridTemplateColumns: "calc(4ch + var(--space-2) + var(--space-1)) 1fr",
        background:
          kind === "add"
            ? "var(--color-success-soft)"
            : kind === "del"
              ? "var(--color-danger-soft)"
              : undefined,
      }}
    >
      <span style={LINE_NUM_COLUMN}>{props.lineNum}</span>
      <span
        style={{
          padding: "0 var(--space-2) 0 var(--space-2)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          color: kind === "ctx" ? "var(--color-text-secondary)" : "var(--color-text-primary)",
        }}
      >
        {props.children}
      </span>
    </div>
  );
}

/** 词级对比 token → span；changed 片段按角色加底（pi inverse 的 DOM 等价物） */
function intraSpans(tokens: readonly IntraToken[], kind: "del" | "add") {
  return tokens.map((token, index) =>
    token.changed ? (
      <span
        key={index}
        style={{
          backgroundColor: kind === "add" ? "var(--color-success)" : "var(--color-danger)",
          color: "var(--color-bg-panel)",
          borderRadius: 2,
        }}
      >
        {token.text}
      </span>
    ) : (
      <span key={index}>{token.text}</span>
    ),
  );
}

/** diff 正文。maxHeight 由调用方给（聊天内的 320 / 面板内自己算）。 */
export function DiffBody(props: { entries: readonly EditDiffEntry[]; maxHeight?: number }) {
  return (
    <div
      className="scroll"
      style={{
        maxHeight: props.maxHeight ?? 320,
        overflow: "auto",
        fontFamily: "var(--font-family-mono)",
        fontSize: "var(--font-size-sm)",
        lineHeight: "var(--line-height-code)",
      }}
    >
      {props.entries.map((entry, index) =>
        entry.kind === "pair" ? (
          <Fragment key={index}>
            <DiffRow kind="del" lineNum={entry.removed.lineNum}>
              {intraSpans(entry.tokens.removed, "del")}
            </DiffRow>
            <DiffRow kind="add" lineNum={entry.added.lineNum}>
              {intraSpans(entry.tokens.added, "add")}
            </DiffRow>
          </Fragment>
        ) : (
          <DiffRow key={index} kind={entry.row.kind} lineNum={entry.row.lineNum}>
            {entry.row.text === "" ? " " : entry.row.text}
          </DiffRow>
        ),
      )}
    </div>
  );
}
