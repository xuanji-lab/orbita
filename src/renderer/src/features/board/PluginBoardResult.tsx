/**
 * 对话里 `show_plugin_board` 的结果：一块看板（BoardGrid 容器模式，宽 = 对话列宽），每张卡按**快照**画——
 * 模板用哈希换（`board:frame`），数据是调用那一刻的快照，所以重开会话、插件的模板后来改了，卡还是当时的样子。
 * 卡里的按钮照常可点：动作写进插件数据目录的 actions.jsonl（草稿还没装，不记）。
 * 被跳过的卡（数据太大、模板读不出来……）在卡下面一行灰字说明。
 *
 * **离开视口约一屏就卸掉 iframe，只留同高占位**：每张卡是一只沙箱 iframe（约 3 MB），对话没有虚拟化，
 * 长会话里反复展示看板会一直累积（20 次 × 4 张 = 80 只 ≈ 237 MB，实测）。占位高度由卡的尺寸与量到的宽度
 * 算出（`gridHeight`，与真实排版一致），所以卸 / 挂都不会让对话滚动跳动；回到视口再挂、重新换一次性地址。
 * 与周看板挂载「可视 ± 1 天」同一思路。
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PluginBoardResult as PluginBoardSnapshotResult } from "../../../../shared/plugin-board.ts";
import { useT } from "../../locale.ts";
import { BoardGrid } from "../plugins/BoardGrid.tsx";
import { containerLayout, gridHeight } from "../plugins/board-layout.ts";
import { skippedText } from "./board-text.ts";
import { useSnapshotCards, type SnapshotCardInput } from "./useSnapshotCards.ts";
import "./board.css";

/** 视口上下各多算一屏（根的高度的 100%）：这个范围里的看板挂 iframe，之外只留占位 */
const NEAR_MARGIN = "100% 0px";
/** 对话的滚动容器；找不到（别处复用）就按浏览器视口 */
const SCROLL_ROOT = ".chat-transcript";

export function PluginBoardResultView(props: { toolCallId: string; board: PluginBoardSnapshotResult }) {
  const t = useT().board;
  const { board, toolCallId } = props;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [near, setNear] = useState(false);

  // 量自己的宽度（layout effect：占位在第一帧画出来之前就有对的高度）
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    setWidth(host.clientWidth);
    const observer = new ResizeObserver(() => setWidth(host.clientWidth));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  // 在不在视口附近
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const root = host.closest(SCROLL_ROOT);
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { root, rootMargin: NEAR_MARGIN });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const placeholderHeight = useMemo(
    () => gridHeight(containerLayout(width), board.cards.map((card) => card.size)),
    [width, board.cards],
  );
  const skipped = skippedText(t, board.skipped);
  const live = near && board.cards.length > 0;
  return (
    <div className="board-result" data-source={board.source} data-live={live} ref={hostRef}>
      {live ? (
        <LiveBoard toolCallId={toolCallId} board={board} />
      ) : (
        board.cards.length > 0 && <div className="board-placeholder" style={{ height: placeholderHeight }} aria-hidden="true" />
      )}
      {skipped !== null && <p className="board-result-note">{skipped}</p>}
    </div>
  );
}

/** 挂着的看板：换地址的 hook 在这里——卸载即丢掉已用掉的一次性地址，再挂载重新换 */
function LiveBoard(props: { toolCallId: string; board: PluginBoardSnapshotResult }) {
  const { board, toolCallId } = props;
  const inputs = useMemo<SnapshotCardInput[]>(
    () => board.cards.map((snapshot) => ({ key: `${toolCallId}:${snapshot.id}:${snapshot.index}`, snapshot, at: board.at })),
    [board, toolCallId],
  );
  const { cards, refresh } = useSnapshotCards(inputs);
  return (
    <BoardGrid cards={cards} layout={{ mode: "container" }} actionName={board.source === "installed" ? board.plugin : null} onFrameStale={refresh} />
  );
}
