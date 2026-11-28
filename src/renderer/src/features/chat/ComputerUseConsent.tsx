import { createContext, useContext, useEffect } from "react";
import type { AgentEvent } from "@shared/agent-ipc";
import { computerUseConsentTexts, type ComputerUseConsent, type ComputerUseConsentSource } from "@shared/computer-use";
import { LocaleContext } from "../../locale.ts";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { consentRecordKind, shouldShowConsentAskFallback, showsConsentStatusLine } from "./computer-consent.ts";
import "./computer-consent.css";

/**
 * 电脑使用授权的两张 UI（2026-11-27 用户拍板的形态）。
 *
 * 甲（主干，`ComputerUseConsentTail`）：确认行挂在**正在跑的那条电脑工具调用**下面；
 *   答完这一行退成一条记录（三级墨定态 + 撤销），挂在本会话第一处电脑工具调用下面。
 *   不是弹窗、不遮挡、不打断长任务——它就是对话流里的一行。
 * 乙（补口，`ComputerUseConsentStatusLine`）：**已授权之后**输入框上方一条低对比状态行
 *   （「已允许操作这台沙箱桌面」+ 撤销）。未授权时不出现——那一条由甲负责，避免两处同时喊。
 *
 * 授权状态只能来自主进程闸门（用户回答 / 持久记录）；这里的按钮只会回答或撤销，
 * 没有任何「授予」的本地通路。
 */
export interface ComputerUseConsentContextValue {
  consent: ComputerUseConsent;
  /** 这条授权怎么来的（answered / timeout / unavailable / revoked / emergency-stop）；null = 盘上读回的旧值 */
  consentSource: ComputerUseConsentSource | null;
  /** 挂起的提问（agent 事件）；null = 没有在等回答 */
  ask: Extract<AgentEvent, { type: "computerUseConsentAsk" }> | null;
  /** 记录行的挂点：本会话第一处电脑工具调用 */
  triggerToolCallId: string | null;
  /** 确认行的挂点：正在等授权的那条调用（null = 落到输入框上方的兜底位） */
  askToolCallId: string | null;
  /** 行内已经为哪些提问画了确认行（requestId）。兜底位据此确定性地避让，不靠猜 */
  drawnAskIds: ReadonlySet<string>;
  /** 行内画了确认行时登记；卸载 / 提问结束就撤销登记 */
  claimAsk: (requestId: string) => void;
  releaseAsk: (requestId: string) => void;
  onAnswer: (requestId: string, decision: "allowed" | "denied") => void;
  onRevoke: () => void;
}

export const ComputerUseConsentContext = createContext<ComputerUseConsentContextValue | null>(null);

/** 确认行：一句人话 + 「允许本会话」/「拒绝」+ 一行「为什么 / 在你回答之前它没有权限」 */
function AskLine(props: {
  ask: Extract<AgentEvent, { type: "computerUseConsentAsk" }>;
  onAnswer: ComputerUseConsentContextValue["onAnswer"];
}) {
  const t = useT();
  return (
    <div className="cu-ask" role="group" aria-label={t.computerUse.consentAsk}>
      <span className="cu-ask-lead">
        <Icon name="monitor" size={14} />
      </span>
      <span className="cu-ask-q">{t.computerUse.consentAsk}</span>
      <span className="cu-ask-btns">
        <button
          type="button"
          className="btn-accent cu-ask-allow"
          onClick={() => props.onAnswer(props.ask.requestId, "allowed")}
        >
          {t.computerUse.consentAllow}
        </button>
        <button
          type="button"
          className="cu-ask-deny"
          onClick={() => props.onAnswer(props.ask.requestId, "denied")}
        >
          {t.computerUse.consentDeny}
        </button>
      </span>
      <span className="cu-ask-why">{t.computerUse.consentWhy}</span>
    </div>
  );
}

/**
 * 工具行下面的那一小块：确认行（正在等）或记录行（已答完）。挂在工具行组件里，
 * 由它自己判断这条调用是不是挂点——这样折叠 / 分组逻辑一个字都不用改。
 */
