/**
 * 连接页签的实测状态。每家一个状态，**逐卡**探测（一张慢不拖住别的）：
 * 进页签时全探一遍；窗口重新聚焦时再探一遍（用户多半是去聊天里让智能体配好、再回来看）；
 * 也可以手动「重新检测」。结果按**探测序号**落地——慢的旧结果不许覆盖新的（聚焦连触发两次时会撞上）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { CONNECTORS, type ConnectorId, type ConnectorSaveResult, type ConnectorStatus } from "@shared/connectors";
import { api } from "../../api";
import type { ProbeState } from "./connectors-view.ts";

export type ConnectorStates = Readonly<Record<ConnectorId, ProbeState>>;

/** 初始：即将支持的直接是它自己，其余先「检测中」（每家都会被探一遍） */
function initial(): ConnectorStates {
  return Object.fromEntries(
    CONNECTORS.map((entry): [ConnectorId, ProbeState] => [entry.id, entry.kind === "coming-soon" ? { kind: "coming-soon" } : { kind: "checking" }]),
  ) as ConnectorStates;
}

export interface Connectors {
  states: ConnectorStates;
  /** 全部重新探一遍（卡片先回到「检测中」） */
  recheck: () => void;
  /** 保存 token 并实测；落地后卡片状态就是实测结果。校验 / 写盘失败以数据返回，调用方就地显示 */
  saveToken: (id: ConnectorId, token: string) => Promise<ConnectorSaveResult>;
}

export function useConnectors(active: boolean): Connectors {
  const [states, setStates] = useState<ConnectorStates>(initial);
  /** 每家最新一次探测的序号 */
  const seq = useRef<Partial<Record<ConnectorId, number>>>({});

  const apply = useCallback((id: ConnectorId, status: ConnectorStatus, n: number) => {
    if (seq.current[id] !== n) return;
    setStates((prev) => ({ ...prev, [id]: status }));
  }, []);

  const probe = useCallback(
    (id: ConnectorId, showChecking: boolean) => {
      const n = (seq.current[id] ?? 0) + 1;
      seq.current[id] = n;
      if (showChecking) setStates((prev) => (prev[id].kind === "coming-soon" ? prev : { ...prev, [id]: { kind: "checking" } }));
      api.connector.probe(id).then(
        (status) => apply(id, status, n),
        (cause: unknown) => apply(id, { kind: "failed", code: "error", message: cause instanceof Error ? cause.message : String(cause) }, n),
      );
    },
    [apply],
  );

  const probeAll = useCallback(
    (showChecking: boolean) => {
      for (const entry of CONNECTORS) if (entry.kind !== "coming-soon") probe(entry.id, showChecking);
    },
    [probe],
  );

  useEffect(() => {
    if (!active) return;
    probeAll(true);
    // 回到窗口：静默重探（不闪「检测中」，只在结果变了时换）
    const onFocus = (): void => probeAll(false);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [active, probeAll]);

  const saveToken = useCallback(
    async (id: ConnectorId, token: string): Promise<ConnectorSaveResult> => {
      // 保存期间别让在飞的旧探测落地覆盖结果
      seq.current[id] = (seq.current[id] ?? 0) + 1;
      const n = seq.current[id];
      setStates((prev) => ({ ...prev, [id]: { kind: "checking" } }));
      try {
        const result = await api.connector.saveToken(id, token);
        if (result.ok && n !== undefined) apply(id, result.status, n);
        else probe(id, false);
        return result;
      } catch (cause) {
        probe(id, false);
        return { ok: false, code: "write-failed", message: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    [apply, probe],
  );

  return { states, recheck: () => probeAll(true), saveToken };
}
