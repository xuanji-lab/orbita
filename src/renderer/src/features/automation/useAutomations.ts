import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api";
import type {
  Automation,
  AutomationAction,
  AutomationArchiveInfo,
  AutomationCreateInput,
  AutomationOutcome,
  AutomationPatch,
} from "../../../../shared/automation.ts";

/**
 * 自动化的数据钩子（App 持有一份，面板与对话里的卡片共用）。
 * 「拉一次 + 听到主进程的 changed 就重拉」：任何一条自动化变了（到点开跑、跑完、agent 建 / 取消、
 * 面板上的按钮）主进程都广播一次，界面不自己猜哪里变了——一份真源在主进程的 automations.json。
 */
export type AutomationsLoad = { kind: "loading" } | { kind: "ready" } | { kind: "failed"; message: string };

export interface AutomationsState {
  automations: readonly Automation[];
  /** 冷归档的现状（更早的已结束记录移进了哪个文件、有多少条）；没读到 / 读失败是 null，面板就不说这句 */
  archive: AutomationArchiveInfo | null;
  load: AutomationsLoad;
  reload: () => void;
  create: (input: AutomationCreateInput) => Promise<AutomationOutcome>;
  update: (id: string, patch: AutomationPatch) => Promise<AutomationOutcome>;
  act: (id: string, action: AutomationAction) => Promise<AutomationOutcome>;
}

const NONE: readonly Automation[] = [];

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function useAutomations(): AutomationsState {
  const [automations, setAutomations] = useState<readonly Automation[]>(NONE);
  const [archive, setArchive] = useState<AutomationArchiveInfo | null>(null);
  const [load, setLoad] = useState<AutomationsLoad>({ kind: "loading" });
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  const live = useRef(true);

  useEffect(() => api.automation.onEvent(() => setNonce((value) => value + 1)), []);

  useEffect(() => {
    live.current = true;
    api.automation
      .list()
      .then((next) => {
        if (!live.current) return;
        setAutomations(next);
        setLoad({ kind: "ready" });
      })
      .catch((cause: unknown) => {
        if (live.current) setLoad({ kind: "failed", message: messageOf(cause) });
      });
    // 冷归档的现状跟列表一起重拉；读不到只是少一句话，不算加载失败
    api.automation
      .archiveInfo()
      .then((info) => {
        if (live.current) setArchive(info);
      })
      .catch(() => undefined);
    return () => {
      live.current = false;
    };
  }, [nonce]);

  // 写操作：把 IPC 本身的失败（桥断了等）也收成 { ok: false }，调用方只处理一种失败形状
  const guard = useCallback(async (call: () => Promise<AutomationOutcome>): Promise<AutomationOutcome> => {
    try {
      return await call();
    } catch (cause) {
      return { ok: false, error: messageOf(cause) };
    }
  }, []);
  const create = useCallback((input: AutomationCreateInput) => guard(() => api.automation.create(input)), [guard]);
  const update = useCallback((id: string, patch: AutomationPatch) => guard(() => api.automation.update(id, patch)), [guard]);
  const act = useCallback((id: string, action: AutomationAction) => guard(() => api.automation.act(id, action)), [guard]);

  return { automations, archive, load, reload, create, update, act };
}
