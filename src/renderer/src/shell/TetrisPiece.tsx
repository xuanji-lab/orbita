import { createPortal } from "react-dom";
import { BLACKHOLE_STEP_PX } from "./blackhole-layout.ts";
import { DirMarkName } from "./DirMarkName.tsx";
import { Icon } from "./Icon";
import { PaperclipMark } from "./PaperclipMark";
import { useHoverTooltip } from "./useHoverTooltip.ts";
import type { TetrisGeometry } from "./tetris-geometry.ts";
import { useT } from "../locale.ts";

/**
 * 俄罗斯方块形态的一块材料（tetris 形态；黑洞形态仍是 FileChip / ImageThumb 胶囊）。
 * 形状几何（外轮廓 / 接缝 / 名字行 / 凸块）由 tetris-geometry.ts 的纯函数算好，
 * 这里只摆：SVG 画轮廓与接缝，名字行放图标 + 名字 + 行尾 `.ext`（I 块），凸块放
 * 扩展名（大写、mono）；截图是 4×2 的横幅缩略图，不显示名字。
 *
 * 交互与胶囊同构：完整路径走自绘快速 tooltip（与 FileChip 同 200ms、同浮层），
 * 移除键悬停显形（在 DOM 里、可 Tab，:focus-visible 也显）。已发送消息的快照里
 * 只读——不给 onRemove。
 *
 * 颜色只从 token 派生（blackhole.css 的 .bh-piece）：doc / slides / sheet 三族用
 * --color-filetype-*，填充 tint、描边全色；其余中性。
 */

/** 路径 tooltip 的延迟，与 FileChip 同值：太快手抖就闪，太慢感知等于没有 */
const PATH_TOOLTIP_DELAY_MS = 200;

export function TetrisPiece(props: {
  geo: TetrisGeometry;
  /** 完整名字（横幅的 title、其余走名字行） */
  name: string;
  kind: "file" | "dir";
  /** 完整路径（悬停 tooltip，机器事实）；截图横幅没有 */
  path?: string;
  /** 超限未复制（发送时按原位置引用） */
  uncopied?: boolean;
  /** 只读（已发送消息）时不给 */
  onRemove?: () => void;
  removeLabel?: string;
  /** 截图横幅的缩略图与放大；非横幅不用 */
  thumbSrc?: string;
  openLabel?: string;
  onOpen?: () => void;
}) {
  const t = useT();
  const tooltip = useHoverTooltip<HTMLSpanElement>(PATH_TOOLTIP_DELAY_MS, true);
  const geo = props.geo;
  const width = geo.cols * BLACKHOLE_STEP_PX;
  const height = geo.rows * BLACKHOLE_STEP_PX;
  const isDir = props.kind === "dir";

  if (geo.banner) {
    return (
      <div className="bh-piece" data-key={geo.key}>
        {props.thumbSrc !== undefined && props.openLabel !== undefined && props.onOpen !== undefined && (
          <>
            <PaperclipMark size={18} />
            <button
              type="button"
              className="bh-piece-thumb"
              aria-label={props.openLabel}
              title={props.name}
              onClick={props.onOpen}
            >
              <img src={props.thumbSrc} alt="" draggable={false} />
            </button>
            {props.onRemove !== undefined && (
              <button
                type="button"
                className="bh-piece-x bh-piece-x-corner"
                aria-label={props.removeLabel}
                title={props.removeLabel}
                onClick={props.onRemove}
              >
                <Icon name="x" size={11} strokeWidth={2} />
              </button>
            )}
          </>
        )}
      </div>
    );
  }

  return (
    <div className="bh-piece" data-key={geo.key} data-tone={geo.tone ?? undefined}>
      <svg className="bh-piece-shape" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
        <path className="bh-piece-fill" d={geo.outline} />
        {geo.seams.map((seam, index) => (
          <line key={index} className="bh-piece-seam" x1={seam.x1} y1={seam.y1} x2={seam.x2} y2={seam.y2} />
        ))}
      </svg>
      {geo.labelRect !== null && (
        <span
          className="bh-piece-label"
          style={{
            left: geo.labelRect.left,
            top: geo.labelRect.top,
            width: geo.labelRect.width,
            height: geo.labelRect.height,
          }}
          ref={tooltip.anchorRef}
          onMouseEnter={tooltip.handlers.onMouseEnter}
          onMouseLeave={tooltip.handlers.onMouseLeave}
        >
          <Icon name={geo.icon} size={13} strokeWidth={1.8} fill={isDir} />
          <DirMarkName name={geo.stem} dir={isDir} wrapStyle={{ flex: "1 1 auto" }} nameClassName="bh-piece-name" />
          {props.uncopied === true && (
            <span className="bh-piece-uncopied">
              <Icon name="triangle-alert" size={10} strokeWidth={2} />
              {t.composer.notCopied}
            </span>
          )}
          {geo.meta !== "" && <span className="bh-piece-meta">{geo.meta}</span>}
          {props.onRemove !== undefined && (
            <button
              type="button"
              className="bh-piece-x"
              aria-label={props.removeLabel}
              title={props.removeLabel}
              onClick={props.onRemove}
            >
              <Icon name="x" size={11} strokeWidth={2} />
            </button>
          )}
        </span>
      )}
      {geo.nubRect !== null && geo.nubText !== "" && (
        <span
          className="bh-piece-nub"
          style={{
            left: geo.nubRect.left,
            top: geo.nubRect.top,
            width: geo.nubRect.width,
            height: geo.nubRect.height,
          }}
        >
          {geo.nubText}
        </span>
      )}
      {tooltip.open &&
        props.path !== undefined &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            role="tooltip"
            className="material-path-tip"
            data-placed={tooltip.placement !== null}
            style={{ top: tooltip.placement?.top ?? 0, left: tooltip.placement?.left ?? 0 }}
          >
            <div>{props.path}</div>
            {props.uncopied === true && (
              <div className="material-path-note">
                <Icon name="triangle-alert" size={10} strokeWidth={2} />
                {t.composer.notCopiedTip}
              </div>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
