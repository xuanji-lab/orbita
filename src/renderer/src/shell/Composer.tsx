import { useState } from "react";
import { Icon } from "./Icon";
import { isSubmitKey } from "./composer-keys.ts";
import { containsMathDelimiter } from "./math-text.ts";
import { MathText } from "./MathText.tsx";

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
  /** 打断当前这一轮。没字 + 跑着时发送键变停止键；有字时永远是发送（跑着 = 排队） */
  onStop: () => void;
  placeholder: string;
  disabled?: boolean;
  running?: boolean;
  bottomSlot?: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  // Σ 门控预览（docs/plans/2026-09-05-用户输入公式渲染.md）：草稿有 $ 才出现按钮，
  // 点了才展开预览条；$ 删光则按钮与预览条一起消失——不打公式的人零打扰。
  const [previewOpen, setPreviewOpen] = useState(false);
  const mathInDraft = containsMathDelimiter(props.value);
  const previewVisible = mathInDraft && previewOpen;
  const disabled = props.disabled === true;
  const running = props.running === true;
  // 有字就能发——跑着的时候 Enter 是排队发送（C-1）。没字 + 跑着 = 停止键：
  // 同一个位置的两面，按输入态切换。想停止时清掉草稿即可，排队是高频动作、停止是少数。
  const sendable = !disabled && props.value.trim() !== "";
  const stopping = running && !sendable;
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
          // 组词中的 Enter 是「确认候选词」，不是发送——规则与用例在 composer-keys.ts
          if (!isSubmitKey({
            key: event.key,
            shiftKey: event.shiftKey,
            isComposing: event.nativeEvent.isComposing,
            keyCode: event.keyCode,
          })) return;
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
      {previewVisible && (
        <div
          style={{
            borderTop: "1px solid var(--color-border-subtle)",
            padding: "6px 4px 2px",
          }}
        >
          <div
            style={{
              fontSize: "var(--font-size-micro)",
              color: "var(--color-text-tertiary)",
              marginBottom: 2,
              userSelect: "none",
            }}
          >
            Math preview
          </div>
          <div
            style={{
              maxHeight: 140,
              overflow: "auto",
              fontSize: "var(--font-size-input)",
              lineHeight: 1.7,
              color: "var(--color-text-primary)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            <MathText text={props.value} />
          </div>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {mathInDraft && (
          <button
            type="button"
            title="Preview math"
            aria-label="Preview math"
            aria-pressed={previewVisible}
            onClick={() => setPreviewOpen((value) => !value)}
            style={{
              flex: "0 0 auto",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 24,
              height: 24,
              padding: 0,
              border: 0,
              borderRadius: "var(--radius-pill)",
              // 按下态用选中底（accent-soft 系），未按下保持安静的三级墨——次级工具不抢发送键
              background: previewVisible ? "var(--color-bg-active)" : "transparent",
              color: previewVisible ? "var(--color-text-primary)" : "var(--color-text-tertiary)",
              cursor: "pointer",
              transition: "var(--transition-hover)",
            }}
          >
            <Icon name="sigma" size={14} />
          </button>
        )}
        {props.bottomSlot}
        <button
          type="button"
          aria-label={sendable ? "Send" : stopping ? "Stop" : "Send"}
          title={sendable ? "Send" : stopping ? "Stop this turn" : "Send"}
          disabled={!sendable && !stopping}
          onClick={() => (sendable ? props.onSubmit() : props.onStop())}
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
            background: sendable
              ? hover
                ? "var(--color-accent-strong)"
                : "var(--color-accent)"
              : stopping
                ? "var(--color-danger-soft)"
                : "var(--color-bg-hover)",
            color: sendable
              ? "var(--color-accent-fg)"
              : stopping
                ? "var(--color-danger)"
                : "var(--color-text-tertiary)",
            cursor: sendable || stopping ? "pointer" : "not-allowed",
            transition: "var(--transition-hover)",
          }}
        >
          <Icon name={sendable ? "arrow-up" : "square"} size={sendable ? 16 : 12} />
        </button>
      </div>
    </div>
  );
}
