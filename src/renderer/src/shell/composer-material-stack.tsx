import { useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { ImageLightbox } from "./ImageLightbox";
import { ImageThumb } from "./ImageThumb";
import { useHoverTooltip } from "./useHoverTooltip.ts";
import { imageSrc } from "./composer-images.ts";
import { quoteNoteParts, quoteRowPreview } from "./quote-label.ts";
import { fileIcon, fileIconTone, FILETYPE_TONE_COLOR } from "../features/files/tree-view.ts";
import { DirMarkName } from "./DirMarkName.tsx";
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
/**
 * 引用折叠态显示的条数。10 = 两列五行（2026-10-11 用户：「第五条就 collapse 了，太早，
 * 10 条之后再 collapse」）——卡已改单行 32px，五行约 200px，不至于把聊天区挤没。
 */
const QUOTE_COLLAPSED_ROWS = 10;
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
    (item): item is Extract<ComposerMaterial, { kind: "file" | "dir" }> =>
      item.kind === "file" || item.kind === "dir",
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
        fontSize: "var(--font-size-sm)",
        color: "var(--color-text-secondary)",
      }}
    >
      <Icon name="triangle-alert" size={12} strokeWidth={1.8} style={{ color: "var(--color-warning)", flex: "0 0 auto" }} />
      <span>{t.composer.noVision}</span>
    </div>
  );
}

/**
 * 文件 / 目录共用的一种胶囊：**顶到就换行铺满**（2026-10 用户裁决
 * 「我喜欢全部看到，自然的 stack，顶到了就换行」），不再横滚、不再右侧渐隐。
 * 粘贴文本已改道句中胶囊（方案 C，paste-blocks.ts），材料区只剩截图、文件 /
 * 目录、引用三路。
 */
function ChipLayer(props: { chips: readonly Extract<ComposerMaterial, { kind: "file" | "dir" }>[] }) {
  return (
    <div className="material-chip-row">
      <div className="material-chip-scroll">
        {props.chips.map((chip) => (
          <FileChip
            key={chip.id}
            name={chip.name}
            path={chip.ref.path}
            kind={chip.kind}
            uncopied={chip.ref.uncopied === true}
            onRemove={chip.remove}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * 文件 / 目录引用的胶囊：图标 + 名字（省略号）+ 移除键。
 *
 * **目录一眼可辨**（2026-10 用户验收「文件夹的图标跟文件区分不开」）靠三个信号：
 * folder 图标**填实**（文件按扩展名分形状，与文件面板树同一个 fileIcon——形状先分，
 * 颜色后跟）、图标升一档到 secondary、名字后跟一条 `/`（目录的约定俗成记号，
 * 与发给模型的清单块同一约定）。填实是 Icon 的 fill（描边与填实在同一个
 * currentColor 里，同星标的做法）。
 *
 * **完整路径用自绘快速 tooltip**（useHoverTooltip，与 IconButton 同 200ms）而不用
 * 原生 title：原生要一秒多才出，且在胶囊行上时隐时现不可靠（同 IconButton 弃用
 * title 的理由）。路径是机器事实，mono 字体；长路径换行不截断——看全正是它的存在
 * 理由。键盘路径不给：胶囊本身不是焦点停点，与原生 title 时代一致。
 */
function FileChip(props: {
  name: string;
  path: string;
  kind: "file" | "dir";
  /** 超限未复制（发送时按原位置引用） */
  uncopied?: boolean;
  /** 只读（已发送消息）时不给 */
  onRemove?: () => void;
}) {
  const t = useT();
  const isDir = props.kind === "dir";
  const tooltip = useHoverTooltip<HTMLSpanElement>(PATH_TOOLTIP_DELAY_MS, true);
  // 文档 / 演示 / 表格三族上色（fileIconTone，与文件面板同一份），其余中性
  const tone = isDir ? null : fileIconTone(props.name, "file");
  const iconColor =
    isDir
      ? "var(--color-text-secondary)"
      : tone === null
        ? "var(--color-text-tertiary)"
        : FILETYPE_TONE_COLOR[tone];
  return (
    <>
      <span
        className="material-chip"
        ref={tooltip.anchorRef}
        onMouseEnter={tooltip.handlers.onMouseEnter}
        onMouseLeave={tooltip.handlers.onMouseLeave}
      >
        <Icon
          name={isDir ? "folder" : fileIcon(props.name, "file")}
          size={13}
          strokeWidth={1.8}
          fill={isDir}
          style={{
            color: iconColor,
            flex: "0 0 auto",
          }}
        />
        {/* 名字 + 目录尾 `/`：共用组件（胶囊 / 面板行 / 气泡三处同一段结构） */}
        <DirMarkName name={props.name} dir={isDir} wrapStyle={{ flex: "0 1 auto" }} nameClassName="material-chip-name" />
        {/* 超限未复制（发送时按原位置引用）：icon + 文字，warning 色只做第二信号 */}
        {props.uncopied === true && (
          <span className="material-chip-uncopied">
            <Icon name="triangle-alert" size={10} strokeWidth={2} />
            {t.composer.notCopied}
          </span>
        )}
        {props.onRemove !== undefined && (
          <button type="button" className="material-chip-x" aria-label={t.composer.removeFile} title={t.composer.removeFile} onClick={props.onRemove}>
            <Icon name="x" size={11} strokeWidth={2} />
          </button>
        )}
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
    </>
  );
}

/**
 * 引用卡：**半行两列**（2026-10 用户裁决「我还是想要半行两列」）——每条引用只占
 * 半行，两列并排堆叠更多引用；卡窄（子会话抽屉、窄窗）时 container query 回落
 * 一列。折叠态显示两行 = 4 条，其余折成「还有 N 条引用…」跨两列占整行；展开态
 * 限高内部滚动。「还有 N 条 / 收起」跨两列占整行。行内仍是 D/E 的规矩：正文不预截
 * 交给 CSS 省略、注脚贴右缘、动作键绝对定位不占位。
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
    // 每条引用一张独立的半宽卡（2026-10-11 用户裁决）：外层只排两列、不画卡；左卡贴
    // 输入卡左缘、右卡贴右缘，卡与卡之间留缝；卡高统一单行（长引用省略），扁平无阴影
    <section className="material-quote-card" aria-label={t.quote.add}>
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
  const preview = quoteRowPreview(props.item.quote);
  // 注脚分三段（轮次 / 谁说的 / 字数）：窄格里 CSS 先藏「谁说的」；title 仍挂引用全文
  const note = quoteNoteParts(props.item.quote, t);
  return (
    <div className="material-quote-row">
      <span className="material-quote-head">
        <Icon name="quote" size={12} />
        <span className="material-quote-idx">{props.index}</span>
      </span>
      {props.onJump === undefined ? (
        <span className="material-quote-text" title={props.item.quote.text}>
          {preview}
        </span>
      ) : (
        <button type="button" className="material-quote-text material-quote-jump" title={t.quote.jump} onClick={props.onJump}>
          {preview}
        </button>
      )}
      <span className="material-quote-note row-trailing" title={props.item.quote.text}>
        {note.lead !== null && <span>{note.lead}</span>}
        {note.who !== null && <span className="material-quote-note-who">{(note.lead !== null ? " · " : "") + note.who}</span>}
        <span>{(note.lead !== null || note.who !== null ? " · " : "") + note.size}</span>
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
