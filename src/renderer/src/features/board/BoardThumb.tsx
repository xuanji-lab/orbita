/**
 * 状态卡产物里的「看板」缩略图：画**最后一次成功的 show_plugin_board 那份快照的第一张卡**，缩小显示。
 * 复用看板已有的快照渲染（`useSnapshotCards` + `BoardGrid` 列模式），不另起一套：卡按固定的一格宽排版（与对话里
 * 同样的字号取舍），再整块 CSS 缩放进缩略框（等比、居中、不裁）。
 *
 * iframe 的开销（每张约 3 MB）控制：
 * - 只挂一张卡；
 * - 缩略图不在视口里（状态卡收起、滚出面板、横向条里滑出去）就卸掉 iframe，只留图标——同对话里看板结果「离开视口卸 iframe」的思路；
 * - 缩略图只是看的：整块 `inert` + 不吃指针，点击落在外面那颗按钮上（滚回对话里那次结果）。
 */
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { boardCardSpan } from "@shared/plugin-board";
import { Icon } from "../../shell/Icon";
import { FEATURE_ICON } from "../../shell/feature-icons.ts";
import { BoardGrid } from "../plugins/BoardGrid.tsx";
import { cardBox, columnLayout } from "../plugins/board-layout.ts";
import { thumbCardOf, type BoardCall } from "../context/chat-status.ts";
import { useSnapshotCards, type SnapshotCardInput } from "./useSnapshotCards.ts";

/** 缩略图里卡按多宽的一格排版（像素）：与对话里一张卡的量级相当，模板据此取字号，缩小后仍是同一个版面 */
export const THUMB_CELL_WIDTH = 280;

export function BoardThumb(props: { call: BoardCall }) {
  const { call } = props;
  const card = thumbCardOf(call.result);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [visible, setVisible] = useState(false);

  // 量缩略框的大小（等比缩放用）
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const measure = (): void => setSize({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  // 在不在视口里（祖先的 overflow 裁剪也算）：不在就卸 iframe
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((entry) => entry.isIntersecting)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const live = card !== null && visible && size.width > 0 && size.height > 0;
  return (
    <div className="cs-board-thumb" ref={hostRef}>
      {!live && (
        <div className="cs-thumb-icon">
          <Icon name={FEATURE_ICON.board} size={32} strokeWidth={1.4} />
        </div>
      )}
      {live && <ThumbStage call={call} cardId={card.id} cardIndex={card.index} width={size.width} height={size.height} />}
    </div>
  );
}

/** 挂着的那一张卡：按固定一格宽排版，整块缩放进缩略框（挂载时才换 iframe 地址，卸载即丢） */
function ThumbStage(props: { call: BoardCall; cardId: string; cardIndex: number; width: number; height: number }) {
  const { call, cardId, cardIndex } = props;
  const snapshot = useMemo(() => call.result.cards.find((item) => item.id === cardId && item.index === cardIndex) ?? null, [call, cardId, cardIndex]);
  const inputs = useMemo<SnapshotCardInput[]>(
    () => (snapshot === null ? [] : [{ key: `thumb:${call.toolCallId}:${snapshot.id}:${snapshot.index}`, snapshot, at: call.result.at }]),
    [call, snapshot],
  );
  const { cards, refresh } = useSnapshotCards(inputs);
  if (snapshot === null) return null;
  const cols = Math.min(boardCardSpan(snapshot.size).cols, 2) as 1 | 2;
  const layout = columnLayout({ cellWidth: THUMB_CELL_WIDTH, columns: cols });
  const box = cardBox(layout, snapshot.size);
  const scale = Math.min(props.width / box.width, props.height / box.height);
  return (
    <div className="cs-board-stage" style={{ width: box.width, height: box.height, transform: `translate(-50%, -50%) scale(${scale})` }} inert>
      <BoardGrid cards={cards} layout={{ mode: "column", cellWidth: THUMB_CELL_WIDTH, columns: cols }} actionName={null} onFrameStale={refresh} />
    </div>
  );
}
