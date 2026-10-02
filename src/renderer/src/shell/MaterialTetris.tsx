import "./material-tetris.css";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import { ImageThumb } from "./ImageThumb";
import { imageSrc } from "./composer-images.ts";
import { quotePreview } from "./quote-label.ts";
import { NoVisionHint } from "./composer-material-stack.tsx";
import type { ComposerMaterial } from "./composer-materials.ts";
import {
  columnsForWidth,
  fileSpan,
  imageSpan,
  packPlacements,
  pastedSpan,
  quoteSpan,
  TETRIS_CELL_PX,
  TETRIS_GAP_PX,
  TETRIS_MAX_ROWS,
} from "./tetris-layout.ts";
import type { TextQuote } from "@shared/quote";
import { useT } from "../locale.ts";

/**
 * 俄罗斯方块材料区（设置 › 游戏化 › 材料区俄罗斯方块，默认关）。
 *
 * 数据**只从 composerMaterials() 的清单来**（composer-materials.ts，与 B 叠放
 * 同一份）：类型、显示名、meta、移除回调都在清单里接好，这里只管排布——
 * 方块尺寸与落位是 tetris-layout 的纯函数。开关只换显示形态，移除、跳回原文
 * 的行为与 B 叠放一致。
 *
 * 动效只解释「东西从哪来、去哪了」（设计系统 motion 原则）：
 * - 新材料从井口上方落下（一次 300ms + 120ms 回弹）；
 * - 删掉一块，其余块 FLIP 滑进空位（240ms）。
 * `prefers-reduced-motion` 时两者都不跑。都是一次性动画，无持续动画可暂停。
 */
