/**
 * 文档大纲抽屉（`.tex` 编辑器右侧）—— 章节树，点击跳到该行。
 *
 * 只在大纲里放章节（`\part` … `\subparagraph`）：论文的结构就是章节，label 与浮动体
 * 属于 `\ref` 补全与重复检测。当前光标所在的那一节高亮，滚动长论文时知道自己在哪。
 *
 * 抽屉是**并排**而不是浮层：右栏本来就窄，浮层会盖住正在读的源码；并排时大纲只有
 * 240px，正文自己让出位置，点一行就滚到位。层级靠缩进，不靠字号（设计系统：一张卡
 * 至多三档字号，层级先靠字重与颜色）。
 */
import { useEffect, useRef } from "react";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import type { OutlineEntry } from "./latex-outline.ts";

export function TexOutline(props: {
  entries: readonly OutlineEntry[];
  /** 光标所在条目的下标；-1 = 在第一节之前 */
  active: number;
  onJump: (line: number) => void;
  onClose: () => void;
}) {
  const t = useT();
  const listRef = useRef<HTMLDivElement | null>(null);

  // 光标移动 / 重开时把当前节滚进视野（大纲可能比抽屉长）
  useEffect(() => {
    const list = listRef.current;
    if (list === null || props.active < 0) return;
    const row = list.querySelector<HTMLElement>(`[data-index="${props.active}"]`);
    row?.scrollIntoView({ block: "nearest" });
  }, [props.active]);

  return (
    <aside className="tex-outline" aria-label={t.editor.outline}>
      <div className="tex-outline-head">
        <Icon name="list-tree" size={13} className="tex-outline-icon" />
        <span className="tex-outline-title">{t.editor.outline}</span>
        <span className="row-trailing">
          <button
            type="button"
            className="quiet-control tex-outline-close"
            title={t.editor.outlineClose}
            aria-label={t.editor.outlineClose}
            onClick={props.onClose}
          >
            <Icon name="x" size={13} strokeWidth={2} />
          </button>
        </span>
      </div>
      {props.entries.length === 0 ? (
        <p className="tex-outline-empty">{t.editor.outlineEmpty}</p>
      ) : (
        <div className="tex-outline-list panel-list" ref={listRef}>
          {props.entries.map((entry, index) => (
            <button
              type="button"
              key={`${index}:${entry.line}`}
              data-index={index}
              data-active={index === props.active ? "true" : undefined}
              className="tex-outline-row"
              style={{ paddingLeft: `calc(var(--space-2) + ${String(entry.level)} * 0.85em)` }}
              title={`${t.editor.outlineLine(entry.line)} · \\${entry.command}`}
              onClick={() => props.onJump(entry.line)}
            >
              <span className="tex-outline-text">{entry.title}</span>
              <span className="row-trailing tex-outline-line mono">{entry.line}</span>
            </button>
          ))}
        </div>
      )}
    </aside>
  );
}
