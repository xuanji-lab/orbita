import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import { ImageThumb } from "./ImageThumb";
import { useHoverTooltip } from "./useHoverTooltip.ts";
import { imageSrc } from "./composer-images.ts";
import { quotePreview } from "./quote-label.ts";
import type { ComposerMaterial } from "./composer-materials.ts";
import type { TextQuote } from "@shared/quote";
import { useT } from "../locale.ts";

/**
 * 输入框上方的**材料叠放区**（B 叠放定稿）：四路附件全部移出输入卡，叠在卡片
 * 上方，从上到下——截图一行（正方形缩略）→ 文件 / 目录 / 粘贴文本一行（同一种
 * 胶囊、顶到就换行铺满）→ 引用一张卡（排队卡同款整行，最多 2 条、其余折叠）。
 * 除引用卡外都不加卡底，直接坐在聊天面上：材料是「接下来要发的东西」，不是
 * 输入框的一部分；胶囊自带 `--glass-bg` + `--shadow-border`，一层语言不需要卡。
 *
 * 数据从 composerMaterials() 的清单来（composer-materials.ts）——排布层只认
 * kind，不认四路附件各自的管线。
 */

/** 截图缩略的边长（正方形）。64：比 72 的旧卡小一档——材料行是配角，不抢输入框。 */
const IMAGE_SQUARE = 64;
/** 引用卡折叠态显示的条数。2：再多就该折叠了——引用是上下文，不是正文。 */
const QUOTE_COLLAPSED_ROWS = 2;
/** 胶囊路径 tooltip 的延迟，与 IconButton 同值：太快手抖就闪，太慢感知等于没有 */
const PATH_TOOLTIP_DELAY_MS = 200;

export function MaterialStack(props: {
  materials: readonly ComposerMaterial[];
  /** 当前模型看不了图：有截图时在缩略图下说一句（pi 会把图换成占位文字） */
  imageUnsupported?: boolean;
  /** 跳回被引用的原文；返回 null 表示原文不在当前转录里 */
  jumpToQuote: (quote: TextQuote) => (() => void) | undefined;
}) {
  const images = props.materials.filter((item): item is Extract<ComposerMaterial, { kind: "image" }> => item.kind === "image");
  const chips = props.materials.filter(
    (item): item is Extract<ComposerMaterial, { kind: "file" | "dir" | "pasted" }> =>
      item.kind === "file" || item.kind === "dir" || item.kind === "pasted",
  );
  const quotes = props.materials.filter((item): item is Extract<ComposerMaterial, { kind: "quote" }> => item.kind === "quote");
  return (
    <>
      {images.length > 0 && (
        <>
          <ImageLayer images={images} />
          {props.imageUnsupported === true && <NoVisionHint />}
        </>
      )}
      {chips.length > 0 && <ChipLayer chips={chips} />}
      {quotes.length > 0 && <QuoteCard quotes={quotes} jumpToQuote={props.jumpToQuote} />}
    </>
  );
}

/** 待发截图：一行正方形缩略，点开看原图（lightbox 与转录画廊共用） */
function ImageLayer(props: { images: readonly Extract<ComposerMaterial, { kind: "image" }>[] }) {
  const t = useT();
  const [viewing, setViewing] = useState<number | null>(null);
  return (
    <div className="material-image-row">
      {viewing !== null && (
        <ImageLightbox
          images={props.images.map((item) => item.image.image)}
          startIndex={viewing}
          onClose={() => setViewing(null)}
        />
      )}
      {props.images.map((item, index) => (
        <ImageThumb
          key={item.id}
          src={imageSrc(item.image.image)}
          name={item.name}
          size={IMAGE_SQUARE}
          openLabel={t.lightbox.open}
          onOpen={() => setViewing(index)}
          paperclip
          onRemove={item.remove}
          removeLabel={t.composer.removeImage}
        />
      ))}
    </div>
  );
}

/** 模型看不了图的一句话提示：跟在截图行下面，图标 + 文字（颜色是第二信号） */
function NoVisionHint() {
  const t = useT();
  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--space-1)",
        fontSize: "var(--font-size-caption)",
        color: "var(--color-text-secondary)",
      }}
    >
      <Icon name="triangle-alert" size={12} strokeWidth={1.8} style={{ color: "var(--color-warning)", flex: "0 0 auto" }} />
      <span>{t.composer.noVision}</span>
    </div>
  );
}

