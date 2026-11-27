/**
 * 通道摘要「属于哪个父」的判断（从 useChannelSummaries 拆出来，纯函数，能在 node 里测）。
 *
 * state 里存的是上一次取回来的摘要和它属于哪个父。换父会话的那一帧 state 还是上一个父的：
 * 对不上就当没有——空表 + `ready: false`，不能拿旧父的摘要去判新父的子会话。
 */
import type { ChannelSummary } from "@shared/channel";

export interface LoadedSummaries {
  parentId: string;
  summaries: ReadonlyMap<string, ChannelSummary>;
}

export interface ChannelSummariesState {
  summaries: ReadonlyMap<string, ChannelSummary>;
  /** 当前这个父的摘要至少取回来过一次（取回失败时一直是 false） */
  ready: boolean;
}

const EMPTY: ReadonlyMap<string, ChannelSummary> = new Map();
const NOT_READY: ChannelSummariesState = { summaries: EMPTY, ready: false };

export function pickSummaries(loaded: LoadedSummaries | null, parentId: string | null): ChannelSummariesState {
  if (parentId === null || loaded === null || loaded.parentId !== parentId) return NOT_READY;
  return { summaries: loaded.summaries, ready: true };
}
