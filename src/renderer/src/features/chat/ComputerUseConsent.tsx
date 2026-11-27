import { createContext, useContext } from "react";
import type { AgentEvent } from "@shared/agent-ipc";
import {
  COMPUTER_USE_CONSENT_DENIED_TEXT,
  type ComputerUseConsent,
} from "@shared/computer-use";
import { Icon } from "../../shell/Icon";
import { useT } from "../../locale.ts";
import { consentRecordKind, showsConsentStatusLine } from "./computer-consent.ts";
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
  /** 挂起的提问（agent 事件）；null = 没有在等回答 */
  ask: Extract<AgentEvent, { type: "computerUseConsentAsk" }> | null;
  /** 记录行的挂点：本会话第一处电脑工具调用 */
  triggerToolCallId: string | null;
  /** 确认行的挂点：正在等授权的那条调用（null = 落到输入框上方的兜底位） */
  askToolCallId: string | null;
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
export function ComputerUseConsentTail(props: { toolCallId: string; running: boolean }) {
  const t = useT();
  const ctx = useContext(ComputerUseConsentContext);
  if (ctx === null) return null;
  if (ctx.ask !== null && props.running && ctx.askToolCallId === props.toolCallId) {
    return <AskLine ask={ctx.ask} onAnswer={ctx.onAnswer} />;
  }
  const kind = consentRecordKind(ctx.consent, props.toolCallId, ctx.triggerToolCallId);
  if (kind === null) return null;
  return <RecordLine kind={kind} onRevoke={ctx.onRevoke} />;
}

/** 记录行：三级墨定态（已允许 / 已拒绝）+ 撤销；拒绝时多一行「已告知模型：…」 */
function RecordLine(props: { kind: "allowed" | "denied"; onRevoke: () => void }) {
  const t = useT();
  const allowed = props.kind === "allowed";
  return (
    <div className="cu-record" data-decision={props.kind}>
      <span className="cu-record-lead">
        <Icon name={allowed ? "check" : "x"} size={14} />
      </span>
      <span className="cu-record-text">
        {allowed ? t.computerUse.consentAllowedRecord : t.computerUse.consentDeniedRecord}
      </span>
      <button type="button" className="notice-exit" onClick={props.onRevoke}>
        {t.computerUse.consentRevoke}
      </button>
      {!allowed && (
        <span className="cu-told">{t.computerUse.consentToldModel(COMPUTER_USE_CONSENT_DENIED_TEXT)}</span>
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
  if (ctx === null || ctx.ask === null || ctx.askToolCallId !== null) return null;
  return <AskLine ask={ctx.ask} onAnswer={ctx.onAnswer} />;
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