export function MaterialTetris(props: {
  materials: readonly ComposerMaterial[];
  /** 当前模型看不了图：有附图时井下方说一句（材料的状态，跟排布无关） */
  imageUnsupported?: boolean;
  /** 跳回被引用的原文；返回 null 表示原文不在当前转录里（不画成可点） */
  jumpToQuote: (quote: TextQuote) => (() => void) | undefined;
}) {
  const t = useT();
  const gridRef = useRef<HTMLDivElement | null>(null);
  // 井宽 → 列数（与 CSS 的 auto-fill 同一算式）。ResizeObserver 跟随窗口缩放
  const [columns, setColumns] = useState(0);
  useLayoutEffect(() => {
    const el = gridRef.current;
    if (el === null) return;
    const measure = (): void => setColumns(columnsForWidth(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const materials = props.materials;
  // 引用的编号角标 = 它在引用堆里的序号（1 起），与 B 叠放 QuoteCard 同口径
  const quoteNo = useMemo(() => {
    const map = new Map<string, number>();
    let n = 0;
    for (const item of materials) {
      if (item.kind === "quote") map.set(item.id, ++n);
    }
    return map;
  }, [materials]);

  // 展开态跨「这一批材料」记住：全删光时收起（下次再来从 4 行折叠起步）
  const [expanded, setExpanded] = useState(false);
  const spans = useMemo(
    () =>
      materials.map((item): { col: number; row: number } => {
        switch (item.kind) {
          case "image":
            return imageSpan();
          case "file":
          case "dir":
            return fileSpan(item.name);
          case "pasted":
            return pastedSpan(item.block.lines);
          case "quote":
            return quoteSpan(item.quote.text);
        }
      }),
    [materials],
  );
  // 落位按全量算（折叠边界稳定），折叠态只渲染完全落在前 4 行内的块——
  // 不用 CSS max-height 裁切：不出现半截块，键盘焦点也不会落在看不见的块上
  const placements = useMemo(
    () =>
      columns > 0
        ? packPlacements(spans, columns)
        : spans.map(() => ({ row: 0, col: 0 })),
    [spans, columns],
  );
  const rows = useMemo(
    () => placements.reduce((max, at, i) => Math.max(max, at.row + (spans[i]?.row ?? 1)), 0),
    [placements, spans],
  );
  const overflow = rows > TETRIS_MAX_ROWS;
  const visible = expanded || !overflow;
  const shown = materials
    .map((item, i) => ({ item, span: spans[i] ?? { col: 3, row: 1 }, at: placements[i] }))
    .filter(
      (entry): entry is { item: ComposerMaterial; span: { col: number; row: number }; at: { row: number; col: number } } =>
        entry.at !== undefined && (visible || entry.at.row + entry.span.row <= TETRIS_MAX_ROWS),
    );
  const hiddenCount = materials.length - shown.length;

  // ── FLIP + 落块动效 ──────────────────────────────────────────────
  // 每次渲染后记下各方块的屏幕位置；下一次材料变化时，旧块从旧位置滑到新位置
  // （删块补位），没有旧位置的是新块——从井口上方落下。reduced motion 全跳过。
  const prevRects = useRef(new Map<string, DOMRect>());
  const motion = useRef<MediaQueryList | null>(null);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (grid === null) return;
    if (motion.current === null) motion.current = window.matchMedia("(prefers-reduced-motion: reduce)");
    const reduced = motion.current.matches;
    const rects = new Map<string, DOMRect>();
    for (const el of grid.querySelectorAll<HTMLElement>("[data-block-key]")) {
      const key = el.dataset.blockKey ?? "";
      const now = el.getBoundingClientRect();
      rects.set(key, now);
      if (reduced) continue;
      const old = prevRects.current.get(key);
      if (old === undefined) {
        // 新块：从井口上方落下（掉进格子），落地后一次轻微回弹
        const lift = Math.min(now.top - grid.getBoundingClientRect().top, 200) + 60;
        const drop = el.animate(
          [{ transform: `translateY(-${lift}px)`, opacity: 0 }, { transform: "none", opacity: 1 }],
          { duration: 300, easing: "cubic-bezier(.5,0,.75,0)" },
        );
        void drop.finished.then(() => {
          el.animate([{ transform: "translateY(-3px)" }, { transform: "none" }], {
            duration: 120,
            easing: "cubic-bezier(.22,1,.36,1)",
          });
        });
      } else {
        const dx = old.left - now.left;
        const dy = old.top - now.top;
        if (dx !== 0 || dy !== 0) {
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], {
            duration: 240,
            easing: "cubic-bezier(.22,1,.36,1)",
          });
        }
      }
    }
    prevRects.current = rects;
    // 材料清单（含顺序）一变就要补位 / 落块；列数变了（窗口缩放）同样会重排
  }, [materials, columns, expanded]);

  const [viewing, setViewing] = useState<number | null>(null);
  const images = useMemo(() => materials.filter((item): item is Extract<ComposerMaterial, { kind: "image" }> => item.kind === "image"), [materials]);

  if (materials.length === 0) return null;
  return (
    <div className="tetris-wrap">
      {viewing !== null && (
        <ImageLightbox
          images={images.map((item) => item.image.image)}
          startIndex={viewing}
          onClose={() => setViewing(null)}
        />
      )}
      <div ref={gridRef} className="tetris-well" role="list" aria-label={t.composer.materialArea}>
        {shown.map(({ item, span }) => (
          <TetrisBlock
            key={item.id}
            item={item}
            span={span}
            quoteNumber={item.kind === "quote" ? quoteNo.get(item.id) : undefined}
            jump={item.kind === "quote" ? props.jumpToQuote(item.quote) : undefined}
            onOpenImage={
              item.kind === "image"
                ? () => setViewing(images.findIndex((entry) => entry.id === item.id))
                : undefined
            }
          />
        ))}
      </div>
      {overflow && (
        <button type="button" className="tetris-more" onClick={() => setExpanded((value) => !value)}>
          <Icon name={expanded ? "chevron-up" : "chevron-down"} size={12} strokeWidth={1.8} />
          <span>{expanded ? t.composer.tetrisCollapse : t.composer.tetrisMore(hiddenCount)}</span>
        </button>
      )}
      {props.imageUnsupported === true && images.length > 0 && <NoVisionHint />}
    </div>
  );
}

