import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { ipcErrorText } from "../../utils/ipc-error.ts";
import type { DocFile, DocTarget } from "../../../../shared/doc.ts";
import { DocSession, type ExternalChange, type MergeFn, type SyncState } from "./doc-session.ts";

export interface OpenDocState {
  phase: "loading" | "ready" | "error";
  /** 读不出来的原因（phase = error） */
  loadError: string | null;
  session: DocSession | null;
  /** 打开时读到的全文：编辑器的初始内容（之后的改动走 session，不走 React） */
  initial: DocFile | null;
  state: SyncState;
  /** 保存失败的原因（state = error） */
  syncError: string | null;
  /** 全文的实时副本：只有 `live` 才维护（演示文稿的缩略条要随每次改动重画；文档编辑器不要，免得每个字重渲染） */
  text: string;
}

const IDLE: OpenDocState = {
  phase: "loading",
  loadError: null,
  session: null,
  initial: null,
  state: "saved",
  syncError: null,
  text: "",
};

/**
 * 打开一份文档：读盘 → 建 DocSession → 监听盘上变化 → 关闭时把没写的写掉。
 * 切文档 / 切会话 / 卸载都走同一条清理：先 flush 再停监听，没有「关了面板丢最后几个字」。
 * `onExternal` 放 ref：编辑器 / 页编辑器换了把手不用重开文档。
 */
export function useOpenDoc(
  target: DocTarget | null,
  onExternal: (change: ExternalChange) => void,
  live: boolean,
  merge?: MergeFn,
): OpenDocState {
  const [state, setState] = useState<OpenDocState>(IDLE);
  const externalRef = useRef(onExternal);
  externalRef.current = onExternal;
  const liveRef = useRef(live);
  liveRef.current = live;
  const sessionId = target?.sessionId ?? null;
  const workspaceId = target?.workspaceId ?? null;
  const path = target?.path ?? null;

  useEffect(() => {
    if (path === null) {
      setState(IDLE);
      return undefined;
    }
    const req: DocTarget = { sessionId, workspaceId, path };
    let cancelled = false;
    let session: DocSession | null = null;
    let unsubscribe: (() => void) | null = null;
    setState(IDLE);

    const flushNow = (): void => {
      void session?.flush();
    };
    const onHidden = (): void => {
      if (document.visibilityState === "hidden") flushNow();
    };

    void (async () => {
      try {
        const file = await api.docs.read(req);
        if (cancelled) return;
        const created = new DocSession(
          {
            read: () => api.docs.read(req),
            write: (text, expectedHash) => api.docs.write({ ...req, text, expectedHash }),
          },
          file,
          {
            onState: (next, message) =>
              setState((prev) => (prev.session === created ? { ...prev, state: next, syncError: message } : prev)),
            onExternal: (change) => externalRef.current(change),
            onText: (text) => {
              if (liveRef.current) setState((prev) => (prev.session === created ? { ...prev, text } : prev));
            },
          },
          500,
          ...(merge === undefined ? [] : [merge]),
        );
        session = created;
        setState({ ...IDLE, phase: "ready", session: created, initial: file, text: file.text });
        unsubscribe = api.docs.onChanged((event) => {
          if (event.path === path) created.diskChanged();
        });
        await api.docs.watch(req);
        window.addEventListener("blur", flushNow);
        document.addEventListener("visibilitychange", onHidden);
        window.addEventListener("pagehide", flushNow);
      } catch (cause) {
        if (!cancelled) {
          setState({ ...IDLE, phase: "error", loadError: ipcErrorText(cause) });
        }
      }
    })();

    return () => {
      cancelled = true;
      window.removeEventListener("blur", flushNow);
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("pagehide", flushNow);
      unsubscribe?.();
      void api.docs.unwatch(req).catch(() => undefined);
      void session?.close();
    };
  }, [sessionId, workspaceId, path]);

  return state;
}
