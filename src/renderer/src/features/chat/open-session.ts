/**
 * 打开一条会话（`openSession`）里两件与 React 无关的事：读什么、谁说了算。
 *
 * **读什么**：转录只在「这条会话的槽还不存在」时才会种进槽（槽在就是本次启动里打开过 /
 * 正在跑，槽里的比盘上的新）。槽在时照样 `session:load` 是白读——主进程把整份 JSONL
 * 读进来、逐行解析、折叠回退，回来的转录直接被丢掉，只用了 meta 里的几个字段
 * （194 MB 的会话一次堵主进程约 0.3 秒，点侧栏到画面换过去 0.41 秒）。槽在只取 meta。
 *
 * **谁说了算**：连点两条会话时，先点的那条读得慢、晚回来，不能把后点的盖掉。
 * 每次打开领一张票，落地前核对自己还是不是最新一张。
 */
import type { SessionMeta, SessionWindowDetail } from "@shared/session";

/** 打开一条会话要用到的两个读取口（生产里是 `api.session`，测试里是桩） */
export interface OpenReaders {
  load: (id: string) => Promise<SessionWindowDetail | null>;
  meta: (id: string) => Promise<SessionMeta | null>;
}

export interface OpenDetail {
  meta: SessionMeta;
  /** 要种进槽的首屏尾窗；null = 槽已在，不需要种 */
  seed: SessionWindowDetail | null;
}

/** 会话不存在（或 meta 坏了）回 null，与 `session:load` / `session:meta` 同口径 */
export async function readOpenDetail(
  id: string,
  hasSlot: boolean,
  readers: OpenReaders,
): Promise<OpenDetail | null> {
  if (hasSlot) {
    const meta = await readers.meta(id);
    return meta === null ? null : { meta, seed: null };
  }
  const loaded = await readers.load(id);
  return loaded === null ? null : { meta: loaded.meta, seed: loaded };
}

/** 「后点的赢」的票号：begin 领一张新票并作废之前所有的；supersede 只作废、不领票 */
export interface LatestWins {
  begin: () => number;
  supersede: () => void;
  isLatest: (ticket: number) => boolean;
}

export function createLatestWins(): LatestWins {
  let current = 0;
  return {
    begin: () => (current += 1),
    supersede: () => {
      current += 1;
    },
    isLatest: (ticket) => ticket === current,
  };
}
