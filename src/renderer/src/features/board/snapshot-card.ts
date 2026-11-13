/**
 * 会话快照里的一张卡 → BoardGrid 吃的 `BoardCardView`（纯函数，单独成文件只为可测）。
 *
 * 快照卡的模板在 `<userData>/board-templates/<hash>.html`（主进程按内容哈希存的，插件以后改了模板也还在），
 * iframe 地址要用哈希向主进程换（`board:frame`，一次性，每次挂 iframe 都要重新换一个）；
 * 数据是快照当时发给模板的那一份，不再读插件目录。
 */
import type { BoardCardSnapshot } from "../../../../shared/plugin-board.ts";
import type { BoardCardView } from "../plugins/board-card.ts";

/** 一张快照卡此刻拿地址的进度：还在等 / 拿到了 / 仓库里没有这份模板 */
export type FrameState = { kind: "pending" } | { kind: "ready"; frameUrl: string; frameKey: number } | { kind: "missing" };

export function snapshotCardView(key: string, snapshot: BoardCardSnapshot, frame: FrameState, fallbackUpdatedAt: number): BoardCardView {
  return {
    key,
    id: snapshot.id,
    title: snapshot.title,
    size: snapshot.size,
    index: snapshot.index,
    frameUrl: frame.kind === "ready" ? frame.frameUrl : null,
    frameKey: frame.kind === "ready" ? frame.frameKey : 0,
    brokenProblems: frame.kind === "missing" ? [{ kind: "template-missing", detail: snapshot.template.slice(0, 12) }] : null,
    shown:
      snapshot.state === "ready"
        ? { kind: "ready", value: snapshot.data, updatedAt: snapshot.updatedAt ?? fallbackUpdatedAt }
        : { kind: "empty" },
    problem: null,
    usingSample: snapshot.usingSample,
  };
}

/**
 * 一张卡的 iframe 地址作废后（同一只 iframe 再 load 一次，见 BoardGrid 的 onFrameStale）最多重换几次。
 * 被 React 搬动一次只需要换一次；有上限是防模板自己反复跳转（沙箱不拦同框导航）时无限换地址。
 */
export const FRAME_REFRESH_MAX = 3;

/** 已经为这张卡重换过 `used` 次：还能不能再换（纯函数，可测） */
export function canRefreshFrame(used: number): boolean {
  return used < FRAME_REFRESH_MAX;
}
