/**
 * 「整个任务」的记录：会话槽只装尾窗（500 条），更早的用现成 `session:loadOlder` 逐页拉全量，
 * 缓存在模块级 TaskHistoryStore（按会话一份、面板卸载不丢）。右栏「这条任务」两个页签共用
 * 这一份：上下文页签的「整个任务」视野（useContextInventory）、进度页签的「做过的」
 * （TaskProgress）——谁先拉，另一个直接用；不各拉一遍。
 *
 * 新轮增量走实时槽、不重拉；回退后指纹对不上自动丢弃重拉（失效规则见 task-inventory.ts 文件头）。
 *
 * 加载态给四层：loading（还在拉）、fetched（已取回条数，进度提示）、capped（撞页数上限，
 * 「整个任务」不完整）、error（拉失败；records 仍是已到手部分 + 尾窗，界面可照常渲染）。
 *
 * 组件不管 IPC、不管缓存——它只出 `useTaskRecords(sessionId, entry, whole)`。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import { SESSION_PAGE_RECORDS, type SessionRecord, type TranscriptRecord } from "@shared/session";
import { api } from "../../api.ts";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import { mergeSideRecords, type SessionEntry } from "./session-states.ts";
import {
  advanceHistory,
  failHistory,
  historyStale,
  mergeHistory,
  startHistory,
  TaskHistoryStore,
  type TaskHistoryState,
} from "./task-inventory.ts";

/** 模块级单份：面板卸载再挂、两个页签同时要「整个任务」，共享同一次拉取。 */
const store = new TaskHistoryStore();

/** 这条会话的拉取缓存（idle = 谁都还没要过更早的记录）。引用稳定，store 一通知就重渲染。 */
export function useTaskHistory(sessionId: string): TaskHistoryState {
  return useSyncExternalStore(store.subscribe, () => store.snapshot(sessionId));
}

export interface TaskRecordsView {
  /** 尾窗的合并视图：界碑 / 通道标记 / 轮尾账按时间插回，与聊天面同一条合成路径 */
  current: readonly TranscriptRecord[];
  /** 已拉到的更早记录（时间正序，不含尾窗里的；没要整个任务或尾窗之外没有更早的 = 空） */
  older: readonly SessionRecord[];
  /** older + current，按 id 去重（聊天面自己往上翻会把同一批装进尾窗） */
  records: readonly TranscriptRecord[];
  /** 尾窗之外还有更早的记录（会话槽的 window.hasMore） */
  hasOlder: boolean;
  /** 还在拉更早的记录（whole = false 时恒 false） */
  loading: boolean;
  /** 已额外取回的更早记录条数（进度提示；未取数 = 0） */
  fetched: number;
  /** 撞页数上限：「整个任务」不完整，界面要如实标注 */
  capped: boolean;
  error: string | null;
}

const NO_OLDER: readonly SessionRecord[] = [];

/**
 * whole = 要整个任务：尾窗之外还有记录时启动拉取循环（进行中 / 已完成的缓存不重启；回退失效的
 * 丢弃重拉；上次失败的重试——IPC 错误多是瞬态），返回合并后的全量；false = 只要尾窗。
 */
export function useTaskRecords(sessionId: string, entry: SessionEntry, whole: boolean): TaskRecordsView {
  const history = useTaskHistory(sessionId);

  // 生效视图（含流式中的当前轮条目）：与聊天面同一条合成路径（mergeSideRecords + selectTranscript）
  const current = useMemo(
    () =>
      mergeSideRecords(
        entry.compactions,
        entry.marks,
        entry.fileTurns,
        entry.reverts,
        entry.undos,
        selectTranscript(entry.transcript),
        entry.intentRecalls,
      ),
    [entry],
  );

  const hasMore = entry.window.hasMore;
  const firstId = entry.window.firstId;
  const reverts = entry.reverts.length;
  useEffect(() => {
    if (!whole || !hasMore) return;
    const anchor = { firstId, reverts };
    const cached = store.snapshot(sessionId);
    const usable = !historyStale(cached, anchor) && (cached.status === "loading" || cached.status === "ready");
    if (usable) return;
    if (historyStale(cached, anchor)) store.drop(sessionId);
    let state = startHistory(anchor);
    store.set(sessionId, state);
    void (async () => {
      let before = state.anchor.firstId;
      try {
        while (state.status === "loading") {
          // 被顶替即作废：回退后重拉会 drop + 重启，这趟循环晚到的写不能
          // 把新循环的结果覆盖回旧数据（按「链上最新是不是自己」判）
          if (store.snapshot(sessionId) !== state) return;
          if (before === null) {
            // 尾窗有更早却拿不到锚（理论不可达）：如实报错，不空转
            state = failHistory(state, "尾窗锚点缺失，无法继续取更早的记录");
            store.set(sessionId, state);
            return;
          }
          const page = await api.session.loadOlder(sessionId, before, SESSION_PAGE_RECORDS);
          if (store.snapshot(sessionId) !== state) return;
          state = advanceHistory(state, page);
          store.set(sessionId, state);
          // 下一页的锚：已取到的最早一条（空页异常已由 advanceHistory 判错停下）
          before = state.records[0]?.id ?? before;
        }
      } catch (cause: unknown) {
        if (store.snapshot(sessionId) === state) {
          state = failHistory(state, ipcErrorText(cause));
          store.set(sessionId, state);
        }
      }
    })();
    // entry 每条事件都换引用，全量进依赖会让 error 态每条事件都重启拉取——只进指纹
  }, [sessionId, whole, hasMore, firstId, reverts]);

  const merging = whole && hasMore;
  const older = merging ? history.records : NO_OLDER;
  const records = useMemo(() => (merging ? mergeHistory(older, current) : current), [merging, older, current]);
  return {
    current,
    older,
    records,
    hasOlder: hasMore,
    loading: merging && history.status === "loading",
    fetched: whole ? history.fetched : 0,
    capped: whole && history.capped,
    error: whole ? history.error : null,
  };
}
