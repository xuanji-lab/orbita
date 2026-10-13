/**
 * 意图召回的流水线卡片（实验功能 intent-system）—— 聊天流里的过程卡。
 *
 * 视觉语言与 ToolCard / ThinkingCard 的过程行同款（2026-10-13 用户裁决）：**无底色、
 * 无边框，直接坐在聊天面上**；颜色只当第二信号——进行中仅头部（图标 + 标题）用
 * secondary 色并呼吸（转圈图标可用 warning 色），落定后整行退到 tertiary；唯一的
 * 状态色是出错行的 danger 文字。标题不换行（窄列里「意图召回」四字被拆两行过）。
 *
 * 运行卡（RecallCardState）：阶段条 + 场景行 + 已用时间 + 取消。
 * 终态卡（IntentRecallRecord）：收起一行结论，展开只看逐格用时与错误；入选条目与
 * 确认表态不在聊天面重复，统一在右栏「意图」面板（图 + 卡片）。数据归约（applyRecallEvent）在 shared，本文件不持状态机。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { Icon } from "../../shell/Icon.tsx";
import { useT } from "../../locale.ts";
import {
  INTENT_FEEDBACK_FAILED,
  INTENT_LAB_SILENT,
  INTENT_LAB_STREAM_ENDED,
  INTENT_LAB_UNREACHABLE,
  stagesOfCard,
  usageCountsOfIntent,
  type RecallCardState,
  type RecallStageCell,
} from "../../../../shared/intent-recall.ts";
import type { IntentRecallRecord } from "../../../../shared/session.ts";
import { formatThinkingDuration } from "./tool-results.ts";
import type { Messages } from "../../messages-en.ts";

/** 客户端自产错误码 → 界面语言文案；不认识的机器码原样显示（那是服务端的话）。 */
export function recallErrorText(message: string, t: Messages): string {
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

/** 11 格阶段条：状态图标 + 名称（+ 数字）；error 红格、running 转圈；放不下自动换行。 */
export function RecallStageBar(props: { cells: readonly RecallStageCell[]; withMs?: boolean }) {
  const t = useT();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap", paddingLeft: 22 }}>
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

/** 运行卡：转录末尾、Responding 之前。过程行语言：无底无边框，头部呼吸，图标用 warning。 */
export function IntentRecallRunCard(props: { card: RecallCardState; onCancel: () => void }) {
  const t = useT();
  const { card } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  // 等确认：recall 已结束、确认卡浮着等用户表态。表不再随秒针走——看起来会像
  // 要求用户在期限内表态
  const awaitingConfirm = card.status === "done" && card.pendingAsks > 0;
  const elapsed = awaitingConfirm && card.timings !== null
    ? formatThinkingDuration(card.timings.totalMs, t)
    : formatThinkingDuration(Math.max(0, now - card.startedAt), t);
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0, marginTop: "var(--space-3)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        {/* 进行中的状态本体：图标（warning 色转圈）+ 标题（secondary 呼吸，不换行） */}
        <Icon name="loader-circle" size={14} className="orbita-spin intent-run-icon" />
        <span className="intent-run-title">{t.chat.recall.label}</span>
        {(card.scene !== null || card.want !== "") && (
          <span
            style={{
              flex: "0 1 auto",
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontSize: "var(--font-size-caption)",
              color: "var(--color-text-tertiary)",
            }}
          >
            {t.chat.recall.sceneLine(card.scene ?? "", card.want)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {awaitingConfirm && (
          <span style={{ flex: "0 0 auto", fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" }}>
            {t.chat.recall.waitingForYou}
          </span>
        )}
        <span
          style={{
            flex: "0 0 auto",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-micro)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {elapsed}
        </span>
        <button type="button" onClick={props.onCancel} style={miniButtonStyle}>
          <Icon name="x" size={11} />
          {t.common.cancel}
        </button>
      </div>
      <RecallStageBar cells={stagesOfCard(card, null)} />
    </div>
  );
}

/** 终态卡：收起一行结论（整行 tertiary；错误文字用 danger），展开只看阶段条与错误；条目细节在右栏「意图」面板。 */
export function IntentRecallFinalCard(props: { record: IntentRecallRecord }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const record = props.record;
  const duration = record.timings !== null
    ? formatThinkingDuration(record.timings.totalMs, t)
    : formatThinkingDuration(Math.max(0, record.finishedAt - record.startedAt), t);
  const usage =
    record.usage !== undefined
      ? ` ${t.chat.recall.usageLine(
          (usageCountsOfIntent(record.usage).input +
            usageCountsOfIntent(record.usage).output +
            usageCountsOfIntent(record.usage).cacheRead).toLocaleString("en-US"),
        )}`
      : "";
  const line =
    record.skipped === "gate"
      ? t.chat.recall.skippedLine(record.gateWhy ?? "")
      : record.status === "done"
        ? t.chat.recall.doneLine(record.qaTotal ?? t.chat.recall.readUnknown, record.selected.length, record.ask.length, duration) +
          (record.askRemaining !== undefined && record.askRemaining > 0
            ? ` · ${t.chat.recall.askRemainingLine(record.askRemaining)}`
            : "") +
          usage
        : record.status === "cancelled"
          ? t.chat.recall.cancelled
          : record.error !== null
            ? `${haltedLine(record, t)} · ${recallErrorText(record.error.message, t)}`
            : t.chat.recall.failed;
  const failed = record.status === "error";
  return (
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0, marginTop: "var(--space-3)" }}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-2)",
          minWidth: 0,
          padding: 0,
          border: 0,
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--color-text-tertiary)",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-caption)",
        }}
      >
        <Icon
          name={record.status === "done" ? "shield-check" : failed ? "triangle-alert" : "circle-off"}
          size={14}
          style={{ color: failed ? "var(--color-danger)" : undefined, flex: "0 0 auto" }}
        />
        <span style={{ ...finalTitleStyle, color: failed ? "var(--color-danger)" : undefined }}>{t.chat.recall.label}</span>
        <span
          style={{
            flex: "0 1 auto",
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: "var(--font-size-caption)",
            color: failed ? "var(--color-danger)" : "var(--color-text-tertiary)",
          }}
          title={line}
        >
          {line}
        </span>
        <span style={{ flex: 1 }} />
        <Icon name={open ? "chevron-up" : "chevron-down"} size={12} style={{ flex: "0 0 auto" }} />
      </button>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-2)", paddingLeft: 10 }}>
          {record.stages !== undefined && <RecallStageBar cells={record.stages} withMs />}
          {failed && record.error !== null && (
            <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
              {haltedLine(record, t)} · {recallErrorText(record.error.message, t)}
            </p>
          )}
          {/* 入选、问到的条目与表态在右栏「意图」面板里看（图 + 卡片），聊天面只留阶段条 */}
          {record.status === "done" && (record.selected.length > 0 || record.ask.length > 0) && (
            <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-tertiary)" }}>
              {t.chat.recall.detailInPanel}
            </p>
          )}
        </div>
      )}
    </div>
  );
}



/** 终态卡的标题字音：不换行（窄列里四字标题被拆过两行）。 */
const finalTitleStyle: CSSProperties = {
  flex: "0 0 auto",
  whiteSpace: "nowrap",
  fontSize: "var(--font-size-caption)",
  fontWeight: "var(--weight-bold)",
};

/** 小号边框按钮（取消 / 次要动作共用）。 */
const miniButtonStyle: CSSProperties = {
  flex: "0 0 auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  height: 22,
  padding: "0 8px",
  border: "1px solid var(--color-border-subtle)",
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  color: "var(--color-text-secondary)",
  fontFamily: "var(--font-family-base)",
  fontSize: "var(--font-size-micro)",
  cursor: "pointer",
};
