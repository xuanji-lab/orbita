import { useEffect, useRef, useState } from "react";
import type { PermissionAnswer } from "@shared/permission";
import { Icon } from "../../shell/Icon";
import type { PendingApproval } from "./session-states.ts";
import { useT } from "../../locale.ts";

/**
 * 工具审批条（R6-04 五屏之一）。设计系统的相关硬规则都落在这里：
 *  - **浮起的卡，不是方盒子**：玻璃配方 + popover 阴影，落在 composer 正上方——
 *    它比聊天面高一层，因为它要求一个回答才继续
 *  - **不用 accent 染底**：需要回答的信号交给标题文字与位置，不是一块蓝
 *  - 状态优先用文字，颜色是第二信号
 *  - **键盘优先**：打开即聚焦「Allow」，Esc 拒绝——R6-03 要求首版就能键盘应答
 *  - 玻璃只用在面上，文字始终是实色
 */

export function ApprovalBar(props: {
  approval: PendingApproval;
  onAnswer: (requestId: string, answer: PermissionAnswer) => void;
}) {
  const t = useT();
  const [edited, setEdited] = useState(() => stringify(props.approval.input));
  const [editing, setEditing] = useState(false);
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEdited(stringify(props.approval.input));
    setEditing(false);
    allowRef.current?.focus();
  }, [props.approval.requestId, props.approval.input]);

  const answer = (value: PermissionAnswer) => props.onAnswer(props.approval.requestId, value);

  /**
   * 卡片的三种形态（2026-10 computer use PR4）：
   *   - session：会话授权卡（允许 = 整条会话放行，不是这一次）
   *   - risk：破坏性动作确认（D1 组合键 / D2 破坏词 / D3 同点连点）——保留入参预览，
   *     「仍要执行」= 用户看过之后照常执行
   *   - 其余：普通逐次审批（manual 档）
   */
  const scope = props.approval.scope ?? "call";
  const risk = props.approval.risk;
  const riskText =
    risk === undefined
      ? null
      : risk.rule === "key"
        ? t.approval.riskKeys(risk.detail)
        : risk.rule === "command"
          ? t.approval.riskCommand(risk.detail)
          : t.approval.riskRepeat(Number(risk.detail));

  const allow = () => {
    if (!editing) return answer({ behavior: "allow" });
    try {
      answer({ behavior: "allow", input: JSON.parse(edited) as unknown });
    } catch {
      // 改坏了就按原样放行，总比卡住强；解析失败时用户还能自己改回来
      answer({ behavior: "allow" });
    }
  };

  return (
    <section
      aria-label={t.approval.aria}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        answer({ behavior: "deny", message: "Denied by the user." });
      }}
      // 比 composer 再抬一级的阴影：它是当前唯一挡路的东西
      className="glass-card glass-float"
      style={{
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <span style={{ display: "inline-flex", color: "var(--color-text-secondary)" }}>
          <Icon name="shield-check" size={14} />
        </span>
        <strong style={{ fontSize: "var(--font-size-base)", fontWeight: 600 }}>
          {scope === "session"
            ? t.approval.sessionTitle
            : riskText !== null
              ? t.approval.riskTitle
              : t.approval.run(props.approval.toolName)}
        </strong>
        <span
          style={{
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-tertiary)",
            marginInlineStart: "auto",
          }}
        >
          {t.approval.keys}
        </span>
      </div>

      {scope === "session" && (
        <p style={{ margin: 0, fontSize: "var(--font-size-sm)", lineHeight: "var(--line-height-ui)", color: "var(--color-text-secondary)" }}>
          {t.approval.sessionBody}
        </p>
      )}
      {riskText !== null && (
        <div style={{ display: "grid", gap: "var(--space-1)" }}>
          <strong style={{ fontSize: "var(--font-size-sm)", fontWeight: 600, color: "var(--color-text-primary)" }}>
            {riskText}
          </strong>
          <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-tertiary)" }}>{t.approval.riskHint}</span>
        </div>
      )}

      {editing ? (
        <textarea
          value={edited}
          onChange={(event) => setEdited(event.target.value)}
          rows={Math.min(10, edited.split("\n").length + 1)}
          style={{
            ...codeStyle,
            resize: "vertical",
            font: "inherit",
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-xs)",
          }}
        />
      ) : (
        <pre style={{ ...codeStyle, margin: 0, overflowX: "auto" }}>{edited}</pre>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button ref={allowRef} type="button" onClick={allow} style={{ ...buttonStyle, ...primaryStyle }}>
          {scope === "session" ? t.approval.allowSession : risk !== undefined ? t.approval.allowRisk : t.approval.allow}
        </button>
        <button
          type="button"
          onClick={() => answer({ behavior: "deny", message: "Denied by the user." })}
          style={buttonStyle}
        >
          {risk !== undefined && scope !== "session" ? t.approval.cancelRisk : t.approval.deny}
        </button>
        {/* 会话授权卡不提供「改参数」：允许的是整条会话，改这一步的入参没有意义
            （闸门也不会采纳这张卡上的编辑） */}
        {scope !== "session" && (
          <button type="button" onClick={() => setEditing(!editing)} style={buttonStyle}>
            {editing ? t.approval.stopEditing : t.approval.editInput}
          </button>
        )}
      </div>
    </section>
  );
}

function stringify(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? String(input);
  } catch {
    return String(input);
  }
}

const codeStyle: React.CSSProperties = {
  padding: "var(--space-3)",
  background: "var(--color-chat-muted-bg)",
  border: 0,
  borderRadius: "var(--radius-md)",
  fontFamily: "var(--font-family-mono)",
  fontSize: "var(--font-size-xs)",
  lineHeight: "var(--line-height-ui)",
  color: "var(--color-text-primary)",
  whiteSpace: "pre-wrap",
};

const buttonStyle: React.CSSProperties = {
  height: "var(--control-height-md)",
  padding: "0 var(--space-4)",
  background: "var(--color-bg-muted)",
  color: "var(--color-text-primary)",
  border: 0,
  borderRadius: "var(--radius-md)",
  font: "inherit",
  fontSize: "var(--font-size-base)",
  cursor: "pointer",
  transition: "var(--transition-hover)",
};

/** accent 只给主操作（一屏一个 accent） */
const primaryStyle: React.CSSProperties = {
  background: "var(--color-accent)",
  color: "var(--color-accent-fg)",
  fontWeight: "var(--weight-medium)",
};
