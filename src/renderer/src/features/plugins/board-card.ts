/**
 * 一张要画的卡（展开后的；数据已取舍好）与「快照 → 卡视图」的合并（纯函数，单独成文件只为可测）。
 * 实时卡（插件看板轮询）与会话快照卡都归到 `BoardCardView` 这个形状，BoardGrid 不关心数据哪来的。
 */
import type { BoardCardSize } from "../../../../shared/plugin-board.ts";
import type { PluginBoardCardLive, PluginPanelData, PluginPanelDataProblem, PluginPanelProblem } from "../../../../shared/plugin-panel.ts";
import { reduceShownData, type ShownData } from "./panel-view.ts";

/** 每张卡 iframe 的 sandbox 属性：只给脚本（不给 allow-same-origin / top-navigation / popups / forms / modals / downloads；测试把它钉死）。 */
export const CARD_IFRAME_SANDBOX = "allow-scripts";

export interface BoardCardView {
  /** 整块看板内唯一；换了 key 整张卡重建 */
  key: string;
  id: string;
  title: string;
  size: BoardCardSize;
  /** repeat 的第几项；普通卡 0 */
  index: number;
  /** iframe 地址（一次性）；null = 画不出模板（出问题 / 还没拿到） */
  frameUrl: string | null;
  /** 换了就重建 iframe（模板换了） */
  frameKey: number;
  /** 这张卡出不来的原因（模板 / 数据路径）；null = 没问题。有值时框里写原因、不渲染 iframe */
  brokenProblems: readonly PluginPanelProblem[] | null;
  /** 发给模板的那份（读不出来时是上一份好的，没有就空） */
  shown: PluginPanelData;
  /** 此刻数据读不出来的原因；null = 读得出来 */
  problem: PluginPanelDataProblem | null;
  /** 显示的是样例数据：框上标「样例」 */
  usingSample: boolean;
}

/** 一张卡此刻在 renderer 手里的东西：iframe 地址（一次性，换了才重建）与上一份好的数据。 */
export interface CardMemory {
  frameUrl: string | null;
  frameKey: number;
  lastGood: ShownData["lastGood"];
}

/**
 * 把一份快照并进 renderer 手里的记忆，给出每张卡的视图（纯函数，带测试）。
 * - `frameUrl` 非 null = 这张卡的模板是新的：换 iframe（frameKey 递增）；null = 沿用手里的，只更新数据；
 * - 数据读不出来时留着上一份好的（`reduceShownData`），问题条说明原因；
 * - 快照里没有的卡（展开的项变少、声明删了）的记忆随之丢掉。
 */
export function mergeBoardCards(
  memory: ReadonlyMap<string, CardMemory>,
  cards: readonly PluginBoardCardLive[],
  nextFrameKey: () => number,
): { views: BoardCardView[]; memory: Map<string, CardMemory> } {
  const kept = new Map<string, CardMemory>();
  const views: BoardCardView[] = [];
  for (const card of cards) {
    const before = memory.get(card.key);
    const next = reduceShownData(before?.lastGood ?? null, card.data);
    let frameUrl = before?.frameUrl ?? null;
    let frameKey = before?.frameKey ?? 0;
    if (card.broken) frameUrl = null;
    else if (card.frameUrl !== null) {
      frameUrl = card.frameUrl;
      frameKey = nextFrameKey();
    }
    kept.set(card.key, { frameUrl, frameKey, lastGood: next.lastGood });
    views.push({
      key: card.key,
      id: card.id,
      title: card.title,
      size: card.size,
      index: card.index,
      frameUrl,
      frameKey,
      brokenProblems: card.broken ? card.problems : null,
      shown: next.shown,
      problem: next.problem,
      usingSample: card.usingSample,
    });
  }
  return { views, memory: kept };
}

