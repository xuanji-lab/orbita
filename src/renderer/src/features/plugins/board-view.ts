/**
 * 看板在界面里的纯逻辑：详情页「每卡一行」怎么由清单声明 + 活卡拼出来、看板出不来时怎么说。
 * 单独成文件只为可测（`node --test` 只加载 .ts）。
 */
import type { PluginBoardCardDecl, PluginBoardInfo } from "../../../../shared/plugin-board.ts";
import type { PluginPanelUnavailable } from "../../../../shared/plugin-panel.ts";
import type { Messages } from "../../messages-en.ts";
import type { BoardCardView } from "./board-card.ts";

export interface BoardRow {
  id: string;
  title: string;
  size: PluginBoardCardDecl["size"];
  note: string | null;
  /** 这张声明展开出的卡里有没有用样例的（repeat 的多张只要有一张是样例就标） */
  usingSample: boolean;
}

/** 每张声明一行（repeat 展开的多张合成一行）；「样例」标取自活卡，还没读到活卡就不标。 */
export function boardRows(board: PluginBoardInfo, live: readonly BoardCardView[]): BoardRow[] {
  return board.cards.map((decl) => ({
    id: decl.id,
    title: decl.title,
    size: decl.size,
    note: decl.note,
    usingSample: live.some((card) => card.id === decl.id && card.usingSample),
  }));
}

/** 看板出不来的原因 → 一句话（详情页「看板样式」与看板视图共用）。 */
export function boardUnavailableText(t: Messages["pluginPanel"], reason: PluginPanelUnavailable): string {
  return t.unavailable[reason];
}