/**
 * 一个方块。类型色只染淡底与描边（token 见 tokens/colors.css 的材料类型色组），
 * 字恒用正墨——tint 是类型的唯一信号。图片方块是 2×2 的缩略图（ImageThumb），
 * 长粘贴是 2 行高（第二行两行预览），其余 1 行。
 */
function TetrisBlock(props: {
  item: ComposerMaterial;
  span: { col: number; row: number };
  /** 引用的编号角标（1 起，引用堆里的序号） */
  quoteNumber?: number;
  jump?: () => void;
  onOpenImage?: () => void;
}) {
  const t = useT();
  const { item, span } = props;
  const style = { gridColumn: `span ${span.col}`, gridRow: `span ${span.row}` };
  const remove = (
    <button
      type="button"
      className="tetris-x"
      aria-label={removeLabel(item, t)}
      title={removeLabel(item, t)}
      onClick={item.remove}
    >
      <Icon name="x" size={11} strokeWidth={2} />
    </button>
  );

  if (item.kind === "image") {
    // 2×2 格 = 64px；扣掉外框 1px 描边 ×2 与 2px 内衬 ×2，缩略图 58px
    return (
      <div
        className="tetris-block tetris-image"
        data-block-key={item.id}
        role="listitem"
        style={style}
        title={item.name !== "" ? item.name : undefined}
      >
        <ImageThumb
          src={imageSrc(item.image.image)}
          name={item.name}
          size={TETRIS_CELL_PX * 2 + TETRIS_GAP_PX - 6}
          openLabel={t.lightbox.open}
          onOpen={() => props.onOpenImage?.()}
          paperclip
          onRemove={item.remove}
          removeLabel={t.composer.removeImage}
        />
      </div>
    );
  }

  if (item.kind === "pasted" && span.row === 2) {
    return (
      <div
        className="tetris-block tetris-pasted tetris-tall"
        data-block-key={item.id}
        role="listitem"
        style={style}
      >
        <div className="tetris-line">
          <Icon name="file-text" size={13} strokeWidth={1.8} />
          <span className="tetris-name">{item.name}</span>
          <span className="tetris-meta">{item.meta}</span>
          {remove}
        </div>
        <div className="tetris-preview" title={item.block.text}>
          {item.block.text}
        </div>
      </div>
    );
  }

  if (item.kind === "quote") {
    const jump = props.jump;
    return (
      <div
        className="tetris-block tetris-quote"
        data-block-key={item.id}
        role="listitem"
        style={style}
        title={jump === undefined ? undefined : t.quote.jump}
      >
        <Icon name="quote" size={13} strokeWidth={1.8} />
        <button type="button" className="tetris-quote-text" onClick={jump} disabled={jump === undefined}>
          <span className="tetris-quote-index">{props.quoteNumber ?? 1}</span>
          <span className="tetris-name">{quotePreview(item.quote)}</span>
        </button>
        <span className="tetris-meta">{item.meta}</span>
        {remove}
      </div>
    );
  }

  // 文件 / 目录 与 短粘贴：一行胶囊
  const icon = item.kind === "dir" ? "folder" : item.kind === "file" ? "file" : "file-text";
  return (
    <div
      className={`tetris-block ${item.kind === "pasted" ? "tetris-pasted" : "tetris-file"}`}
      data-block-key={item.id}
      role="listitem"
      style={style}
      title={item.kind === "file" || item.kind === "dir" ? item.ref.path : item.kind === "pasted" ? item.block.text : undefined}
    >
      <Icon name={icon} size={13} strokeWidth={1.8} />
      <span className="tetris-name">{item.name}</span>
      {item.meta !== null && <span className="tetris-meta">{item.meta}</span>}
      {remove}
    </div>
  );
}

function removeLabel(item: ComposerMaterial, t: ReturnType<typeof useT>): string {
  switch (item.kind) {
    case "image":
      return t.composer.removeImage;
    case "file":
    case "dir":
      return t.composer.removeFile;
    case "pasted":
      return t.composer.removePasted;
    case "quote":
      return t.quote.remove;
  }
}
