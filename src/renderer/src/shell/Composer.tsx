import { useLayoutEffect, useRef } from "react";
import { Icon } from "./Icon";
import { composerBoxHeight, COMPOSER_MIN_ROWS } from "./composer-height.ts";
import { isSubmitKey } from "./composer-keys.ts";

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
/** 按内容把输入框的高度量好、设上。行高与 padding 从实际样式来（主题会换它们）。 */
function fitComposerHeight(el: HTMLTextAreaElement): void {
  // 先塌回 auto 才能量到真实内容高度，否则只涨不落
  el.style.height = "auto";
  const computed = getComputedStyle(el);
  const lineHeight = Number.parseFloat(computed.lineHeight);
  const padding =
    Number.parseFloat(computed.paddingTop) + Number.parseFloat(computed.paddingBottom);
  const { height, scrollable } = composerBoxHeight(
    el.scrollHeight,
    Number.isFinite(lineHeight) ? lineHeight : 22,
    Number.isFinite(padding) ? padding : 0,
  );
  el.style.height = `${height}px`;
  el.style.overflowY = scrollable ? "auto" : "hidden";
}

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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 随内容长高：撤回能把好几条排队消息堆进来，写死两行就只能盲着改。
  // useLayoutEffect 而非 useEffect——量完就改高度，放到绘制后会闪一帧。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    fitComposerHeight(el);
  }, [props.value]);
  // 换主题也要重量：稿纸两档的行高是 24px，浅 / 暗是 22px——只跟着 value 量，切主题后高度
  // 停在上一档，稿纸的格子会被切掉半行（2026-09-25 实测）。
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (el === null) return;
    const observer = new MutationObserver(() => fitComposerHeight(el));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  const disabled = props.disabled === true;
  const running = props.running === true;
  // 有字就能发——跑着的时候 Enter 是排队发送（C-1）。没字 + 跑着 = 停止键：
  // 同一个位置的两面，按输入态切换。想停止时清掉草稿即可，排队是高频动作、停止是少数。
  const sendable = !disabled && props.value.trim() !== "";
  const stopping = running && !sendable;
  return (
    <div
      className="glass-card"
      style={{
        width: "100%",
        minWidth: 0,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "10px 12px 8px",
      }}
    >
      <textarea
        ref={textareaRef}
        className="composer-input"
        rows={COMPOSER_MIN_ROWS}
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
          border: 0,
          // 高度由上面的 layout effect 接管；把手会和自增高打架
          resize: "none",
          overflowY: "hidden",
          outline: "none",
          fontFamily: "var(--font-family-base)",
          fontSize: "var(--font-size-input)",
          color: "var(--color-text-primary)",
        }}
      />
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {/*
          芯片群包一层：flex:1 1 auto + min-width:0 让它先于发送键让路，
          overflow:hidden 兜底——窄到连图标态都装不下时裁掉多出来的，而不是把
          发送键挤出可见区（`.composer-bottom-bar` 的容器查询规则见 styles.css）。
        */}
        <div className="composer-bottom-bar">{props.bottomSlot}</div>
        <button
          type="button"
          className="btn-accent"
          data-tone={stopping ? "danger" : undefined}
          aria-label={sendable ? "Send" : stopping ? "Stop" : "Send"}
          title={sendable ? "Send" : stopping ? "Stop this turn" : "Send"}
          disabled={!sendable && !stopping}
          onClick={() => (sendable ? props.onSubmit() : props.onStop())}
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
          }}
        >
          <Icon name={sendable ? "arrow-up" : "square"} size={sendable ? 16 : 12} />
        </button>
      </div>
    </div>
  );
}
