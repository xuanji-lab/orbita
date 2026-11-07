import { useEffect, useRef, useState } from "react";
import { CANVAS_SIZE, type Deck } from "../../../../shared/slides.ts";
import type { RenderContext } from "../../../../shared/slides-render.ts";
import { Icon } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { useT } from "../../locale.ts";
import { SlideStatic } from "./ElementView";

/**
 * 窗口内演示模式：铺满面板内容区、黑底、按窗口缩放、← → 空格翻页、Esc 退出、页码。
 * 「全屏」按钮才调 Electron 全屏（requestFullscreen，用户手动用）；窗口内模式本身不动系统。
 */
export function PlayMode(props: { deck: Deck; ctx: RenderContext; startIndex: number; onExit: () => void }) {
  const t = useT();
  const { deck, ctx } = props;
  const total = deck.slides.length;
  const [index, setIndex] = useState(Math.min(props.startIndex, Math.max(total - 1, 0)));
  const hostRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [auto, setAuto] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return undefined;
    host.focus();
    const measure = (): void => setSize({ w: host.clientWidth, h: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // 自动播放：每 5 秒翻一页，到末页停
  useEffect(() => {
    if (!auto) return undefined;
    const timer = window.setInterval(() => {
      setIndex((current) => {
        if (current >= total - 1) {
          setAuto(false);
          return current;
        }
        return current + 1;
      });
    }, 5000);
    return () => window.clearInterval(timer);
  }, [auto, total]);

  const go = (delta: number): void => setIndex((current) => Math.max(0, Math.min(total - 1, current + delta)));
  const canvas = CANVAS_SIZE[deck.aspect];
  const scale = size.w === 0 ? 0.5 : Math.min(size.w / canvas.w, (size.h - 44) / canvas.h);
  const slide = deck.slides[index];

  return (
    <div
      ref={hostRef}
      className="se-play"
      tabIndex={0}
      role="dialog"
      aria-label={t.slides.playing}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onExit();
        } else if (["ArrowRight", "ArrowDown", " ", "PageDown", "Enter"].includes(event.key)) {
          event.preventDefault();
          go(1);
        } else if (["ArrowLeft", "ArrowUp", "PageUp", "Backspace"].includes(event.key)) {
          event.preventDefault();
          go(-1);
        } else if (event.key === "Home") setIndex(0);
        else if (event.key === "End") setIndex(total - 1);
      }}
    >
      <div
        className="se-play-stage"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          go(event.clientX - rect.left > rect.width / 3 ? 1 : -1);
        }}
      >
        {slide !== undefined && <SlideStatic slide={slide} aspect={deck.aspect} ctx={ctx} width={Math.max(canvas.w * scale, 1)} />}
      </div>
      <div className="se-play-bar" onClick={(event) => event.stopPropagation()}>
        <span className="se-play-count" role="status">
          {index + 1} / {total}
        </span>
        <span className="dp-bar-grow" />
        <IconButton label={auto ? t.slides.autoPlayStop : t.slides.autoPlay} size={28} active={auto} onClick={() => setAuto((v) => !v)}>
          <Icon name={auto ? "pause" : "play"} size={16} strokeWidth={1.8} />
        </IconButton>
        <IconButton
          label={t.slides.fullscreen}
          size={28}
          onClick={() => {
            void hostRef.current?.requestFullscreen().catch(() => undefined);
          }}
        >
          <Icon name="expand" size={16} strokeWidth={1.8} />
        </IconButton>
        <IconButton label={t.slides.exitPlay} size={28} onClick={props.onExit}>
          <Icon name="x" size={16} strokeWidth={1.8} />
        </IconButton>
      </div>
    </div>
  );
}
