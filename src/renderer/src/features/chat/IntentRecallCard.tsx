/**
 * 意图召回的流水线卡片（实验功能 intent-system）—— 聊天流里的过程卡。
 *
 * 2026-10-14 重写（confirm-card-options.html §1 的「召回卡 C」，用户裁决）：细框卡
 * 语言——进度环（相位刻度，不是真实百分比）+ 标题 / 场景 / 已用时间 / 取消 +
 * 四胶囊（理解 / 打分 / 写理由 / 确认，当前的描 warning 色边）+ 一行当前步细节。
 * 等确认：环停在 86%（不随秒针走——免得看起来像限时表态），确认胶囊换气泡图标，
 * 细节行报「有 N 条拿不准」。终态收成一行：小环打绿勾 + 读了 / 入选 / 你确认 +
 * 用时 · token + 「在右栏看图谱」+ 展开 chevron；门卫跳过 / 出错 / 取消同款式，
 * 出错文字用 danger。阶段明细（11 格阶段条）只在展开后看。
 *
 * 数据归约（applyRecallEvent）与显示态派生（recallRunView）都在 shared，本文件不持
 * 状态机。入选条目与确认表态不在聊天面重复，统一在右栏「意图」面板（图 + 卡片）。
 */
import { useEffect, useState } from "react";
import { Icon, type IconName } from "../../shell/Icon.tsx";
import { useT } from "../../locale.ts";
import {
  INTENT_FEEDBACK_FAILED,
  INTENT_LAB_SILENT,
  INTENT_LAB_STREAM_ENDED,
  INTENT_LAB_UNREACHABLE,
  recallRunView,
  stagesOfCard,
  usageCountsOfIntent,
  type RecallCardState,
  type RecallRunDetail,
  type RecallStageCell,
} from "../../../../shared/intent-recall.ts";
import type { IntentRecallRecord } from "../../../../shared/session.ts";
import { formatThinkingDuration } from "./tool-results.ts";
import { formatTokens } from "../../utils/format-tokens.ts";
import type { Messages } from "../../messages-en.ts";

/** 客户端自产错误码 → 界面语言文案；不认识的机器码原样显示（那是服务端的话）。 */
function recallErrorText(message: string, t: Messages): string {
  if (message === INTENT_LAB_SILENT) return t.chat.recall.silent;
  if (message === INTENT_LAB_STREAM_ENDED) return t.chat.recall.streamEnded;
  if (message === INTENT_LAB_UNREACHABLE) return t.chat.recall.unreachable;
  if (message.startsWith(`${INTENT_LAB_UNREACHABLE} `)) {
    const status = message.slice(INTENT_LAB_UNREACHABLE.length + 1);
    return t.chat.recall.unreachableHttp(status);
  }
  if (message.startsWith(INTENT_FEEDBACK_FAILED)) {
    const detail = message.slice(INTENT_FEEDBACK_FAILED.length).trim();
    if (detail.includes("404")) return t.chat.recall.confirm.feedbackGone;
    const cause = detail.replace(/[()]/g, "");
    return `${t.chat.recall.confirm.feedbackFailed}${cause === "" ? "" : `（${cause}）`}`;
  }
  return message;
}

/** 出错卡的位置行：停在哪一步（阶段名翻人话，不认识退回 id 原样）。 */
function haltedLine(record: IntentRecallRecord, t: Messages): string {
  const stage = record.halted?.stage ?? record.error?.stage ?? "";
  const label = t.chat.recall.stageNames[stage] ?? stage;
  return t.chat.recall.stoppedAtStage(label);
}

/** 一格阶段条的标签（数字载荷按 key 组文案；知道了才显示数字）。 */
function stageCellLabel(cell: RecallStageCell, t: Messages): string {
  const r = t.chat.recall;
  const n = cell.numbers;
  switch (cell.key) {
    case "gate":
      return r.stageGate;
    case "understand":
      return r.stageUnderstand;
    case "score":
      return n !== null && n.done !== undefined && n.total !== undefined ? r.stageScore(n.done, n.total) : r.stageScore(0, 0);
    case "passline":
      return r.stagePassline(n?.passed ?? 0);
    case "reasons":
      return n !== null && n.done !== undefined && n.total !== undefined ? r.stageReasons(n.done, n.total) : r.stageReasons(0, 0);
    case "dedup":
      return r.stageDedup(n?.after ?? 0, n?.merged ?? null);
    case "keeper":
      return n !== null && n.s4done !== undefined && n.s4chars !== undefined
        ? r.stageKeeperWriting(n.s4done, n.s4chars)
        : r.stageKeeper(n?.selected ?? null);
    case "confirm":
      return n !== null && n.askNone === true ? r.stageConfirmNone : r.stageConfirmAsked(n?.asked ?? 0);
    case "context":
      return r.stageContext(n?.added ?? null);
    case "answer":
      return r.stageAnswer;
    case "edges":
      return r.stageEdges(n?.edges ?? null);
    default:
      return r.stageAnswer;
  }
}

