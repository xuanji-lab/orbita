/**
 * 通话条：编排对话页输入框上方的一条浮条（与排队条、审批条同位同配方：glass-card glass-float，
 * 在 Pane 的 footer 网格行里，不盖对话）。一行：状态（在听 / 在想 / 在说）· 麦克风电平 · 时长 ·
 * 听到的半句 …… 静音、挂断钉在行尾。不露档位，固定放行（编排页的规矩）。
 *
 * 没在通话但有问题要说（缺配置、麦克风被拒、听写断了）时，同一个位置换成一行提示：原因 + 去处 + 关掉。
 * 状态用图标 + 文字，红色只给出错与挂断（设计系统：颜色是第二信号）。
 */
import { Icon, type IconName } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { PanelButton } from "../../shell/RightPanel";
import { useT } from "../../locale.ts";
import type { Messages } from "../../messages-en.ts";
import type { CallPhase } from "./call-machine.ts";
import type { CallProblem, VoiceCall } from "./useVoiceCall.ts";
import "./call-bar.css";

/** 电平条的格数与每格的门槛（RMS 很少过 0.3，按对数感受分档） */
const METER_STEPS = [0.01, 0.03, 0.07, 0.14] as const;

function phaseIcon(phase: CallPhase, muted: boolean): { name: IconName; spin?: boolean; breath?: boolean } {
  if (phase === "connecting" || phase === "thinking") return { name: "loader-circle", spin: true };
  if (phase === "speaking") return { name: "volume-2" };
  return muted ? { name: "mic-off" } : { name: "audio-lines", breath: true };
}

function phaseLabel(phase: CallPhase, muted: boolean, t: Messages): string {
  if (phase === "connecting") return t.voice.call.connecting;
  if (phase === "thinking") return t.voice.call.thinking;
  if (phase === "speaking") return t.voice.call.speaking;
  return muted ? t.voice.call.muted : t.voice.call.listening;
}

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

export function problemText(problem: CallProblem, t: Messages): { text: string; detail?: string } {
  switch (problem.kind) {
    case "missing":
      return {
        text: problem.dictation && problem.speech ? t.voice.call.missingBoth : problem.dictation ? t.voice.call.missingDictation : t.voice.call.missingSpeech,
      };
    case "mic-denied":
      return { text: t.voice.micDenied };
    case "mic-unavailable":
      return { text: t.voice.micUnavailable };
    case "dictation":
      return { text: t.voice.failures[problem.reason](problem.provider), ...(problem.detail === undefined ? {} : { detail: problem.detail }) };
    case "speech":
      return { text: t.voice.speechFailures[problem.reason], ...(problem.detail === undefined ? {} : { detail: problem.detail }) };
    case "playback":
      return { text: t.voice.call.playbackFailed };
  }
}

function ProblemLine(props: { problem: CallProblem; onOpenSettings: (() => void) | null; onDismiss: () => void }) {
  const t = useT();
  const { text, detail } = problemText(props.problem, t);
  const settingsExit = props.problem.kind === "missing" || props.problem.kind === "dictation" || props.problem.kind === "speech";
  return (
    <div role="alert" className="call-problem">
      <Icon name="triangle-alert" size={14} strokeWidth={1.8} style={{ flex: "0 0 auto" }} />
      <span className="call-problem-text">{text}</span>
      {detail !== undefined && (
        <code className="call-problem-detail" title={detail}>
          {detail}
        </code>
      )}
      <span className="row-trailing call-actions">
        {settingsExit && props.onOpenSettings !== null && (
          <PanelButton onClick={props.onOpenSettings}>{t.voice.call.openSettings}</PanelButton>
        )}
        <IconButton label={t.voice.call.dismiss} size={24} onClick={props.onDismiss}>
          <Icon name="x" size={14} />
        </IconButton>
      </span>
    </div>
  );
}

export function CallBar(props: { call: VoiceCall; onOpenSettings: (() => void) | null }) {
  const t = useT();
  const { call } = props;
  if (call.phase === null) {
    if (call.problem === null) return null;
    return (
      <section aria-label={t.voice.call.label} className="glass-card glass-float call-bar">
        <ProblemLine problem={call.problem} onOpenSettings={props.onOpenSettings} onDismiss={call.clearProblem} />
      </section>
    );
  }
  const icon = phaseIcon(call.phase, call.muted);
  const listening = call.phase === "listening" && !call.muted;
  const heard = call.phase === "listening" && call.heard.trim() !== "" ? call.heard : null;
  return (
    <section aria-label={t.voice.call.label} className="glass-card glass-float call-bar">
      <div className="call-row">
        <span className="call-state" data-phase={call.phase} role="status">
          <Icon
            name={icon.name}
            size={15}
            strokeWidth={1.8}
            spin={icon.spin === true}
            className={icon.breath === true ? "orbita-breath" : undefined}
          />
          <span className="call-state-label">{phaseLabel(call.phase, call.muted, t)}</span>
        </span>
        <span className="call-meter" aria-hidden="true" data-live={listening ? "true" : undefined}>
          {METER_STEPS.map((step) => (
            <span key={step} className="call-meter-bar" data-on={listening && call.level >= step ? "true" : undefined} />
          ))}
        </span>
        <span className="call-clock">{clock(call.elapsed)}</span>
        {heard !== null && (
          <span className="call-heard" title={heard}>
            {t.voice.call.heard(heard)}
          </span>
        )}
        <span className="row-trailing call-actions">
          <IconButton
            label={call.muted ? t.voice.call.unmute : t.voice.call.mute}
            size={28}
            active={call.muted}
            onClick={call.toggleMute}
          >
            <Icon name={call.muted ? "mic-off" : "mic"} size={15} strokeWidth={1.8} />
          </IconButton>
          <button type="button" className="quiet-control call-hangup" onClick={call.hangUp}>
            <Icon name="phone-off" size={14} strokeWidth={1.8} />
            {t.voice.call.hangUp}
          </button>
        </span>
      </div>
      {call.problem !== null && (
        <ProblemLine problem={call.problem} onOpenSettings={props.onOpenSettings} onDismiss={call.clearProblem} />
      )}
    </section>
  );
}
