import { useState } from "react";
import type { MemoryMutation, MemoryPendingItem } from "@shared/memory";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { formatDay } from "../settings/migration-groups.ts";
import { mutateMemory } from "./useMemory.ts";
import "./memory.css";

/**
 * 待你确认的一张卡。只有两种事会停在这里（2026-10-29 用户裁决：其余一律直接记下，
 * 「全部待确认」太烦）：
 * - promote：一条工作区里的偏好看起来不只适用于这个工作区——升到所有工作区，还是只留这里；
 * - conflict：新说法和一条旧偏好对不上——旧的标为过时，还是两条都留。
 *
 * 拍板过的卡留在原地变成「已…· 撤销」：撤销一律回到待拍板（服务侧语义）。
 */
export function PendingCard(props: {
  item: MemoryPendingItem;
  /** 新条目当前所在的工作区名（「只在 X」的 X）；拿不到时用通用说法 */
  scopeName: string;
}) {
  const t = useT();
  const { item } = props;
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const now = Date.now();

  const run = async (mutation: MemoryMutation): Promise<void> => {
    setBusy(true);
    setProblem(null);
    const outcome = await mutateMemory(mutation);
    setBusy(false);
    if (!outcome.ok) setProblem(t.memory.failed(outcome.error));
  };
  const target = { token: item.token, entryId: item.entry.id };

  if (item.resolution !== undefined) {
    return (
      <div className="mem-ask" data-done="true">
        <span className="mem-ask-head">
          <Icon name="circle-check" size={13} strokeWidth={1.8} />
          {t.memory.decided(item.resolution)}
        </span>
        <p className="mem-ask-text">{item.entry.text}</p>
        <span className="mem-ask-acts">
          <button
            type="button"
            className="mem-btn"
            disabled={busy}
            onClick={() => void run({ op: item.kind === "promote" ? "undoPromote" : "undoConflict", ...target })}
          >
            <Icon name="undo-2" size={12} strokeWidth={1.8} />
            {t.memory.undo}
          </button>
        </span>
        {problem !== null && <p className="mem-error">{problem}</p>}
      </div>
    );
  }

  if (item.kind === "promote") {
    return (
      <div className="mem-ask">
        <span className="mem-ask-head">
          <Icon name="arrow-up-right" size={13} strokeWidth={1.8} />
          {t.memory.promoteTitle}
        </span>
        <p className="mem-ask-text">{item.entry.text}</p>
        <p className="mem-entry-reason">{t.memory.promoteAsk(props.scopeName)}</p>
        <span className="mem-ask-acts">
          <button
            type="button"
            className="mem-btn"
            disabled={busy}
            onClick={() => void run({ op: "decidePromote", ...target, decision: "user" })}
          >
            <Icon name="user" size={12} strokeWidth={1.8} />
            {t.memory.promoteAll}
          </button>
          <button
            type="button"
            className="mem-btn quiet"
            disabled={busy}
            onClick={() => void run({ op: "decidePromote", ...target, decision: "workspace" })}
          >
            {t.memory.promoteKeep(props.scopeName)}
          </button>
        </span>
        {problem !== null && <p className="mem-error">{problem}</p>}
      </div>
    );
  }

  return (
    <div className="mem-ask">
      <span className="mem-ask-head">
        <Icon name="git-fork" size={13} strokeWidth={1.8} />
        {t.memory.conflictTitle}
      </span>
      <div className="mem-ask-pair">
        {item.old === null ? (
          <p className="mem-entry-reason">{t.memory.conflictOldGone}</p>
        ) : (
          <span className="mem-ask-side">
            <span className="mono">{t.memory.conflictOld(formatDay(item.old.at, now))}</span>
            <span>{item.old.text}</span>
          </span>
        )}
        <span className="mem-ask-side">
          <span className="mono">{t.memory.conflictNew(formatDay(item.entry.at, now))}</span>
          <span>{item.entry.text}</span>
        </span>
      </div>
      <span className="mem-ask-acts">
        <button
          type="button"
          className="mem-btn"
          disabled={busy || item.old === null}
          onClick={() => void run({ op: "decideConflict", ...target, decision: "stale-old" })}
        >
          <Icon name="history" size={12} strokeWidth={1.8} />
          {t.memory.conflictStale}
        </button>
        <button
          type="button"
          className="mem-btn quiet"
          disabled={busy}
          onClick={() => void run({ op: "decideConflict", ...target, decision: "keep-both" })}
        >
          {t.memory.conflictBoth}
        </button>
      </span>
      {problem !== null && <p className="mem-error">{problem}</p>}
    </div>
  );
}
