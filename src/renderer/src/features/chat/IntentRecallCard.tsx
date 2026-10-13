/**
 * 意图召回的流水线卡片（实验功能 intent-system）—— 聊天流里的过程卡。
 *
 * 运行卡（RecallCardState）：11 格阶段条（门卫 → 理解 → 打分 → 过线 → 写理由 →
 * 去重 → 摘句 → 确认 → 写上下文 → 回答 → 回写边）+ 场景行 + 已用时间 + 取消。
 * 终态卡（IntentRecallRecord）：默认收起一行（完成给数字、失败给原因、取消一句话），
 * 展开看阶段条逐格用时、S4 总结与确认表态。
 *
 * 纯展示组件；数据归约（applyRecallEvent）在 shared，本文件不持状态机。
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
import { confirmVerdictCounts } from "../../../../shared/intent-confirm.ts";
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
    <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)", flexWrap: "wrap" }}>
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

/** 运行卡：转录末尾、Responding 之前。 */
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
    <div
      style={{
        display: "grid",
        gap: "var(--space-2)",
        minWidth: 0,
        marginTop: "var(--space-4)",
        padding: "var(--space-3)",
        borderRadius: "var(--radius-md)",
        background: "var(--color-bg-muted)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", minWidth: 0 }}>
        <Icon name="shield-check" size={14} style={{ color: "var(--color-text-secondary)" }} />
        <span style={{ fontSize: "var(--font-size-control)", fontWeight: "var(--weight-bold)" }}>
          {t.chat.recall.label}
        </span>
        {(card.scene !== null || card.want !== "") && (
          <span
            style={{
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
          <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" }}>
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

/** 终态卡：收起一行结论，展开看阶段用时、S4 总结与确认表态。 */
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
    <div style={{ display: "grid", gap: "var(--space-1)", minWidth: 0, marginTop: "var(--space-4)" }}>
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
          borderTop: "1px solid var(--color-border-subtle)",
          paddingTop: "var(--space-3)",
          background: "transparent",
          cursor: "pointer",
          textAlign: "left",
          color: "var(--color-text-secondary)",
        }}
      >
        <Icon
          name={record.status === "done" ? "shield-check" : failed ? "triangle-alert" : "circle-off"}
          size={14}
          style={{ color: failed ? "var(--color-danger)" : "var(--color-text-tertiary)" }}
        />
        <span style={{ fontSize: "var(--font-size-caption)", fontWeight: "var(--weight-bold)" }}>
          {t.chat.recall.label}
        </span>
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
        <Icon name={open ? "chevron-up" : "chevron-down"} size={12} />
      </button>
      {open && (
        <div style={{ display: "grid", gap: "var(--space-2)", paddingLeft: 10 }}>
          {record.stages !== undefined && <RecallStageBar cells={record.stages} withMs />}
          {failed && record.error !== null && (
            <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-danger)" }}>
              {haltedLine(record, t)} · {recallErrorText(record.error.message, t)}
            </p>
          )}
          {record.status === "done" && record.confirm != null && (
            <ConfirmVerdictBlock record={record} />
          )}
          {record.status === "done" && record.selected.length > 0 && <SelectedBlock record={record} />}
        </div>
      )}
    </div>
  );
}

/** 确认表态的展开块：问了几条、每条的表态与改字。 */
function ConfirmVerdictBlock(props: { record: IntentRecallRecord }) {
  const t = useT();
  const record = props.record;
  const confirm = record.confirm;
  if (confirm === null || confirm === undefined) return null;
  const counts = confirmVerdictCounts(confirm.answers);
  return (
    <div style={{ display: "grid", gap: "var(--space-1)" }}>
      <p style={{ margin: 0, fontSize: "var(--font-size-caption)", color: "var(--color-text-secondary)" }}>
        {t.chat.recall.confirm.askedLine(record.ask.length, counts.yes, counts.no, counts.skip)}
        {confirm.note !== "" ? ` · ${confirm.note}` : ""}
      </p>
      {record.ask.map((item) => {
        const answer = confirm.answers.find((a) => a.askId === item.askId);
        if (answer === undefined) return null;
        const verdict =
          answer.verdict === "yes"
            ? t.chat.recall.confirm.verdictYes
            : answer.verdict === "no"
              ? t.chat.recall.confirm.verdictNo
              : t.chat.recall.confirm.verdictSkip;
        return (
          <p
            key={item.askId}
            style={{
              margin: 0,
              fontSize: "var(--font-size-micro)",
              lineHeight: "var(--line-height-caption)",
              color: "var(--color-text-tertiary)",
            }}
          >
            <span style={{ fontFamily: "var(--font-family-mono)" }}>{item.slot}</span> {item.statement}
            {answer.edited !== undefined && (
              <>
                {" → "}
                <span style={{ color: "var(--color-text-secondary)" }}>
                  {answer.edited}（{t.chat.recall.confirm.yourEdit}）
                </span>
              </>
            )}
            {" · "}
            <span>{verdict}</span>
          </p>
        );
      })}
    </div>
  );
}

/** 入选表的展开块：时间 · 会话 · 岗 · 摘句（human 优先，退回 why）。 */
function SelectedBlock(props: { record: IntentRecallRecord }) {
  return (
    <div style={{ display: "grid", gap: "var(--space-1)" }}>
      {props.record.selected.map((item) => (
        <div
          key={item.qaId}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(56px, auto) minmax(0, 1fr) minmax(48px, auto)",
            gap: "var(--space-2)",
            fontSize: "var(--font-size-micro)",
            lineHeight: "var(--line-height-caption)",
            color: "var(--color-text-secondary)",
          }}
        >
          <span style={{ fontFamily: "var(--font-family-mono)", color: "var(--color-text-tertiary)" }}>{item.when}</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {item.title}
          </span>
          <span style={{ fontFamily: "var(--font-family-mono)", color: "var(--color-text-tertiary)" }}>
            {item.slots.join(" · ")}
            {item.score !== undefined ? ` ${item.score.toFixed(1)}` : ""}
          </span>
          <span
            style={{
              gridColumn: "1 / -1",
              color: "var(--color-text-tertiary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {item.human !== undefined && item.human !== "" ? item.human : item.why}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 小号边框按钮（取消 / 次要动作共用）。 */
const miniButtonStyle: CSSProperties & React.HTMLAttributes<HTMLButtonElement>["style"] = {
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