/** 11 格阶段条：状态图标 + 名称（+ 数字）；error 红格、running 转圈。终态卡展开的明细用。 */
function RecallStageBar(props: { cells: readonly RecallStageCell[]; withMs?: boolean }) {
  const t = useT();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap", paddingLeft: 44 }}>
      {props.cells.map((cell) => {
        const label = stageCellLabel(cell, t);
        const ms =
          props.withMs === true && cell.ms !== null && cell.ms > 0 ? formatThinkingDuration(cell.ms, t) : null;
        return (
          <span
            key={cell.key}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
              fontSize: "var(--font-size-micro)",
              color:
                cell.status === "error"
                  ? "var(--color-danger)"
                  : cell.status === "running"
                    ? "var(--color-text-secondary)"
                    : "var(--color-text-tertiary)",
              opacity: cell.status === "pending" ? 0.6 : 1,
            }}
          >
            {cell.status === "done" ? (
              <Icon name="circle-check" size={11} />
            ) : cell.status === "running" ? (
              <Icon name="loader-circle" size={11} className="orbita-spin" />
            ) : cell.status === "error" ? (
              <Icon name="triangle-alert" size={11} />
            ) : (
              <Icon name="circle-dot" size={11} />
            )}
            {label}
            {ms !== null && <span style={{ fontFamily: "var(--font-family-mono)" }}>{ms}</span>}
          </span>
        );
      })}
    </div>
  );
}

/** 进度环（SVG 圆环）：track 淡底、弧 warning 色；中间是百分比。等确认时停在 86%。 */
function RecallRing(props: { fraction: number }) {
  const size = 52;
  const r = 22;
  const circumference = 2 * Math.PI * r;
  return (
    <span className="intent-ring" style={{ width: size, height: size }}>
      <svg viewBox="0 0 52 52" style={{ width: "100%", height: "100%", transform: "rotate(-90deg)" }} aria-hidden="true">
        <circle cx={26} cy={26} r={r} fill="none" stroke="var(--color-bg-hover)" strokeWidth={4} />
        <circle
          cx={26}
          cy={26}
          r={r}
          fill="none"
          stroke="var(--color-warning)"
          strokeWidth={4}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - props.fraction)}
        />
      </svg>
      <span className="intent-ring-pct">{Math.round(props.fraction * 100)}%</span>
    </span>
  );
}

/** 终态行的小环：绿圈打勾（30px，同 recall ring 的缩小版）。 */
function RecallRingDone() {
  return (
    <span className="intent-ring" style={{ width: 30, height: 30 }}>
      <svg viewBox="0 0 30 30" style={{ width: "100%", height: "100%" }} aria-hidden="true">
        <circle cx={15} cy={15} r={12} fill="none" stroke="var(--color-success)" strokeWidth={3} />
      </svg>
      <span className="intent-ring-pct">
        <Icon name="check" size={13} style={{ color: "var(--color-success)" }} />
      </span>
    </span>
  );
}

/** 细节行的一句话（当前步的载荷 → 界面语言）。 */
function runDetailText(detail: RecallRunDetail, t: Messages): string {
  const r = t.chat.recall;
  switch (detail.kind) {
    case "gate":
      return r.detailGate;
    case "understand":
      return r.detailUnderstand;
    case "score":
      return r.detailScore(detail.done, detail.total, detail.passed);
    case "reasons":
      return r.detailReasons(detail.done, detail.total);
    case "keeper":
      return r.detailKeeper(detail.done, detail.chars);
    case "confirm":
      return r.confirmWaitingDetail(detail.asked);
    case "settling":
      return r.detailSettling;
  }
}

