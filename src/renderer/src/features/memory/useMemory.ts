import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type {
  MemoryBackfillProgress,
  MemoryDownloadProgress,
  MemoryEntriesResponse,
  MemoryHistoryStatus,
  MemoryMutation,
  MemoryMutationOutcome,
  MemoryScopeSummary,
  MemorySessionView,
  MemoryVectorStatus,
} from "../../../../shared/memory.ts";

/**
 * 记忆界面的数据钩子。三个读接口共用一套「拉一次 + 听到 memoryChanged 就重拉」：
 * 服务侧任何写盘（提取落条目、agent 修订、编辑、撤销）都会广播一次，界面不自己猜哪里变了。
 * key 为 null = 不拉（实验开关关着 / 还没开任务）；切 key 时先清空旧数据，
 * 免得上一个作用域的条目在新作用域下闪一帧。
 */
export interface MemoryResource<T> {
  data: T | null;
  error: string | null;
  reload: () => void;
}

function useMemoryResource<T>(key: string | null, load: () => Promise<T>): MemoryResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;
  const shownKey = useRef<string | null>(null);

  useEffect(() => {
    if (key === null) return;
    return api.agent.onEvent((event) => {
      if (event.type === "memoryChanged") setNonce((value) => value + 1);
    });
  }, [key]);

  useEffect(() => {
    if (key === null) {
      shownKey.current = null;
      setData(null);
      setError(null);
      return;
    }
    if (shownKey.current !== key) {
      shownKey.current = key;
      setData(null);
    }
    let live = true;
    loadRef
      .current()
      .then((next) => {
        if (!live) return;
        setData(next);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (live) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      live = false;
    };
  }, [key, nonce]);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { data, error, reload };
}

export function useMemoryScopes(enabled: boolean): MemoryResource<MemoryScopeSummary[]> {
  return useMemoryResource(enabled ? "scopes" : null, () => api.memory.scopes());
}

export function useMemoryEntries(token: string | null): MemoryResource<MemoryEntriesResponse> {
  return useMemoryResource(token, () => api.memory.entries({ token: token ?? "all" }));
}

export function useMemorySession(sessionId: string | null): MemoryResource<MemorySessionView> {
  return useMemoryResource(sessionId, () => api.memory.session(sessionId ?? ""));
}

/**
 * 写操作：失败把一句人话交回调用方（卡片就地显示），成功不用管——memoryChanged
 * 会让各处重拉。
 */
export async function mutateMemory(mutation: MemoryMutation): Promise<MemoryMutationOutcome> {
  try {
    return await api.memory.mutate(mutation);
  } catch (cause) {
    return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

/**
 * 向量模型页：状态快照 + 下载 / 补算两路进度事件。进度事件里的数字比快照新，
 * 页面优先显示事件；下载完成 / 失败、补算收尾时再拉一次快照对齐。
 */
export function useVectorStatus(enabled: boolean): {
  status: MemoryVectorStatus | null;
  error: string | null;
  download: MemoryDownloadProgress | null;
  backfill: MemoryBackfillProgress | null;
  reload: () => void;
} {
  const resource = useMemoryResource(enabled ? "vector" : null, () => api.memory.vectorStatus());
  const [download, setDownload] = useState<MemoryDownloadProgress | null>(null);
  const [backfill, setBackfill] = useState<MemoryBackfillProgress | null>(null);
  const { reload } = resource;
  useEffect(() => {
    if (!enabled) return;
    return api.agent.onEvent((event) => {
      if (event.type === "vectorDownload") {
        // 取消：清掉本地进度（不清的话界面停在取消那一刻的百分比），以快照为准
        setDownload(event.progress.phase === "cancelled" ? null : event.progress);
        if (event.progress.phase !== "downloading" && event.progress.phase !== "verifying") reload();
      }
      if (event.type === "vectorBackfill") {
        setBackfill(event.progress);
        if (event.progress.state === "idle") reload();
      }
    });
  }, [enabled, reload]);
  return { status: resource.data, error: resource.error, download, backfill, reload };
}

/**
 * 从历史生成的任务快照：拉一次 + 听 memoryHistory 事件（每喂完一轮、状态变化时主进程推）。
 * enabled = false 不拉不听。
 */
export function useMemoryHistory(enabled: boolean): MemoryHistoryStatus | null {
  const [status, setStatus] = useState<MemoryHistoryStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    void api.memory
      .historyStatus()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => undefined);
    const off = api.agent.onEvent((event) => {
      if (event.type === "memoryHistory") setStatus(event.status);
    });
    return () => {
      live = false;
      off();
    };
  }, [enabled]);
  return status;
}
