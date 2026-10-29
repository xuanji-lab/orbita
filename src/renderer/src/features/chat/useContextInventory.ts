/**
 * 「整个任务」视野的取数 hook —— 面板组件只调它，拿到 ContextInventory 与加载态。
 *
 * - 「本轮」：直接从会话槽的生效视图推导，不取数；
 * - 「整个任务」：尾窗之外还有记录时，用现成 `session:loadOlder` 逐页拉全量，
 *   缓存在模块级 TaskHistoryStore（按会话一份、面板卸载不丢），新轮增量走实时槽、
 *   不重拉；回退后指纹对不上自动丢弃重拉（失效规则见 task-inventory.ts 文件头）。
 *
 * 加载态给四层：loading（还在拉，界面显示「正在加载更早的记录…」）、fetched
 * （已取回条数，进度提示）、capped（撞页数上限，「整个任务」不完整）、error
 * （拉失败；inventory 仍是已到手部分 + 尾窗的推导结果，界面可照常渲染）。
 *
 * 组件不管 IPC、不管缓存——它只出 `useContextInventory(sessionId, entry, cwd, scope)`。
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { selectTranscript } from "@earendil-works/pi-coding-agent/client";
import { SESSION_PAGE_RECORDS } from "@shared/session";
import { buildContextInventory, type ContextInventory, type ContextScope } from "@shared/context-inventory";
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
} from "./task-inventory.ts";

/** 模块级单份：面板卸载再挂、多个视图同时要「整个任务」，共享同一次拉取。 */
const store = new TaskHistoryStore();

export interface ContextInventoryView {
  inventory: ContextInventory;
  /** 「整个任务」还在拉更早的记录（本轮视野恒 false） */
  loading: boolean;
  /** 已额外取回的更早记录条数（进度提示；未取数 = 0） */
  fetched: number;
  /** 撞页数上限：「整个任务」视图不完整，界面要如实标注 */
  capped: boolean;
  error: string | null;
}

export function useContextInventory(
  sessionId: string,
  entry: SessionEntry,
  cwd: string,
  scope: ContextScope,
): ContextInventoryView {
  // snapshot 引用稳定（未变更的会话返回同一对象），store 通知 → 重渲染
  const history = useSyncExternalStore(store.subscribe, () => store.snapshot(sessionId));

  // 生效视图（含流式中的当前轮条目）：界碑 / 通道标记 / 轮尾账按时间插回，
  // 与聊天面同一条合成路径（mergeSideRecords + selectTranscript）
  const currentView = useMemo(
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

  // 「整个任务」的拉取循环：只在需要时启动一次（进行中 / 已完成的缓存不重启；
  // 回退失效的丢弃重拉；上次失败的重试——IPC 错误多是瞬态）
  const hasMore = entry.window.hasMore;
  const firstId = entry.window.firstId;
  const reverts = entry.reverts.length;
  useEffect(() => {
    if (scope !== "task" || !hasMore) return;
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
  }, [sessionId, scope, hasMore, firstId, reverts]);

  const records = useMemo(
    () => (scope === "task" && hasMore ? mergeHistory(history.records, currentView) : currentView),
    [scope, hasMore, history, currentView],
  );

  const inventory = useMemo(
    () => buildContextInventory({ records, cwd, scope, rules: entry.rules }),
    [records, cwd, scope, entry.rules],
  );

  const loading = scope === "task" && hasMore && history.status === "loading";
  return {
    inventory,
    loading,
    fetched: scope === "task" ? history.fetched : 0,
    capped: scope === "task" && history.capped,
    error: scope === "task" ? history.error : null,
  };
}
