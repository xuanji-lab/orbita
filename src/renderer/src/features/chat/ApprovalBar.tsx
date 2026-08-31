import { useEffect, useRef, useState } from "react";
import type { PermissionAnswer } from "@shared/permission";
import { Icon } from "../../shell/Icon";
import type { PendingApproval } from "./session-states.ts";

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
  const [edited, setEdited] = useState(() => stringify(props.approval.input));
  const [editing, setEditing] = useState(false);
  const allowRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setEdited(stringify(props.approval.input));
    setEditing(false);
    allowRef.current?.focus();
  }, [props.approval.requestId, props.approval.input]);

  const answer = (value: PermissionAnswer) => props.onAnswer(props.approval.requestId, value);

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
      aria-label="Tool approval"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        answer({ behavior: "deny", message: "Denied by the user." });
      }}
      style={{
        display: "grid",
        gap: "var(--space-3)",
        padding: "var(--space-4)",
        background: "var(--glass-bg)",
        border: "1px solid var(--glass-border)",
        borderRadius: "var(--radius-xl)",
        // 比 composer 再抬一级的阴影：它是当前唯一挡路的东西
        boxShadow: "var(--shadow-popover)",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        backdropFilter: "blur(var(--glass-blur))",
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: "var(--space-2)" }}>
        <span style={{ display: "inline-flex", color: "var(--color-text-secondary)" }}>
          <Icon name="shield-check" size={14} />
        </span>
        <strong style={{ fontSize: "var(--font-size-control)", fontWeight: 600 }}>
          Run {props.approval.toolName}?
        </strong>
        <span
          style={{
            fontFamily: "var(--font-family-mono)",
            fontSize: "var(--font-size-micro)",
            color: "var(--color-text-tertiary)",
            marginInlineStart: "auto",
          }}
        >
          Enter to allow · Esc to deny
        </span>
      </div>

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
            fontSize: "var(--font-size-micro)",
          }}
        />
      ) : (
        <pre style={{ ...codeStyle, margin: 0, overflowX: "auto" }}>{edited}</pre>
      )}

      <div style={{ display: "flex", gap: "var(--space-2)" }}>
        <button ref={allowRef} type="button" onClick={allow} style={{ ...buttonStyle, ...primaryStyle }}>
          Allow
        </button>
        <button
          type="button"
          onClick={() => answer({ behavior: "deny", message: "Denied by the user." })}
          style={buttonStyle}
        >
          Deny
        </button>
        <button type="button" onClick={() => setEditing(!editing)} style={buttonStyle}>
          {editing ? "Stop editing" : "Edit input"}
        </button>
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
  fontSize: "var(--font-size-micro)",
  lineHeight: "var(--line-height-micro)",
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
  fontSize: "var(--font-size-control)",
  cursor: "pointer",
  transition: "var(--transition-hover)",
};

/** accent 只给主操作（一屏一个 accent） */
const primaryStyle: React.CSSProperties = {
  background: "var(--color-accent)",
  color: "var(--color-accent-fg)",
  fontWeight: "var(--weight-medium)",
};
