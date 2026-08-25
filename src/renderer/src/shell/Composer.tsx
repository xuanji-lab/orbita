import { useState } from "react";
import { Icon, type IconName } from "./Icon";

/**
 * 输入框。**跨首页与聊天页是同一个组件、同一个宽度**（R8-01 ②：宽度连续性）——
 * 两边都由外层给 `min(100%, var(--content-max-width))`，这里只负责 100% 铺满。
 *
 * 它是第三层玻璃：浮在内容面之上，不在文档流里当一个方盒子。
 *
 * 圆角取 `--radius-xl`，**不取** `--radius-composer`(14px)。设计系统对这条自相矛盾：
 * readme 的 *Corners and borders* 说 composer 是唯一的例外，而 `Composer.jsx` 与
 * `spacing.css` 的注释说「它首先是玻璃卡，所以吃 --radius-xl」。取后者：
 * 玻璃卡就该有统一标准，一个例外换不来任何东西（2026-08-25 wafo 定）。
 */
export function Composer(props: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  disabled?: boolean;
  running?: boolean;
  bottomSlot?: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  const sendable = !disabled && props.running !== true && props.value.trim() !== "";
  return (
    <div
      style={{
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px 8px",
        background: "var(--glass-bg)",
        border: "1px solid var(--glass-border)",
        borderRadius: "var(--radius-xl)",
        boxShadow: "var(--shadow-composer)",
        WebkitBackdropFilter: "blur(var(--glass-blur))",
        backdropFilter: "blur(var(--glass-blur))",
      }}
    >
      <textarea
        rows={2}
        value={props.value}
        disabled={disabled}
        placeholder={props.placeholder}
        onChange={(event) => props.onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          event.preventDefault();
          if (sendable) props.onSubmit();
        }}
        style={{
          width: "100%",
          padding: "2px 4px",
          border: 0,
          background: "transparent",
          resize: "none",
          outline: "none",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-input)",
          lineHeight: "var(--line-height-input)",
          color: "var(--color-text-primary)",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {props.bottomSlot}
        <button
          type="button"
          aria-label="Send"
          title={props.running === true ? "Waiting for the current turn" : "Send"}
          disabled={!sendable}
          onClick={() => props.onSubmit()}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
          style={{
            marginInlineStart: "auto",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            flex: "0 0 auto",
            padding: 0,
            border: 0,
            borderRadius: "var(--radius-pill)",
            // 玻璃上的禁用态用实色，不用 opacity（设计系统 *Hover, press, disabled*）
            background: !sendable
              ? "var(--color-bg-hover)"
              : hover
                ? "var(--color-accent-strong)"
                : "var(--color-accent)",
            color: sendable ? "var(--color-accent-fg)" : "var(--color-text-tertiary)",
            cursor: sendable ? "pointer" : "not-allowed",
            transition: "var(--transition-hover)",
          }}
        >
          <Icon name="arrow-up" size={16} />
        </button>
      </div>
    </div>
  );
}

/**
 * composer 底栏里的安静控件。选中态用 `--color-mode-active-*`（明主题蓝、暗主题黄），
 * hover 是中性抬升——两者是设计系统里 accent 仅有的两个去处之一。
 */
export function Chip(props: {
  icon?: IconName;
  active?: boolean;
  disabled?: boolean;
  title?: string;
  onClick?: () => void;
  children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const disabled = props.disabled === true;
  const active = props.active === true;
  return (
    <button
      type="button"
      title={props.title}
      aria-pressed={props.onClick === undefined ? undefined : active}
      disabled={disabled}
      onClick={props.onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        maxWidth: 260,
        padding: "3px 8px",
        border: 0,
        borderRadius: "var(--radius-md)",
        background: active
          ? "var(--color-mode-active-bg)"
          : hover && !disabled
            ? "var(--color-bg-hover)"
            : "transparent",
        color: active
          ? "var(--color-mode-active-fg)"
          : disabled
            ? "var(--color-text-tertiary)"
            : hover
              ? "var(--color-text-primary)"
              : "var(--color-text-secondary)",
        fontFamily: "var(--font-family-base)",
        fontSize: "var(--font-size-control)",
        whiteSpace: "nowrap",
        cursor: disabled ? "not-allowed" : props.onClick === undefined ? "default" : "pointer",
        transition: "var(--transition-hover)",
      }}
    >
      {props.icon !== undefined && <Icon name={props.icon} size={12} />}
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
        {props.children}
      </span>
    </button>
  );
}