export function ComputerUseConsentTail(props: { toolCallId: string; recordOnly?: boolean }) {
  const t = useT();
  const ctx = useContext(ComputerUseConsentContext);
  // 确认行的条件**不含「这一行在跑」**：被闸门挡住的调用恰恰没有结果（pending / blocked），
  // 用 running 判会导致行内永远不画（2026-11-27 真机验收的阻塞级 bug）。
  // 只认「这条调用是不是挂点」——那是主进程事件 + 转录派生的事实。
  const ask = ctx?.ask ?? null;
  // recordOnly：已落定的轮次里只画记录态——问句只属于「正在等」的那一帧，
  // 不能因为挂点恰好是第一处调用而在折叠行下面补一张过期的确认行。
  const drawsAsk = props.recordOnly !== true && ask !== null && ctx !== null && ctx.askToolCallId === props.toolCallId;
  const requestId = drawsAsk && ask !== null ? ask.requestId : null;
  const claimAsk = ctx?.claimAsk;
  const releaseAsk = ctx?.releaseAsk;
  // 登记「行内已经画了」：兜底位据此避让（而不是靠「ask 带没带 toolCallId」猜）。
  // 用一个稳定 deps（requestId + 两个稳定回调）——ctx 每次授权状态变化都是新对象，
  // 把它放进 deps 会反复撤销 / 重登记，兜底位在两帧之间闪一下。
  useEffect(() => {
    if (requestId === null || claimAsk === undefined || releaseAsk === undefined) return;
    claimAsk(requestId);
    return () => releaseAsk(requestId);
  }, [requestId, claimAsk, releaseAsk]);
  if (ctx === null) return null;
  if (drawsAsk && ask !== null) return <AskLine ask={ask} onAnswer={ctx.onAnswer} />;
  const kind = consentRecordKind(ctx.consent, ctx.consentSource, props.toolCallId, ctx.triggerToolCallId);
  if (kind === null) return null;
  return <RecordLine kind={kind} onRevoke={ctx.onRevoke} />;
}

/**
 * 记录行：三级墨定态（已允许 / 已拒绝 / 没人回答）+ 撤销；拒绝类多一行「已告知模型：…」。
 * 「没人回答」与「你拒绝了」必须分开说（2026-11-28 验收 P3-1）：超时 / 窗口全关时用户
 * 从没表态，写「已拒绝」会让他以为自己点过。那句被告知模型的原文按界面语言取——
 * 它就是闸门按同一种语言回给模型的那一句。
 */
function RecordLine(props: { kind: "allowed" | "denied" | "unanswered"; onRevoke: () => void }) {
  const t = useT();
  const locale = useContext(LocaleContext);
  const allowed = props.kind === "allowed";
  const unanswered = props.kind === "unanswered";
  return (
    <div className="cu-record" data-decision={props.kind}>
      <span className="cu-record-lead">
        <Icon name={allowed ? "check" : unanswered ? "circle-help" : "x"} size={14} />
      </span>
      <span className="cu-record-text">
        {allowed
          ? t.computerUse.consentAllowedRecord
          : unanswered
            ? t.computerUse.consentUnansweredRecord
            : t.computerUse.consentDeniedRecord}
      </span>
      <button type="button" className="notice-exit" onClick={props.onRevoke}>
        {t.computerUse.consentRevoke}
      </button>
      {!allowed && (
        <span className="cu-told">
          {/* 原文就是模型收到的那句：超时 / 没人可问时不能说成「用户拒绝了」 */}
          {t.computerUse.consentToldModel(
            unanswered
              ? computerUseConsentTexts(locale).deniedUnanswered
              : computerUseConsentTexts(locale).denied,
          )}
        </span>
      )}
    </div>
  );
}

/**
 * 确认行的兜底位（输入框上方）：正在等授权、但转录里找不到一条在跑的电脑工具调用
 * （重开窗口、工具行已经折走）。没有这一处的话用户就答不了，而主进程要等到 120s 超时
 * 才按拒绝收口——那等于让一次本来能办成的操作白白失败。
 */
export function ComputerUseConsentAskFallback() {
  const ctx = useContext(ComputerUseConsentContext);
  if (ctx === null || !shouldShowConsentAskFallback(ctx.ask, ctx.drawnAskIds)) return null;
  return <AskLine ask={ctx.ask!} onAnswer={ctx.onAnswer} />;
}

/** 乙：输入框上方的常驻状态行（只有已授权才出现；撤销永远在手边） */
export function ComputerUseConsentStatusLine() {
  const t = useT();
  const ctx = useContext(ComputerUseConsentContext);
  if (ctx === null || !showsConsentStatusLine(ctx.consent)) return null;
  return (
    <div className="cu-status" role="status" aria-label={t.computerUse.consentStatusAllowed}>
      <span className="cu-status-lead">
        <Icon name="monitor" size={12} />
      </span>
      <span className="cu-status-text">{t.computerUse.consentStatusAllowed}</span>
      <span className="row-trailing">
        <button type="button" className="notice-exit" onClick={ctx.onRevoke}>
          {t.computerUse.consentRevoke}
        </button>
      </span>
    </div>
  );
}