/** 运行卡：转录末尾、Responding 之前。等确认态也由它画（done 且 pendingAsks>0、终态记录未落盘）。 */
export function IntentRecallRunCard(props: { card: RecallCardState; onCancel: () => void }) {
  const t = useT();
  const { card } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const view = recallRunView(card);
  // 等确认：表停在 recall 结束的用时——不随秒针走（看起来会像要求用户在期限内表态）
  const elapsed =
    view.awaitingConfirm && card.timings !== null
      ? formatThinkingDuration(card.timings.totalMs, t)
      : formatThinkingDuration(Math.max(0, now - card.startedAt), t);
  const pills: { key: "understand" | "score" | "reasons" | "confirm"; label: string }[] = [
    { key: "understand", label: t.chat.recall.pillUnderstand },
    { key: "score", label: t.chat.recall.pillScore },
    { key: "reasons", label: t.chat.recall.pillReasons },
    { key: "confirm", label: t.chat.recall.pillConfirm },
  ];
  return (
    <div className="intent-run-card">
      <RecallRing fraction={view.fraction} />
      <div className="intent-run-body">
        <div className="intent-run-top">
          <span className="intent-run-title">{t.chat.recall.label}</span>
          {(card.scene !== null || card.want !== "") && (
            <span className="intent-run-scene" title={t.chat.recall.sceneLine(card.scene ?? "", card.want)}>
              {t.chat.recall.sceneLine(card.scene ?? "", card.want)}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <span className="intent-run-time">{elapsed}</span>
          <button type="button" className="intent-card-mini" onClick={props.onCancel}>
            <Icon name="x" size={11} />
            {t.common.cancel}
          </button>
        </div>
        <div className="intent-pills">
          {pills.map((pill) => {
            const state = view.pills[pill.key];
            const icon: IconName =
              state === "done"
                ? "circle-check"
                : state === "running"
                  ? pill.key === "confirm" && view.awaitingConfirm
                    ? "message-circle"
                    : "loader-circle"
                  : "circle-dashed";
            return (
              <span key={pill.key} className={`intent-pill${state === "running" ? " run" : ""}${state === "done" ? " done" : ""}`}>
                <Icon
                  name={icon}
                  size={11}
                  className={state === "running" && icon === "loader-circle" ? "orbita-spin" : undefined}
                />
                {pill.label}
              </span>
            );
          })}
        </div>
        <div className="intent-run-detail">{runDetailText(view.detail, t)}</div>
      </div>
    </div>
  );
}

/**
 * 终态卡：收起一行结论（门卫跳过 / 出错 / 取消同款式；出错文字 danger），整行与
 * chevron 都可点展开——展开只看阶段条（逐格用时）与错误明细；条目与表态在右栏
 * 「意图」面板（行内链接直达，只在主槽有这个入口）。
 */
export function IntentRecallFinalCard(props: { record: IntentRecallRecord; onOpenIntentPanel?: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const record = props.record;
  const duration = record.timings !== null
    ? formatThinkingDuration(record.timings.totalMs, t)
    : formatThinkingDuration(Math.max(0, record.finishedAt - record.startedAt), t);
  const usageCount = record.usage;
  const usage =
    usageCount === undefined
      ? ""
      : ` · ${t.chat.recall.usageTokens(
          formatTokens(
            usageCountsOfIntent(usageCount).input +
              usageCountsOfIntent(usageCount).output +
              usageCountsOfIntent(usageCount).cacheRead,
          ),
        )}`;
  // 三个关键数：读了多少 / 入选几条（含确认提升的）/ 你确认了几条（改字也算对）
  const confirmedYes =
    record.confirm?.answers.filter((answer) => answer.verdict === "yes" || answer.edited !== undefined).length ?? 0;
  const statsLine =
    record.skipped === "gate"
      ? t.chat.recall.skippedLine(record.gateWhy ?? "")
      : record.status === "done"
        ? t.chat.recall.doneStats(
            record.qaTotal === null ? t.chat.recall.readUnknown : record.qaTotal.toLocaleString("en-US"),
            record.selected.length + (record.confirm?.promoted ?? 0),
          ) +
          (record.ask.length > 0 ? ` · ${t.chat.recall.doneConfirmed(confirmedYes, record.ask.length)}` : "") +
          (record.askRemaining !== undefined && record.askRemaining > 0
            ? ` · ${t.chat.recall.askRemainingLine(record.askRemaining)}`
            : "")
        : record.status === "cancelled"
          ? t.chat.recall.cancelled
          : record.error !== null
            ? `${haltedLine(record, t)} · ${recallErrorText(record.error.message, t)}`
            : t.chat.recall.failed;
  const failed = record.status === "error";
  return (
    <div className="intent-final">
      <div className="intent-final-row">
        <button
          type="button"
          className="intent-final-toggle"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {record.status === "done" ? (
            <RecallRingDone />
          ) : (
            <Icon
              name={failed ? "triangle-alert" : "circle-off"}
              size={14}
              style={{ color: failed ? "var(--color-danger)" : "var(--color-text-tertiary)", flex: "0 0 auto" }}
            />
          )}
          <span className="intent-final-title" style={failed ? { color: "var(--color-danger)" } : undefined}>
            {t.chat.recall.label}
          </span>
          <span
            className="intent-final-stats"
            title={statsLine}
            style={failed ? { color: "var(--color-danger)" } : undefined}
          >
            {statsLine}
          </span>
          <span style={{ flex: 1 }} />
          <span className="intent-run-time">{duration}{usage}</span>
        </button>
        {record.status === "done" && props.onOpenIntentPanel !== undefined && (
          <button type="button" className="intent-graph-link" onClick={props.onOpenIntentPanel}>
            <Icon name="waypoints" size={12} />
            {t.chat.recall.openGraph}
          </button>
        )}
        <button
          type="button"
          className="quiet-control intent-final-chev"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          aria-label={t.chat.recall.label}
        >
          <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
        </button>
      </div>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-2)", paddingTop: "var(--space-1)" }}>
          {record.stages !== undefined && <RecallStageBar cells={record.stages} withMs />}
          {failed && record.error !== null && (
            <p style={{ margin: 0, paddingLeft: 44, fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
              {haltedLine(record, t)} · {recallErrorText(record.error.message, t)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
