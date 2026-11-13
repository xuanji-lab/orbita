/**
 * 星云头顶那一层：气泡（正在整理 / 问要不要总结）与收工小结卡。
 *
 * 两个组件**不是**同一棵子树里的一层：气泡渲染在星云本体里，卡由 UsageMeter 的
 * NebCardPortal 锚在星云上方（侧栏是 overflow 裁剪链，卡必须在原地之外 portal）。
 * 所以这里导出两个，`use-focus-shell.tsx` 把它们分别接到 Sidebar 的 `usageSay` /
 * `usageCard` 两个口子上；App 只递节点，不碰判定。
 *
 * 判定全在 `focus-shell.ts`（纯函数，带测试）：本文件只负责把判定结果画出来。
 */
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { FocusSummaryCard } from "../../shell/focus/FocusSummaryCard.tsx";
import { focusCardMinutesOf, focusCardVisibleOf, settledSayTextOf, type FocusBubbleView } from "./focus-shell.ts";
import type { FocusRun } from "../../shell/focus/focus-timer.ts";
import type { FocusStatus, FocusSummary } from "../../shell/focus/use-focus.ts";

/** 星云气泡：run 相位的常驻那句 / ending 相位的问询 */
export function FocusSay(props: {
  view: FocusBubbleView;
  onDismiss: () => void;
  onRequestSummary: () => void;
  onEnd: () => void;
}) {
  const t = useT();
  const { view } = props;
  if (view.kind === "hidden") return null;
  if (view.kind === "working") {
    return (
      <div className="usage-say usage-say-focus" role="status" data-edge="end">
        <Icon name="loader-circle" size={12} spin />
        <span className={view.breath ? "orbita-breath" : undefined}>{t.focus.summarizing}</span>
      </div>
    );
  }
  if (view.kind === "settled") {
    return (
      <div className="usage-say usage-say-status" role="status" data-edge="end">
        {view.line === "ready" ? <Icon name="check" size={12} strokeWidth={2.2} /> : null}
        <span>{settledSayTextOf(view.line, t.focus)}</span>
        <button
          type="button"
          className="usage-say-x"
          title={t.focus.sayDismiss}
          aria-label={t.focus.sayDismiss}
          onClick={props.onDismiss}
        >
          <Icon name="x" size={11} />
        </button>
      </div>
    );
  }
  return (
    <div className="usage-say usage-say-ask" role="status" data-edge="end">
      <span>{t.focus.askSummary}</span>
      <button type="button" className="usage-say-act" onClick={props.onRequestSummary}>
        {t.focus.askYes}
      </button>
      <button type="button" className="usage-say-act" onClick={props.onEnd}>
        {t.focus.askNo}
      </button>
    </div>
  );
}

/**
 * 收工小结卡：可见性与「N 分钟」都在 `focus-shell.ts` 里判，这里只画。
 * summary 的四种态由 FocusSummaryCard 自己分（B4 的重试键在 failed 态出现）。
 */
export function FocusCardLayer(props: {
  status: FocusStatus;
  run: FocusRun | null;
  summary: FocusSummary;
  /** 卡自己的关闭键（只藏卡，不结束专注） */
  closed: boolean;
  workspaceName: string;
  onRetry: () => void;
  onEnd: () => void;
  onAgain: () => void;
  onClose: () => void;
}) {
  const { status, run } = props;
  if (run === null || !focusCardVisibleOf(status, props.summary, props.closed)) return null;
  return (
    <FocusSummaryCard
      ending={status.kind === "ending"}
      minutes={focusCardMinutesOf(status, run, Date.now())}
      workspaceName={props.workspaceName}
      summary={props.summary}
      onRetry={props.onRetry}
      onEnd={props.onEnd}
      onAgain={props.onAgain}
      onClose={props.onClose}
    />
  );
}
