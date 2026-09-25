import "./info-tip.css";
import { useId } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../shell/Icon";
import { useHoverTooltip } from "../../shell/useHoverTooltip.ts";

/** 与 IconButton 同一个延迟：太快手抖就闪，太慢感知等于没有 */
const TIP_DELAY_MS = 200;

/**
 * 设置页的悬停说明：把原来常驻在每一行下面的整段说明收起来，悬停或键盘聚焦才显示。
 *
 * 「什么时候显示、显示在哪」复用 `useHoverTooltip`（IconButton、skill 行之后的第三个
 * 消费者）；这里只管两件 hook 不管的事——说明的长相（多行 caption，比 IconButton 的
 * 单行牌子宽），以及读屏接线：说明收起时不在 DOM 里，所以另放一份 `hidden` 的副本
 * 挂 `aria-describedby`，读屏不必等悬停也能读到。
 *
 * 返回锚点属性与浮层：锚点可以是 info 图标（`InfoTip`），也可以是本身就有含义的
 * 元素（Theme 的 System 卡、Providers 的协议徽标），同一份说明机制不分两套。
 */
export function useSettingTip<T extends HTMLElement>(text: React.ReactNode) {
  const tip = useHoverTooltip<T>(TIP_DELAY_MS, true, { side: "below" });
  const id = useId();
  const anchor = {
    ref: tip.anchorRef,
    "aria-describedby": id,
    ...tip.handlers,
  };
  const layer = (
    <>
      <span id={id} hidden>
        {text}
      </span>
      {tip.open &&
        createPortal(
          <div
            ref={tip.tooltipRef}
            role="tooltip"
            aria-hidden="true"
            className="setting-tip"
            data-placed={tip.placement !== null}
            style={{ top: tip.placement?.top ?? 0, left: tip.placement?.left ?? 0 }}
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
  return { anchor, layer };
}

/**
 * 名字旁的 info 图标。`label` 进 aria-label（「About Auto-compact」），`children` 是说明本身；
 * 句子之间用 `·` 连接（设计系统 *Content fundamentals › Tooltips*）。
 */
export function InfoTip(props: { label: string; children: React.ReactNode }) {
  const { anchor, layer } = useSettingTip<HTMLButtonElement>(props.children);
  return (
    <>
      <button type="button" className="info-tip" aria-label={props.label} {...anchor}>
        <Icon name="info" size={12} />
      </button>
      {layer}
    </>
  );
}
