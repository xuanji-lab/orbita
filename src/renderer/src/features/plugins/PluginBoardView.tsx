/**
 * 看板视图：右栏里点详情的「打开看板」进入，BoardGrid（容器模式）占满右栏宽度，随右栏拖宽等比缩放。
 * 返回回到详情（页头的返回键由 PluginsView 画在右栏胶囊里）。已装的插件与「正在做」的草稿共用。
 */
import { useState } from "react";
import { useT } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { MarkdownBlock } from "../chat/MarkdownBlock.tsx";
import { BoardGrid } from "./BoardGrid.tsx";
import { boardUnavailableText } from "./board-view.ts";
import { panelProblemText } from "./panel-view.ts";
import { useBoardFeed, type BoardTarget } from "./useBoardFeed.ts";

export function PluginBoardView(props: { target: BoardTarget }) {
  const messages = useT();
  const p = messages.pluginPanel;
  const feed = useBoardFeed(props.target);
  const [specOpen, setSpecOpen] = useState(false);
  return (
    <div className="pl-boardview">
      {feed.kind === "loading" && <p className="pl-empty">{p.loading}</p>}
      {feed.kind === "error" && (
        <div className="pl-note danger" role="alert">
          <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
          <span>{feed.message}</span>
        </div>
      )}
      {feed.kind === "unavailable" && (
        <div className="pl-note" role="status">
          <Icon name="info" size={14} strokeWidth={1.8} />
          <div style={{ display: "grid", gap: "var(--space-1)" }}>
            <b>{p.unavailableTitle}</b>
            <span>{boardUnavailableText(p, feed.reason)}</span>
          </div>
        </div>
      )}
      {feed.kind === "ready" && (
        <>
          <BoardGrid cards={feed.cards} layout={{ mode: "container" }} actionName={props.target.kind === "installed" ? props.target.name : null} />
          {feed.problems.length > 0 && (
            <div className="pl-note warn" role="status">
              <Icon name="triangle-alert" size={14} strokeWidth={1.8} />
              <div style={{ display: "grid", gap: "var(--space-1)" }}>
                {feed.problems.map((problem, index) => (
                  <span key={index}>{panelProblemText(p, problem)}</span>
                ))}
              </div>
            </div>
          )}
          {feed.spec !== null && (
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
      )}
    </div>
  );
}
