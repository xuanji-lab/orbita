import { memo } from "react";
import { renderElementInner, renderSlide, slideBackground, type RenderContext } from "../../../../shared/slides-render.ts";
import { CANVAS_SIZE, type Aspect, type Slide, type SlideElement } from "../../../../shared/slides.ts";
import type { Box } from "./geometry.ts";

/** 元素外框的 style 对象（与 shared 的 elementBoxStyle 同一套数值，React 要对象不要串） */
export function boxStyle(element: SlideElement, override?: Box): React.CSSProperties {
  const box = override ?? element;
  return {
    left: box.x,
    top: box.y,
    width: box.w,
    height: box.h,
    ...(element.rotate !== undefined && element.rotate !== 0 ? { transform: `rotate(${element.rotate}deg)` } : {}),
  };
}

/**
 * 画布里的一个元素：外框是 React 节点（拖动时只改它的 style），内部是 shared 渲染出的 HTML——
 * 与缩略图 / 播放 / 导出同一份渲染。memo：元素引用不变（没被改）就不重画，40 页 × 6 元素拖一个也不卡。
 */
export const ElementView = memo(function ElementView(props: {
  element: SlideElement;
  ctx: RenderContext;
  override?: Box;
  hidden?: boolean;
}) {
  const { element, ctx, override } = props;
  return (
    <div
      className="sl-el"
      data-id={element.id}
      data-kind={element.kind}
      style={{ ...boxStyle(element, override), ...(props.hidden === true ? { visibility: "hidden" } : {}) }}
      dangerouslySetInnerHTML={{ __html: renderElementInner(element, ctx) }}
    />
  );
});

/** 一整页的静态渲染（缩略图 / 播放 / 导出同源）：按 scale 缩放，外层框占缩放后的尺寸 */
export const SlideStatic = memo(function SlideStatic(props: {
  slide: Slide;
  aspect: Aspect;
  ctx: RenderContext;
  /** 渲染宽度（px）；高度按比例 */
  width: number;
  /** 这一页在 deck 里的下标（0 起）：页脚「标题 · 页码」要用；缺席 = 不画页脚 */
  index?: number;
}) {
  const canvas = CANVAS_SIZE[props.aspect];
  const scale = props.width / canvas.w;
  return (
    <div className="se-static" style={{ width: props.width, height: canvas.h * scale }} data-bg={slideBackground(props.slide, props.ctx.deck)}>
      <div
        className="se-static-inner"
        style={{ width: canvas.w, height: canvas.h, transform: `scale(${scale})` }}
        dangerouslySetInnerHTML={{ __html: renderSlide(props.slide, props.ctx, props.index) }}
      />
    </div>
  );
});
