import { useEffect, useRef, useState } from "react";
import type { Deck, Slide, SlideElement } from "../../../../shared/slides.ts";
import { updateElements } from "../../../../shared/slides-ops.ts";
import { SLIDE_BACKGROUNDS, SLIDE_PAGE_WHITE, SLIDE_PALETTE, SLIDE_PICKER_FALLBACK } from "../../../../shared/slides-palette.ts";
import { Icon, type IconName } from "../../shell/Icon";
import { IconButton } from "../../shell/IconButton";
import { useT } from "../../locale.ts";

/** 色块 + 弹出色板（常用色 + 系统取色器）。色是文稿里的内容数据，不是界面色 */
function ColorButton(props: { label: string; value: string; palette?: readonly string[]; allowNone?: boolean; onPick: (color: string) => void }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hostRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return undefined;
    const close = (event: PointerEvent): void => {
      if (!hostRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [open]);
  const palette = props.palette ?? SLIDE_PALETTE;
  return (
    <span ref={hostRef} className="se-color">
      <button type="button" className="se-color-btn" aria-label={props.label} title={props.label} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="se-swatch" data-none={props.value === "none" ? "true" : undefined} style={props.value === "none" ? undefined : { background: props.value }} />
      </button>
      {open && (
        <div className="se-color-pop" role="dialog" aria-label={props.label}>
          <div className="se-swatches">
            {palette.map((color) => (
              <button
                key={color}
                type="button"
                className="se-swatch-btn"
                aria-label={color}
                data-active={props.value.toLowerCase() === color ? "true" : undefined}
                onClick={() => {
                  props.onPick(color);
                  setOpen(false);
                }}
              >
                <span className="se-swatch" style={{ background: color }} />
              </button>
            ))}
          </div>
          <div className="se-color-row">
            <label className="se-color-custom">
              <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(props.value) ? props.value : SLIDE_PICKER_FALLBACK}
                onChange={(event) => props.onPick(event.target.value)}
              />
              {t.slides.customColor}
            </label>
            {props.allowNone === true && (
              <button
                type="button"
                className="dp-text-action"
                onClick={() => {
                  props.onPick("none");
                  setOpen(false);
                }}
              >
                {t.slides.noColor}
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

function Rule() {
  return <span className="dp-bar-rule" aria-hidden="true" />;
}

/**
 * 选中元素的格式条：文字（字号 / 粗斜下 / 颜色 / 对齐）、形状（填充 / 描边）、线（颜色 / 粗细 / 箭头 / 虚线）、
 * 图片（填充方式）、表格（表头）+ 通用（前后移、复制、删除、引用）。没选中时是页背景色。
 * 点这条上的按钮不夺走画布焦点（mousedown 默认被拦）——编辑文字时选中的字还在，B / I / U / 颜色作用在选区上。
 */
export function FormatBar(props: {
  deck: Deck;
  slide: Slide;
  selection: ReadonlySet<string>;
  editing: boolean;
  commit: (next: Deck, coalesceKey?: string) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onQuote: () => void;
}) {
  const t = useT();
  const { deck, slide, selection } = props;
  const selected = slide.elements.filter((element) => selection.has(element.id));
  const first = selected[0];
  const same = selected.length > 0 && selected.every((element) => element.kind === first?.kind);
  const patch = (changes: Record<string, unknown>, key?: string): void =>
    props.commit(updateElements(deck, slide.id, (element) => ({ ...element, ...changes }) as SlideElement, selection), key);

  const run = (command: string, value?: string): void => {
    document.execCommand("styleWithCSS", false, "true");
    document.execCommand(command, false, value);
  };

  const keepFocus = (event: React.MouseEvent): void => {
    // 输入框 / 取色器要自己拿焦点；其余按钮不抢画布焦点
    const target = event.target as HTMLElement;
    if (target.tagName !== "INPUT" && target.tagName !== "SELECT") event.preventDefault();
  };

  const btn = (label: string, icon: IconName, onClick: () => void, active?: boolean) => (
    <IconButton key={label} label={label} size={28} onClick={onClick} {...(active === undefined ? {} : { active })}>
      <Icon name={icon} size={16} strokeWidth={1.8} />
    </IconButton>
  );

  let body: React.ReactNode = null;
  if (selected.length === 0) {
    body = (
      <>
        <span className="se-format-label">{t.slides.background}</span>
        <ColorButton
          label={t.slides.background}
          value={slide.background ?? deck.theme?.background ?? SLIDE_PAGE_WHITE}
          palette={SLIDE_BACKGROUNDS}
          onPick={(color) => props.commit({ ...deck, slides: deck.slides.map((s) => (s.id === slide.id ? { ...s, background: color } : s)) })}
        />
      </>
    );
  } else if (same && first !== undefined) {
    switch (first.kind) {
      case "text":
        body = (
          <>
            <span className="se-stepper">
              {btn(t.slides.fontSmaller, "minus", () => patch({ fontSize: Math.max(8, Math.round(first.fontSize - (first.fontSize > 40 ? 4 : 2))) }, "size"))}
              <input
                className="se-num"
                type="number"
                min={8}
                max={400}
                aria-label={t.slides.fontSize}
                value={Math.round(first.fontSize)}
                onChange={(event) => {
                  const n = Number(event.target.value);
                  if (Number.isFinite(n) && n >= 6) patch({ fontSize: Math.min(400, n) }, "size");
                }}
              />
              {btn(t.slides.fontLarger, "plus", () => patch({ fontSize: Math.min(400, Math.round(first.fontSize + (first.fontSize >= 40 ? 4 : 2))) }, "size"))}
            </span>
            <Rule />
            {btn(t.slides.bold, "bold", () => run("bold"))}
            {btn(t.slides.italic, "italic", () => run("italic"))}
            {btn(t.slides.underline, "underline", () => run("underline"))}
            <ColorButton
              label={t.slides.textColor}
              value={first.color}
              onPick={(color) => (props.editing ? run("foreColor", color) : patch({ color }))}
            />
            <Rule />
            {btn(t.slides.alignLeft, "align-left", () => patch({ align: "left" }), first.align === "left")}
            {btn(t.slides.alignCenter, "align-center", () => patch({ align: "center" }), first.align === "center")}
            {btn(t.slides.alignRight, "align-right", () => patch({ align: "right" }), first.align === "right")}
            {btn(t.slides.list, "list", () => run("insertUnorderedList"))}
          </>
        );
        break;
      case "shape":
        body = (
          <>
            <span className="se-format-label">{t.slides.fill}</span>
            <ColorButton label={t.slides.fill} value={first.fill} allowNone onPick={(fill) => patch({ fill })} />
            <span className="se-format-label">{t.slides.stroke}</span>
            <ColorButton label={t.slides.stroke} value={first.stroke} allowNone onPick={(stroke) => patch({ stroke, ...(first.strokeWidth === 0 ? { strokeWidth: 2 } : {}) })} />
            <input
              className="se-num"
              type="number"
              min={0}
              max={40}
              aria-label={t.slides.strokeWidth}
              value={first.strokeWidth}
              onChange={(event) => {
                const n = Number(event.target.value);
                if (Number.isFinite(n) && n >= 0) patch({ strokeWidth: Math.min(40, n) }, "stroke");
              }}
            />
            <Rule />
            <span className="se-format-label">{t.slides.textColor}</span>
            <ColorButton label={t.slides.textColor} value={first.color} onPick={(color) => patch({ color })} />
          </>
        );
        break;
      case "line":
        body = (
          <>
            <ColorButton label={t.slides.stroke} value={first.stroke} onPick={(stroke) => patch({ stroke })} />
            <input
              className="se-num"
              type="number"
              min={1}
              max={40}
              aria-label={t.slides.strokeWidth}
              value={first.strokeWidth}
              onChange={(event) => {
                const n = Number(event.target.value);
                if (Number.isFinite(n) && n >= 0.5) patch({ strokeWidth: Math.min(40, n) }, "stroke");
              }}
            />
            <Rule />
            {btn(t.slides.arrowStart, "arrow-left", () => patch({ startArrow: first.startArrow === "arrow" ? "none" : "arrow" }), first.startArrow === "arrow")}
            {btn(t.slides.arrowEnd, "arrow-right", () => patch({ endArrow: first.endArrow === "arrow" ? "none" : "arrow" }), first.endArrow === "arrow")}
            {btn(t.slides.dashed, "minus", () => patch({ dash: !first.dash }), first.dash)}
          </>
        );
        break;
      case "image":
        body = (
          <>
            {btn(t.slides.fitContain, "minimize-2", () => patch({ fit: "contain" }), first.fit === "contain")}
            {btn(t.slides.fitCover, "maximize", () => patch({ fit: "cover" }), first.fit === "cover")}
          </>
        );
        break;
      case "table":
        body = (
          <>
            {btn(t.slides.tableHeader, "table", () => patch({ header: !first.header }), first.header)}
            <span className="se-stepper">
              {btn(t.slides.fontSmaller, "minus", () => patch({ fontSize: Math.max(8, first.fontSize - 2) }, "size"))}
              <span className="se-num-static">{Math.round(first.fontSize)}</span>
              {btn(t.slides.fontLarger, "plus", () => patch({ fontSize: Math.min(200, first.fontSize + 2) }, "size"))}
            </span>
            <span className="se-hint">{t.slides.tableHint}</span>
          </>
        );
        break;
    }
  } else {
    body = <span className="se-hint">{t.slides.selectedCount(selected.length)}</span>;
  }

  const reorder = (toFront: boolean): void => {
    props.commit({
      ...deck,
      slides: deck.slides.map((s) => {
        if (s.id !== slide.id) return s;
        const picked = s.elements.filter((element) => selection.has(element.id));
        const rest = s.elements.filter((element) => !selection.has(element.id));
        return { ...s, elements: toFront ? [...rest, ...picked] : [...picked, ...rest] };
      }),
    });
  };

  return (
    <div className="se-format" role="toolbar" aria-label={t.slides.formatBar} onMouseDown={keepFocus}>
      {body}
      <span className="dp-bar-grow" />
      {selected.length > 0 && (
        <>
          {btn(t.slides.bringFront, "arrow-up", () => reorder(true))}
          {btn(t.slides.sendBack, "arrow-down", () => reorder(false))}
          {btn(t.slides.duplicate, "copy", props.onDuplicate)}
          {btn(t.slides.delete, "trash-2", props.onDelete)}
        </>
      )}
      <button type="button" className="dp-text-action" onClick={props.onQuote}>
        <Icon name="quote" size={14} strokeWidth={1.8} />
        {selected.length > 0 ? t.slides.quoteElement : t.slides.quotePage}
      </button>
    </div>
  );
}
