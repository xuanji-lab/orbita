/**
 * 听写的一行状态：进行中说「在干什么、怎么结束」，出了问题说原因（服务端的原话用等宽跟在后面）。
 * 状态用图标 + 文字，红色只给失败（设计系统：颜色是第二信号）。厂商名跟着这次听写用的那家。
 *
 * 从 Composer 提出来（2026-10-14）：意图确认卡的两个输入框（背景补充 / 大字陈述）
 * 也用同一行文案——第二个消费者出现才建这个文件。
 */
import { Icon } from "../../shell/Icon.tsx";
import { useT } from "../../locale.ts";
import type { DictationPhase, DictationProblem } from "./useDictation.ts";
import type { DictationProvider } from "@shared/voice";

export function DictationStatus(props: {
  phase: DictationPhase;
  problem: DictationProblem | null;
  provider: DictationProvider | null;
}) {
  const t = useT();
  const problem = props.problem;
  const text =
    problem !== null
      ? problem.kind === "mic-denied"
        ? t.voice.micDenied
        : problem.kind === "mic-unavailable"
          ? t.voice.micUnavailable
          : t.voice.failures[problem.reason](problem.provider)
      : props.phase === "connecting"
        ? t.voice.connecting(props.provider ?? "doubao")
        : props.phase === "finishing"
          ? t.voice.finishing
          : t.voice.listening;
  const detail = problem !== null && problem.kind === "service" ? problem.detail : undefined;
  return (
    <div
      role={problem !== null ? "alert" : "status"}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        minWidth: 0,
        fontSize: "var(--font-size-sm)",
        color: problem !== null ? "var(--color-danger)" : "var(--color-text-secondary)",
      }}
    >
      <Icon name={problem !== null ? "triangle-alert" : "mic"} size={12} strokeWidth={1.8} style={{ flex: "0 0 auto" }} />
      <span style={{ minWidth: 0 }}>{text}</span>
      {detail !== undefined && (
        <code
          title={detail}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontFamily: "var(--font-family-mono)",
            color: "var(--color-text-tertiary)",
          }}
        >
          {detail}
        </code>
      )}
    </div>
  );
}