/**
 * 文件 / 目录 / 粘贴文本共用的一种胶囊：**顶到就换行铺满**（2026-10 用户裁决
 * 「我喜欢全部看到，自然的 stack，顶到了就换行」），不再横滚、不再右侧渐隐。
 * 粘贴文本点开看全文——不撑高输入区：全文放浮层（点开的那颗胶囊上方），
 * 浮层是 floating layer（实底面板 + 发丝 + popover 阴影），滚动限高。
 */
function ChipLayer(props: { chips: readonly Extract<ComposerMaterial, { kind: "file" | "dir" | "pasted" }>[] }) {
  const t = useT();
  const [openId, setOpenId] = useState<string | null>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  // 点浮层与胶囊以外的地方收起全文；Esc 同义。指针与键盘两条路都收
  useEffect(() => {
    if (openId === null) return;
    const onPointerDown = (event: PointerEvent) => {
      if (layerRef.current !== null && !layerRef.current.contains(event.target as Node)) setOpenId(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenId(null);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [openId]);
  const open = props.chips.find(
    (chip): chip is Extract<ComposerMaterial, { kind: "pasted" }> => chip.id === openId && chip.kind === "pasted",
  );
  return (
    <div className="material-chip-row" ref={layerRef}>
      <div className="material-chip-scroll">
        {props.chips.map((chip) =>
          chip.kind === "pasted" ? (
            <PastedChip
              key={chip.id}
              chip={chip}
              open={openId === chip.id}
              onToggle={() => setOpenId((current) => (current === chip.id ? null : chip.id))}
            />
          ) : (
            <FileChip key={chip.id} chip={chip} />
          ),
        )}
      </div>
      {open !== undefined && (
        <div className="material-popover" role="region" aria-label={t.composer.pastedTitle(open.block.lines)}>
          <div className="material-popover-head">
            <span>{t.composer.pastedTitle(open.block.lines)}</span>
            <button
              type="button"
              aria-label={t.composer.pastedCollapse}
              onClick={() => setOpenId(null)}
              className="material-popover-close"
            >
              <Icon name="x" size={12} strokeWidth={2} />
            </button>
          </div>
          <div className="material-popover-body">{open.block.text}</div>
        </div>
      )}
    </div>
  );
}

/**
 * 文件 / 目录引用的胶囊：图标 + 名字（省略号）+ 移除键。
 *
 * **目录一眼可辨**（2026-10 用户验收「文件夹的图标跟文件区分不开」）靠三个信号：
 * folder 图标**填实**（file 是线框——形状先分，颜色后跟）、图标升一档到 secondary、
 * 名字后跟一条 `/`（目录的约定俗成记号，与发给模型的清单块同一约定）。填实是
 * Icon 的 fill（描边与填实在同一个 currentColor 里，同星标的做法）。
 *
 * **完整路径用自绘快速 tooltip**（useHoverTooltip，与 IconButton 同 200ms）而不用
 * 原生 title：原生要一秒多才出，且在胶囊行上时隐时现不可靠（同 IconButton 弃用
 * title 的理由）。路径是机器事实，mono 字体；长路径换行不截断——看全正是它的存在
 * 理由。键盘路径不给：胶囊本身不是焦点停点，与原生 title 时代一致。
 */
function FileChip(props: { chip: Extract<ComposerMaterial, { kind: "file" | "dir" }> }) {
  const t = useT();
  const isDir = props.chip.kind === "dir";
  const tooltip = useHoverTooltip<HTMLSpanElement>(PATH_TOOLTIP_DELAY_MS, true);
  return (
    <>
      <span
        className="material-chip"
        ref={tooltip.anchorRef}
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
      >
        <Icon
          name={isDir ? "folder" : "file"}
          size={13}
          strokeWidth={1.8}
          fill={isDir}
          style={{
            color: isDir ? "var(--color-text-secondary)" : "var(--color-text-tertiary)",
            flex: "0 0 auto",
          }}
        />
        <span className="material-chip-name">{props.chip.name}</span>
        {/* 目录记号 `/`：单独一格不参与省略号，名字再长也不会把它吃掉 */}
        {isDir && (
          <span className="material-chip-meta" aria-hidden="true">
            /
          </span>
        )}
        <button type="button" className="material-chip-x" aria-label={t.composer.removeFile} title={t.composer.removeFile} onClick={props.chip.remove}>
          <Icon name="x" size={11} strokeWidth={2} />
        </button>
      </span>
      {tooltip.open &&
        createPortal(
          <div
            ref={tooltip.tooltipRef}
            role="tooltip"
            className="material-path-tip"
            data-placed={tooltip.placement !== null}
            style={{ top: tooltip.placement?.top ?? 0, left: tooltip.placement?.left ?? 0 }}
          >
            {props.chip.ref.path}
          </div>,
          document.body,
        )}
    </>
  );
}

/** 粘贴文本的胶囊：点胶囊本体开 / 关全文浮层；行数是元信息，跟在名字后 */
function PastedChip(props: {
  chip: Extract<ComposerMaterial, { kind: "pasted" }>;
  open: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <span className="material-chip">
      <button
        type="button"
        className="material-chip-toggle"
        aria-expanded={props.open}
        title={props.open ? t.composer.pastedCollapse : t.composer.pastedExpand}
        onClick={props.onToggle}
      >
        <Icon
          name={props.open ? "chevron-down" : "chevron-right"}
          size={12}
          style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }}
        />
        <Icon name="file-text" size={13} strokeWidth={1.8} style={{ color: "var(--color-text-tertiary)", flex: "0 0 auto" }} />
        <span className="material-chip-name">{props.chip.name}</span>
        <span className="material-chip-meta">{props.chip.meta}</span>
      </button>
      <button
        type="button"
        className="material-chip-x"
        aria-label={t.composer.removePasted}
        title={t.composer.removePasted}
        onClick={props.chip.remove}
      >
        <Icon name="x" size={11} strokeWidth={2} />
      </button>
    </span>
  );
}

/**
 * 引用卡：排队卡（QueueStrip）同款整行样式——一行 = 图标 + 编号 + 正文（省略号）+
 * 来源注脚，悬停出「跳回原文」「移除」。最多显示 2 条，其余折成「还有 N 条引用…」
 * 可展开 / 收起；**引用条数已不设上限**（shared/quote.ts 只限总字数），展开态限高
 * 内部滚动，卡片不无限长高。
 */
function QuoteCard(props: {
  quotes: readonly Extract<ComposerMaterial, { kind: "quote" }>[];
  jumpToQuote: (quote: TextQuote) => (() => void) | undefined;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? props.quotes : props.quotes.slice(0, QUOTE_COLLAPSED_ROWS);
  const hidden = props.quotes.length - visible.length;
  return (
    <section className="glass-card glass-float material-quote-card" aria-label={t.quote.add}>
      {visible.map((item, index) => (
        <QuoteRow key={item.id} item={item} index={index + 1} onJump={props.jumpToQuote(item.quote)} />
      ))}
      {hidden > 0 ? (
        <button type="button" className="material-quote-more" onClick={() => setExpanded(true)}>
          <Icon name="chevron-down" size={12} style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)" }} />
          <span>{t.quote.more(hidden)}</span>
        </button>
      ) : (
        props.quotes.length > QUOTE_COLLAPSED_ROWS && (
          <button type="button" className="material-quote-more" onClick={() => setExpanded(false)}>
            <Icon name="chevron-up" size={12} style={{ flex: "0 0 auto", color: "var(--color-text-tertiary)" }} />
            <span>{t.quote.collapse}</span>
          </button>
        )
      )}
    </section>
  );
}

function QuoteRow(props: {
  item: Extract<ComposerMaterial, { kind: "quote" }>;
  index: number;
  onJump: (() => void) | undefined;
}) {
  const t = useT();
  const preview = quotePreview(props.item.quote);
  return (
    <div className="material-quote-row">
      <span style={{ display: "inline-flex", color: "var(--color-text-tertiary)", flex: "0 0 auto" }}>
        <Icon name="quote" size={12} />
      </span>
      <span className="material-quote-idx">{props.index}</span>
      {props.onJump === undefined ? (
        <span className="material-quote-text" title={props.item.quote.text}>
          {preview}
        </span>
      ) : (
        <button type="button" className="material-quote-text material-quote-jump" title={t.quote.jump} onClick={props.onJump}>
          {preview}
        </button>
      )}
      <span className="material-quote-note" title={props.item.quote.text}>
        {props.item.meta}
      </span>
      <span className="material-quote-actions">
        {props.onJump !== undefined && (
          <button type="button" aria-label={t.quote.jump} title={t.quote.jump} onClick={props.onJump}>
            <Icon name="arrow-up-right" size={12} />
          </button>
        )}
        <button type="button" aria-label={t.quote.remove} title={t.quote.remove} onClick={props.item.remove}>
          <Icon name="x" size={12} strokeWidth={2} />
        </button>
      </span>
    </div>
  );
}
