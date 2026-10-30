import { useState } from "react";
import { api } from "../../api";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import type { SessionMeta } from "@shared/session";
import { formatWhen } from "./automation-view.ts";
import "./automation.css";

/**
 * 自动化新开的会话顶部那一条：「任务名 · 第 n 次 · 时间 · 定时 / 手动」+「转成普通会话」。
 * 点转换：主进程把会话标成 promoted，从此进左侧栏（刷新列表后这条条自然消失——promoted 的会话不再是「运行会话」）。
 * 标注读会话 meta 上的 automationRun：自动化被删之后这条会话照样认得出自己是谁。
 */
export function AutomationRunBar(props: { meta: SessionMeta; onPromoted: () => void }) {
  const t = useT();
  const a = t.automation;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = props.meta.automationRun;
  if (props.meta.automationId === undefined || props.meta.promoted === true) return null;
  const promote = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const outcome = await api.automation.promote(props.meta.id);
      if (!outcome.ok) setError(outcome.error);
      else props.onPromoted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auto-runbar" role="note">
      <span className="auto-runbar-label">
        <Icon name="calendar-clock" size={14} strokeWidth={1.8} />
        <span className="auto-runbar-text">
          {run === undefined
            ? props.meta.title
            : a.runBar.label(run.title, run.number, formatWhen(run.at, Date.now(), a), run.trigger)}
        </span>
      </span>
      {error !== null && <span className="auto-runbar-error">{a.runBar.promoteFailed(error)}</span>}
      <button type="button" className="quiet-control" title={a.runBar.promoteTip} disabled={busy} onClick={() => void promote()}>
        {a.runBar.promote}
      </button>
    </div>
  );
}

