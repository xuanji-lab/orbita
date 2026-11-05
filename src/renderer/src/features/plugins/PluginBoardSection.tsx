/**
 * 详情长页的「看板样式」一节：缩小的看板（用数据，没有数据用样例）+ 每张卡一行
 * 「名字 · 尺寸 · 显示什么 · 样例」+ 看板说明（可展开）。「打开看板」在节标题行尾，由调用方给动作。
 * 同一份组件画已装的插件与「正在做」的草稿（看哪一块由 target 定）。
 */
import { useState } from "react";
import type { PluginBoardInfo } from "@shared/plugin-board";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";
import { BoardGrid } from "./BoardGrid.tsx";
import { boardRows, boardUnavailableText } from "./board-view.ts";
import { panelProblemText } from "./panel-view.ts";
import { useBoardFeed, type BoardTarget } from "./useBoardFeed.ts";

export function BoardStyleBody(props: { board: PluginBoardInfo; target: BoardTarget }) {
  const messages = useT();
  const t = messages.plugins;
  const p = messages.pluginPanel;
  const feed = useBoardFeed(props.target);
  const [specOpen, setSpecOpen] = useState(false);
  const rows = boardRows(props.board, feed.kind === "ready" ? feed.cards : []);
  const actionName = props.target.kind === "installed" ? props.target.name : null;
  return (
    <>
      <div className="pd-board">
        {feed.kind === "ready" ? (
          <div className="pd-board-grid">
            <BoardGrid cards={feed.cards} layout={{ mode: "container" }} actionName={actionName} />
          </div>
        ) : feed.kind === "loading" ? (
          <p className="pl-muted">{p.loading}</p>
        ) : (
          <div className="pl-note" role={feed.kind === "error" ? "alert" : "status"}>
            <Icon name="info" size={14} strokeWidth={1.8} />
            <span>{feed.kind === "error" ? feed.message : boardUnavailableText(p, feed.reason)}</span>
          </div>
        )}
        <div className="pd-blist">
          <p className="pd-bnote">{t.boardNote}</p>
          {rows.map((row) => (
            <div className="pd-bl" key={row.id}>
              <b>{row.title}</b>
              <span className="mono" title={t.boardSizes[row.size].name}>
                {t.boardSizes[row.size].short}
              </span>
              <span className="pd-bl-note">{row.note ?? t.boardNoNote}</span>
              {row.usingSample && (
                <span className="pd-bl-sample" title={p.sampleTip}>
                  {p.sample}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
      {feed.kind === "ready" && feed.problems.length > 0 && (
        <div className="pl-note warn" role="status">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <div style={{ display: "grid", gap: "var(--space-1)" }}>
            {feed.problems.map((problem, index) => (
              <span key={index}>{panelProblemText(p, problem)}</span>
            ))}
          </div>
        </div>
      )}
      {feed.kind === "ready" && feed.spec !== null && (
        <section className="pp-spec" data-open={specOpen}>
          <button type="button" className="pp-spec-h" aria-expanded={specOpen} onClick={() => setSpecOpen((open) => !open)}>
            <Icon name={specOpen ? "chevron-down" : "chevron-right"} size={14} strokeWidth={1.8} />
            <Icon name="list-todo" size={14} strokeWidth={1.8} />
            <b>{p.specTitle}</b>
          </button>
          {specOpen && (
            <div className="pp-spec-body scroll">
              <MarkdownBlock text={feed.spec} />
            </div>
          )}
        </section>
      )}
    </>
  );
}
