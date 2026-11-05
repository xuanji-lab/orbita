/**
 * 对话里 `show_plugin_board` 的结果：一块看板（BoardGrid 容器模式，宽 = 对话列宽），每张卡按**快照**画——
 * 模板用哈希换（`board:frame`），数据是调用那一刻的快照，所以重开会话、插件的模板后来改了，卡还是当时的样子。
 * 卡里的按钮照常可点：动作写进插件数据目录的 actions.jsonl（草稿还没装，不记）。
 * 被跳过的卡（数据太大、模板读不出来……）在卡下面一行灰字说明。
 */
import { useMemo } from "react";
import type { PluginBoardResult as PluginBoardSnapshotResult } from "../../../../shared/plugin-board.ts";
import { useT } from "../../locale.ts";
import { BoardGrid } from "../plugins/BoardGrid.tsx";
import { skippedText } from "./board-text.ts";
import { useSnapshotCards, type SnapshotCardInput } from "./useSnapshotCards.ts";
import "./board.css";

export function PluginBoardResultView(props: { toolCallId: string; board: PluginBoardSnapshotResult }) {
  const t = useT().board;
  const { board, toolCallId } = props;
  const inputs = useMemo<SnapshotCardInput[]>(
    () => board.cards.map((snapshot) => ({ key: `${toolCallId}:${snapshot.id}:${snapshot.index}`, snapshot, at: board.at })),
    [board, toolCallId],
  );
  const cards = useSnapshotCards(inputs);
  const skipped = skippedText(t, board.skipped);
  return (
    <div className="board-result" data-source={board.source}>
      {cards.length > 0 && <BoardGrid cards={cards} layout={{ mode: "container" }} actionName={board.source === "installed" ? board.plugin : null} />}
      {skipped !== null && <p className="board-result-note">{skipped}</p>}
    </div>
  );
}
